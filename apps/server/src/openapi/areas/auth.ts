import { errors, authedErrors, oneOf } from '../schemas.js';

/** Route schemas for routes/auth.ts (tag "Sign-in"). */

const TAGS = ['Sign-in'];

const userResponse = (description: string) => ({
  description,
  type: 'object',
  required: ['user'],
  properties: { user: { $ref: 'User#' } },
});

export const loginSchema = {
  tags: TAGS,
  summary: 'Sign in',
  description:
    'Checks a username (or email) and password and starts a sign-in. Without `session`, the response has a `token` to send as `Authorization: Bearer <token>`. ' +
    'With `session: "cookie"` (the web app), the token goes into an HttpOnly cookie instead and is left out of the response; that also needs the `X-Tessick-Client: web` header. ' +
    'A sign-in lasts while it is used: 8 hours without a request, 7 days at most. 20 wrong passwords lock the account for 15 minutes.',
  security: [],
  body: {
    type: 'object',
    required: ['password'],
    properties: {
      username: { type: 'string', description: 'Username or email (either field works)' },
      email: { type: 'string' },
      password: { type: 'string' },
      session: oneOf(['cookie'], 'Use a session cookie instead of returning the token.'),
    },
  },
  response: {
    200: {
      description: 'Signed in',
      type: 'object',
      required: ['user'],
      properties: {
        token: { type: 'string', description: 'A JWT; left out with `session: "cookie"`' },
        expires_at: { type: 'string', format: 'date-time', description: 'When this sign-in ends at the latest (7 days)' },
        idle_timeout_seconds: { type: 'integer', description: 'It ends sooner if no request uses it for this long (8 hours); each request extends it' },
        user: { $ref: 'User#' },
      },
    },
    ...errors(400, [401, 'Wrong username or password, or the account is disabled'], [403, 'Cookie sign-in without the X-Tessick-Client header (`CSRF_HEADER_MISSING`)'], [429, 'Account locked (`ACCOUNT_LOCKED`) or too many failures from this address (`TOO_MANY_ATTEMPTS`)']),
  },
};

export const logoutSchema = {
  tags: TAGS,
  summary: 'Sign out',
  description: "Ends the caller's sign-in, so its token and cookie stop working. Always answers 200, even when already signed out.",
  security: [],
  response: {
    200: { description: 'Signed out', type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
  },
};

const TESTLINK_KEY_TEXT =
  "Your TestLink API key works only on Tessick's TestLink-compatible API (`/lib/api/rest/{v1,v2,custom}/...`, docs/testlink_compat_api.md), sent as the `APIKEY` header (or the HTTP Basic user name) as TestLink takes it, with your own permissions in each project. Not available to API tokens.";

export const getTestLinkKeySchema = {
  tags: TAGS,
  summary: 'Your TestLink API key',
  operationId: 'getMyTestLinkKey',
  description: `Whether you have one, and when it was made and last used. ${TESTLINK_KEY_TEXT}`,
  response: {
    200: { description: 'Yours, or null', type: 'object', required: ['testlink_key'], properties: { testlink_key: { anyOf: [{ $ref: 'TestLinkKey#' }, { type: 'null' }] } } },
    ...authedErrors(),
  },
};

export const createTestLinkKeySchema = {
  tags: TAGS,
  summary: 'Make your TestLink API key',
  operationId: 'createMyTestLinkKey',
  description: `A new key, shown once in \`plaintext\`; it replaces the one you had. ${TESTLINK_KEY_TEXT}`,
  response: {
    201: {
      description: 'Made',
      type: 'object',
      required: ['testlink_key', 'plaintext'],
      properties: { testlink_key: { $ref: 'TestLinkKey#' }, plaintext: { type: 'string', description: 'The key (32 hex characters, like TestLink\'s); never shown again' } },
    },
    ...authedErrors(),
  },
};

export const deleteTestLinkKeySchema = {
  tags: TAGS,
  summary: 'Remove your TestLink API key',
  operationId: 'deleteMyTestLinkKey',
  description: `It stops working at once. ${TESTLINK_KEY_TEXT}`,
  response: { 204: { description: 'Removed (or there was none)', type: 'null' }, ...authedErrors() },
};

export const getMeSchema = {
  tags: TAGS,
  summary: 'Who am I',
  operationId: 'getMe',
  description: 'The signed-in user with their global permissions, or the API token in use (with `api_token`).',
  response: {
    200: userResponse('The caller'),
    ...errors(401, [403, 'Only `PASSWORD_CHANGE_REQUIRED` users reach this route; others never get 403 here']),
  },
};

export const patchMeSchema = {
  tags: TAGS,
  summary: 'Change your username, email or password',
  operationId: 'updateMe',
  description:
    'Changes only the fields sent. A new password needs `current_password`, and ends every other sign-in of the account. Changing the username needs `USER_MANAGE` (or Admin). ' +
    'A user who must change their password (`must_change_password`) can only set a new, different one here. Not available to API tokens (`TOKEN_NOT_ALLOWED`).',
  body: {
    type: 'object',
    properties: {
      username: { type: 'string', maxLength: 100 },
      email: { type: 'string', maxLength: 255 },
      password: { type: 'string', description: 'The new password: 8-100 characters; under 16 characters it needs a digit, an uppercase letter and a symbol' },
      current_password: { type: 'string', description: 'Required with `password`' },
    },
  },
  response: {
    200: userResponse('Changed'),
    ...authedErrors(400),
  },
};

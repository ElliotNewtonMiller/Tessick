/**
 * The versions of Dave's TestLink REST API, served side by side as in TestLink: custom is a
 * superset of v2, which is a superset of v1. Each route lists the versions that have it (the
 * spec's x-versions).
 */
export const TESTLINK_VERSIONS = ['v1', 'v2', 'custom'] as const;
export type TestLinkVersion = (typeof TESTLINK_VERSIONS)[number];

export const ALL: TestLinkVersion[] = ['v1', 'v2', 'custom'];
export const V2_UP: TestLinkVersion[] = ['v2', 'custom'];
export const CUSTOM: TestLinkVersion[] = ['custom'];

/** Where each version lives, as on a TestLink server (only the host changes). */
export const versionPrefix = (version: TestLinkVersion) => `/lib/api/rest/${version}`;

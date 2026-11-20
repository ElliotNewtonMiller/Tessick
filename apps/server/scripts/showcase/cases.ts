/**
 * The "Storefront" showcase project: an online shop's regression suite, with realistic steps and
 * a history that gives the reports something to say. Loaded by load-showcase.ts. The CI clip's
 * junit-rc9.xml names its tests by these suites and titles, so change it with them.
 */

export type Verdict = 'P' | 'F' | 'B' | 'R' | '-'; // pass, fail, blocked, fail-then-pass (retry), not run

export interface ShowcaseCase {
  /** Suite path, parents first: "Cart & Checkout / Payment". */
  suite: string;
  title: string;
  /** Run by CI. Otherwise manual, recorded by a person. */
  auto?: boolean;
  priority?: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  preconditions?: string;
  steps: Array<[action: string, expected: string]>;
  /** The Platforms custom field; default Web. */
  platforms?: string[];
  /** One verdict per run, oldest first. Default: always passed, and manual cases not yet run in the last (open) run. */
  history?: string;
  /** Failure message (automated) or notes (manual) for its failed results. */
  message?: string;
  /** Typical duration (automated). */
  ms?: number;
  /** Gets slower run by run, for Test Health's slow tests. */
  slowing?: boolean;
}

export const RUNS = 8;
export const runName = (n: number) => `2.4.0-rc.${n}`;

export const CASES: ShowcaseCase[] = [
  // ---- Accounts ----
  {
    suite: 'Accounts / Sign-in', title: 'Sign in with email and password', auto: true, priority: 'HIGH', ms: 1400,
    summary: 'A registered customer signs in from the header and lands back on the page they were on.',
    preconditions: 'A customer account exists: anna@example.test / Correct-Horse-9.',
    steps: [
      ['Open any product page and click "Sign in" in the header.', 'The sign-in dialog opens with the email field focused.'],
      ['Enter anna@example.test and the correct password, then click "Sign in".', 'The dialog closes and the header shows "Hi, Anna".'],
      ['Check the page behind the dialog.', 'The same product page is still shown; the cart badge shows Anna\'s saved items.'],
    ],
  },
  {
    suite: 'Accounts / Sign-in', title: 'Wrong password shows an error', auto: true, priority: 'MEDIUM', ms: 900,
    summary: 'A wrong password is refused without revealing whether the email exists.',
    steps: [
      ['Open the sign-in dialog and enter anna@example.test with the password "wrong-password".', 'The fields keep their values.'],
      ['Click "Sign in".', '"Email or password is incorrect" appears under the form; the password field is cleared.'],
      ['Repeat with an email that has no account.', 'Exactly the same message appears.'],
    ],
  },
  {
    suite: 'Accounts / Sign-in', title: 'Account locks after 5 failed attempts', auto: true, priority: 'HIGH', ms: 5200,
    summary: 'Five wrong passwords in a row lock the account for 15 minutes and send the customer an email.',
    preconditions: 'A customer account with no recent failed sign-ins.',
    steps: [
      ['Try to sign in with a wrong password five times.', 'Each attempt shows "Email or password is incorrect".'],
      ['Try a sixth time with the correct password.', '"This account is locked for 15 minutes" appears and the customer stays signed out.'],
      ['Open the customer\'s mailbox.', 'An email "Your account was locked" arrived, with a link to reset the password.'],
    ],
  },
  {
    suite: 'Accounts / Sign-in', title: 'Remember me keeps the session for 30 days', priority: 'LOW',
    summary: 'With "Remember me" ticked, closing the browser doesn\'t sign the customer out.',
    steps: [
      ['Sign in with "Remember me" ticked.', 'The customer is signed in.'],
      ['Close every browser window, then open the shop again.', 'The customer is still signed in.'],
      ['Sign in again without "Remember me", close the browser and reopen the shop.', 'The customer is signed out.'],
    ],
  },
  {
    suite: 'Accounts / Sign-in', title: 'Sign in with Google', auto: true, priority: 'MEDIUM', ms: 2600,
    summary: 'A customer signs in with their Google account and is matched to their existing account by email.',
    steps: [
      ['Click "Continue with Google" in the sign-in dialog.', 'Google\'s account chooser opens.'],
      ['Choose the test Google account anna@example.test.', 'The shop opens again with the header showing "Hi, Anna".'],
      ['Open Account → Orders.', 'Anna\'s existing orders are listed: no second account was made.'],
    ],
  },
  {
    suite: 'Accounts / Password reset', title: 'Request a password reset email', auto: true, priority: 'HIGH', ms: 3100,
    summary: 'A customer who forgot their password gets a reset link by email.',
    steps: [
      ['Click "Forgot password?" in the sign-in dialog and enter anna@example.test.', '"If an account exists, we\'ve sent a link" appears.'],
      ['Open the mailbox.', 'A reset email arrived within 30 seconds, with a "Choose a new password" button.'],
      ['Click the button and set a new password.', 'The customer is signed in, and the old password no longer works.'],
    ],
  },
  {
    suite: 'Accounts / Password reset', title: 'Reset link expires after one hour', auto: true, priority: 'MEDIUM', ms: 1800,
    summary: 'An old reset link is refused, so a leaked email can\'t be used later.',
    preconditions: 'A reset link requested more than an hour ago (the test clock is moved forward).',
    steps: [
      ['Open the expired reset link.', '"This link has expired" appears, with a button to request a new one.'],
      ['Click "Send a new link".', 'A new email arrives; its link works.'],
    ],
  },
  {
    suite: 'Accounts / Password reset', title: 'New password must meet the policy', priority: 'MEDIUM',
    summary: 'The new-password form explains the rules as the customer types.',
    steps: [
      ['Open a reset link and type "abc" as the new password.', 'The checklist shows "At least 10 characters" unmet, and "Save" is disabled.'],
      ['Type "Correct-Horse-9".', 'Every rule is ticked and "Save" is enabled.'],
      ['Type the customer\'s current password.', '"Choose a password you haven\'t used before" appears.'],
    ],
  },
  {
    suite: 'Accounts / Profile', title: 'Change email address', priority: 'MEDIUM', platforms: ['Web', 'iOS', 'Android'],
    summary: 'Changing the email needs the password and a confirmation from the new address.',
    steps: [
      ['Open Account → Profile and click "Change" next to the email.', 'A form asks for the new email and the current password.'],
      ['Enter anna.new@example.test and the password, then click "Save".', '"Check anna.new@example.test to confirm" appears; the old email is still shown.'],
      ['Click the link in the confirmation email.', 'The profile shows the new email, and the old address gets a notice of the change.'],
    ],
  },
  {
    suite: 'Accounts / Profile', title: 'Delete account', priority: 'HIGH', platforms: ['Web', 'iOS', 'Android'],
    summary: 'A customer can delete their account; open orders must be finished first.',
    preconditions: 'A customer with no open orders.',
    steps: [
      ['Open Account → Profile → "Delete my account".', 'A warning lists what will be removed and asks to type DELETE.'],
      ['Type DELETE and confirm.', 'The customer is signed out and sees "Your account has been deleted".'],
      ['Try to sign in with the old email and password.', '"Email or password is incorrect" appears.'],
    ],
  },

  // ---- Catalog ----
  {
    suite: 'Catalog / Search', title: 'Search by product name', auto: true, priority: 'HIGH', ms: 900, slowing: true,
    summary: 'Searching for a product name lists it first, with suggestions as you type.',
    steps: [
      ['Type "trail runner" into the search box.', 'Suggestions appear after the third letter, including "Trail Runner 2".'],
      ['Press Enter.', 'Results load in under a second, with "Trail Runner 2" first.'],
      ['Check the result count above the list.', 'It matches the number of products shown across the pages.'],
    ],
  },
  {
    suite: 'Catalog / Search', title: 'No results suggests alternatives', priority: 'LOW',
    summary: 'A search with no matches offers the customer somewhere to go.',
    steps: [
      ['Search for "xyzzy".', '"No products match xyzzy" appears.'],
      ['Check under the message.', 'Popular categories and a link to clear the search are shown.'],
    ],
  },
  {
    suite: 'Catalog / Search', title: 'Search tolerates typos', auto: true, priority: 'MEDIUM', ms: 1100,
    summary: 'A misspelled search still finds the product.',
    steps: [
      ['Search for "trial runer".', 'Results include "Trail Runner 2", with "Showing results for trail runner".'],
      ['Click "Search for trial runer instead".', 'Only exact matches are shown (none).'],
    ],
  },
  {
    suite: 'Catalog / Search', title: 'Search results paginate', auto: true, priority: 'LOW', ms: 1300,
    summary: 'Long result lists are split into pages of 24.',
    steps: [
      ['Search for "shirt" (more than 24 results).', 'The first 24 products and a pager are shown.'],
      ['Click page 2.', 'The next products load, and the address includes page=2.'],
      ['Reload the page.', 'Page 2 is still shown.'],
    ],
  },
  {
    suite: 'Catalog / Filters', title: 'Filter by price range', auto: true, priority: 'MEDIUM', ms: 800,
    summary: 'The price slider narrows the results.',
    steps: [
      ['Open Shoes and drag the price slider to $50–$100.', 'Only products priced $50 to $100 are listed.'],
      ['Check the active filters above the list.', 'A "$50–$100" chip is shown; clicking its × removes the filter.'],
    ],
  },
  {
    suite: 'Catalog / Filters', title: 'Filter by brand and size together', auto: true, priority: 'MEDIUM', ms: 950, history: 'PPPPPPBP', message: 'Search index unavailable (503 from /api/search)',
    summary: 'Filters combine: brand and size both apply.',
    steps: [
      ['Open Shoes, tick the brand "Northpeak" and the size "42".', 'Only Northpeak shoes available in size 42 are listed.'],
      ['Untick "42".', 'All Northpeak shoes are listed again.'],
    ],
  },
  {
    suite: 'Catalog / Filters', title: 'Clear all filters', priority: 'LOW',
    summary: '"Clear all" removes every filter in one click.',
    steps: [
      ['Apply a price range, a brand and a size.', 'Three chips are shown above the results.'],
      ['Click "Clear all".', 'The chips disappear and the full category is listed again.'],
    ],
  },
  {
    suite: 'Catalog / Product page', title: 'Gallery images zoom', priority: 'LOW', platforms: ['Web', 'iOS', 'Android'],
    summary: 'Product photos open full screen and can be zoomed.',
    steps: [
      ['Open "Trail Runner 2" and click its main photo.', 'The gallery opens full screen.'],
      ['Pinch or scroll to zoom, then swipe to the next photo.', 'The photo zooms smoothly; the next one opens unzoomed.'],
      ['Press Escape (or tap ×).', 'The gallery closes on the product page.'],
    ],
  },
  {
    suite: 'Catalog / Product page', title: 'Size guide opens', priority: 'LOW',
    summary: 'The size guide shows the product\'s own measurements.',
    steps: [
      ['On a shoe\'s page, click "Size guide".', 'A panel opens with EU, US and UK sizes and foot length.'],
    ],
  },
  {
    suite: 'Catalog / Product page', title: 'Out-of-stock size can\'t be added', auto: true, priority: 'HIGH', ms: 700,
    summary: 'A sold-out size is shown but can\'t be bought.',
    preconditions: '"Trail Runner 2" in size 44 has no stock.',
    steps: [
      ['Open "Trail Runner 2" and choose size 44.', 'The size is struck through and "Add to cart" becomes "Notify me".'],
      ['Click "Notify me" and enter an email.', '"We\'ll email you when it\'s back" appears.'],
    ],
  },

  // ---- Cart & Checkout ----
  {
    suite: 'Cart & Checkout / Cart', title: 'Add an item to the cart', auto: true, priority: 'HIGH', ms: 750,
    summary: 'Adding an item updates the cart badge and opens the mini-cart.',
    steps: [
      ['Open "Trail Runner 2", choose size 42 and click "Add to cart".', 'The mini-cart opens with the shoe, size 42, $89.00.'],
      ['Check the cart badge in the header.', 'It shows 1.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Cart', title: 'Change quantity in the cart', auto: true, priority: 'MEDIUM', ms: 820,
    summary: 'Quantities can be changed, and the totals follow.',
    steps: [
      ['Open the cart with one item at $89.00 and set its quantity to 3.', 'The line total shows $267.00 and the subtotal updates.'],
      ['Set the quantity to 0.', 'The item is removed, with an "Undo" link.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Cart', title: 'Cart is kept after signing out and in', auto: true, priority: 'MEDIUM', ms: 2100, history: 'PPPPPPPF', message: 'Expected 2 items in the cart after signing in again, found 0',
    summary: 'A signed-in customer\'s cart is saved to their account.',
    steps: [
      ['Signed in, add two items to the cart.', 'The badge shows 2.'],
      ['Sign out, then sign in again.', 'The badge shows 2, and the cart has the same items.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Payment', title: 'Pay with a new card', auto: true, priority: 'HIGH', ms: 4200,
    summary: 'A first-time buyer pays by card and gets an order number.',
    preconditions: 'Payment provider in test mode; card 4242 4242 4242 4242.',
    steps: [
      ['Check out a cart of $89.00 and choose "Card".', 'The card form is shown inside the checkout.'],
      ['Enter 4242 4242 4242 4242, any future date and CVC 123, then click "Pay $89.00".', 'The button shows a spinner, then the confirmation page opens.'],
      ['Check the confirmation page.', 'It shows an order number and "We\'ve emailed your receipt".'],
    ],
  },
  {
    suite: 'Cart & Checkout / Payment', title: 'Pay with a saved card', auto: true, priority: 'HIGH', ms: 3600, history: 'PFPPFPRP', message: 'Payment provider timed out after 10s',
    summary: 'A returning customer pays with the card saved on their account.',
    preconditions: 'Anna has a saved Visa ending 4242.',
    steps: [
      ['Signed in as Anna, check out and choose "Visa •••• 4242".', 'Only the CVC is asked for.'],
      ['Enter CVC 123 and click "Pay".', 'The confirmation page opens with an order number.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Payment', title: '3-D Secure challenge', priority: 'HIGH', platforms: ['Web', 'iOS', 'Android'], history: 'PPPPFPP-', message: 'The challenge window didn\'t close after approving on iOS Safari; the order was placed but the page kept spinning.',
    summary: 'A card that needs 3-D Secure shows the bank\'s challenge, and the order completes after it.',
    preconditions: 'Test card 4000 0027 6000 3184 (always challenged).',
    steps: [
      ['Pay with the 3-D Secure test card.', 'The bank\'s challenge opens over the checkout.'],
      ['Click "Complete authentication".', 'The challenge closes and the confirmation page opens.'],
      ['Repeat and click "Fail authentication".', '"Your bank declined the payment" appears, and the cart is unchanged.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Payment', title: 'Declined card shows a clear message', auto: true, priority: 'MEDIUM', ms: 2900, history: 'PPPFPPPP', message: 'Expected "Your card was declined", got "Something went wrong"',
    summary: 'A declined card explains what happened and keeps the cart.',
    steps: [
      ['Pay with the decline test card 4000 0000 0000 0002.', '"Your card was declined. Try another card." appears under the form.'],
      ['Check the cart badge.', 'The items are still in the cart.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Shipping', title: 'Free shipping over $50', auto: true, priority: 'MEDIUM', ms: 1200,
    summary: 'Orders of $50 or more ship free.',
    steps: [
      ['Check out a cart of $45.00.', 'Standard shipping costs $4.95, with "Add $5.00 for free shipping".'],
      ['Add a $10.00 item and return to checkout.', 'Standard shipping shows "Free".'],
    ],
  },
  {
    suite: 'Cart & Checkout / Shipping', title: 'Express delivery date shown at checkout', priority: 'LOW',
    summary: 'Express shipping shows the delivery date before paying.',
    steps: [
      ['At checkout, choose "Express" before 2 p.m. on a weekday.', '"Arrives tomorrow" is shown with the date.'],
      ['Repeat after 2 p.m. on a Friday.', 'The date shown is Monday.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Discounts', title: 'Apply a discount code', auto: true, priority: 'HIGH', ms: 1000, history: 'PPPPPPFF', message: 'Expected order total $45.00 after SAVE10, got $50.00',
    summary: 'A valid code takes its discount off the order.',
    preconditions: 'The code SAVE10 gives 10% off.',
    steps: [
      ['Check out a cart of $50.00 and enter SAVE10.', '"SAVE10: −$5.00" appears in the summary.'],
      ['Check the total.', 'The total is $45.00 plus shipping.'],
    ],
  },
  {
    suite: 'Cart & Checkout / Discounts', title: 'Expired code is refused', auto: true, priority: 'MEDIUM', ms: 850,
    summary: 'An expired code is refused with its expiry date.',
    steps: [
      ['Enter the expired code SUMMER23 at checkout.', '"SUMMER23 expired on 31 August 2023" appears, and the total is unchanged.'],
    ],
  },

  // ---- Orders ----
  {
    suite: 'Orders', title: 'Order confirmation email', auto: true, priority: 'HIGH', ms: 6500, history: 'PPPPRPPP', message: 'No email received within 30s',
    summary: 'Every order sends a receipt with its items and delivery address.',
    steps: [
      ['Place an order.', 'The confirmation page shows the order number.'],
      ['Open the customer\'s mailbox.', 'A receipt with the same order number, items, total and address arrived.'],
    ],
  },
  {
    suite: 'Orders', title: 'Cancel an order before it ships', priority: 'MEDIUM', platforms: ['Web', 'iOS', 'Android'],
    summary: 'An order can be cancelled until it is packed, and the payment is refunded.',
    steps: [
      ['Open Account → Orders and the newest order.', 'Its status is "Processing", with a "Cancel order" button.'],
      ['Click "Cancel order" and confirm.', 'The status becomes "Cancelled" and the refund amount is shown.'],
      ['Open the mailbox.', 'A cancellation email with the refund amount arrived.'],
    ],
  },
  {
    suite: 'Orders', title: 'Return an item', priority: 'MEDIUM',
    summary: 'A delivered item can be returned within 30 days with a printable label.',
    preconditions: 'An order delivered less than 30 days ago.',
    steps: [
      ['Open the delivered order and click "Return items".', 'Each item can be ticked, with a reason.'],
      ['Tick one item, choose "Too small" and submit.', 'A return label opens as a PDF, and the order shows "Return started".'],
    ],
  },
];

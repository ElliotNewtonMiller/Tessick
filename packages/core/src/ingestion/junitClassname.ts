/**
 * The suites a JUnit <testcase classname> stands for, shared by the JUnit import (JUnitXmlParser)
 * and by matching uploaded results to the cases it created (junitSuiteName).
 *
 * Two styles exist:
 * - Java-style dotted names: com.acme.LoginTest → com / acme / LoginTest.
 * - File paths (Playwright, Vitest, some Jest and pytest setups), with / or \:
 *   tests/checkout/payment.spec.ts → tests / checkout / payment. Folders are suites and the file,
 *   without its source extension and test markers (.spec, .test, .cy, ...), is the innermost one.
 */

/** Source-file extensions dropped from a path classname's file name. */
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'java', 'kt', 'kts',
  'cs', 'php', 'rs', 'swift', 'scala', 'groovy', 'ex', 'exs', 'feature',
]);
/** Test markers dropped after the extension: payment.e2e.spec.ts → payment. */
const TEST_MARKERS = new Set(['spec', 'test', 'tests', 'e2e', 'cy', 'unit', 'int', 'integration']);

/** A classname naming a file or folder path rather than a dotted class. */
export function isPathClassname(classname: string): boolean {
  return /[/\\]/.test(classname);
}

/** A test file's name as a suite: 01_Dashboard.spec.ts → 01_Dashboard. */
function fileSuiteName(file: string): string {
  const parts = file.split('.');
  if (parts.length > 1 && SOURCE_EXTENSIONS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  while (parts.length > 1 && TEST_MARKERS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts.join('.').trim() || file;
}

/**
 * The suite names a classname nests a test under, outermost first ([] for none). A path's
 * `.`/`..` parts and a Windows drive (C:) are left out.
 */
export function junitClassnameSuites(classname: string): string[] {
  if (!isPathClassname(classname)) {
    return classname.split('.').map((s) => s.trim()).filter(Boolean);
  }
  const parts = classname
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s, i) => s && s !== '.' && s !== '..' && !(i === 0 && /^[A-Za-z]:$/.test(s)));
  if (parts.length) parts[parts.length - 1] = fileSuiteName(parts[parts.length - 1]);
  return parts;
}

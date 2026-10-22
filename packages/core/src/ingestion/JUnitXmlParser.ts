import sax from 'sax';
import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
} from './types.js';
import { isPathClassname, junitClassnameSuites } from './junitClassname.js';

/** Finds (or creates) the child ParsedSuite named `segment` directly under `parent`. */
function getOrCreateSubSuite(parent: ParsedSuite, segment: string): ParsedSuite {
  let sub = parent.sub_suites.find((s) => s.name === segment);
  if (!sub) {
    sub = { name: segment, details: '', node_order: parent.sub_suites.length, sub_suites: [], test_cases: [] };
    parent.sub_suites.push(sub);
  }
  return sub;
}

/** Adds `suite` under `target`, merging it into a same-named suite there (and so on down). */
function mergeSuite(target: ParsedSuite, suite: ParsedSuite) {
  const existing = target.sub_suites.find((s) => s.name === suite.name);
  if (!existing) {
    target.sub_suites.push({ ...suite, node_order: target.sub_suites.length });
    return;
  }
  existing.test_cases.push(...suite.test_cases);
  if (!existing.details) existing.details = suite.details;
  for (const sub of suite.sub_suites) mergeSuite(existing, sub);
}

const sameSuites = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

export class JUnitXmlParser implements IFileParser {
  readonly formatId = 'JUNIT_XML';

  canHandle(fileHeader: Buffer, filename: string): boolean {
    const headerStr = fileHeader.toString('utf-8', 0, Math.min(fileHeader.length, 2048));
    // Neither attribute ever appears in TestLink XML -- this is what disambiguates a
    // JUnit report from the (also <testsuite>-based) TestLink format SaxXmlParser handles.
    const hasTestsAttr = /<testsuite[^>]*\stests="/i.test(headerStr);
    const hasClassnameAttr = /<testcase[^>]*\sclassname="/i.test(headerStr);
    return hasTestsAttr || hasClassnameAttr;
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    // lowercase: true -- sax's non-strict mode otherwise uppercases attribute keys by
    // default (its "looseCase" normalization), which would turn e.g. classname="..." into
    // node.attributes.CLASSNAME. SaxXmlParser works around the same quirk by checking
    // multiple casings just for its one "name" attribute; this parser reads several
    // attributes (classname/time/tests/message), so normalizing case up front is simpler.
    const parser = sax.parser(false, { trim: true, lowercase: true });

    const rootSuitesQueue: ParsedSuite[] = [];
    const suiteStack: ParsedSuite[] = [];
    // Folder trees from path classnames (tests/checkout/payment.spec.ts), merged across every
    // <testsuite> of the file -- Playwright and Vitest write one per test file -- and yielded at
    // the end, so files sharing folders give one tree. Root <testsuite>s holding such trees are
    // merged into it too; the rest stream out as they close.
    const folderRoots: ParsedSuite = { name: '', details: '', node_order: 0, sub_suites: [], test_cases: [] };
    const holdsFolders = new WeakSet<ParsedSuite>();
    // <testsuite>s named after their tests' file, which add no level of their own.
    const fileSuites = new WeakSet<ParsedSuite>();

    let currentCase: (Partial<ParsedCase> & { classname?: string }) | null = null;
    let currentOutcomeTag: 'failure' | 'error' | 'skipped' | null = null;
    let textBuffer = '';

    const defaultImportance = (options?.defaultImportance?.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW') || 'MEDIUM';

    parser.onopentag = (node) => {
      const tagName = node.name.toLowerCase();
      textBuffer = '';

      if (tagName === 'testsuite') {
        const name = (node.attributes.name as string) || 'Unnamed Suite';
        suiteStack.push({ name, details: '', node_order: 0, sub_suites: [], test_cases: [] });
      } else if (tagName === 'testcase') {
        const classname = (node.attributes.classname as string) || '';
        const name = (node.attributes.name as string) || 'Unnamed Test';
        const time = node.attributes.time as string | undefined;
        currentCase = {
          classname,
          title: name,
          summary: '',
          preconditions: '',
          importance: defaultImportance,
          execution_type: 'AUTOMATED',
          steps: [
            { step_number: 1, actions: 'Automated test execution', expected_results: 'Test passes', execution_type: 'AUTOMATED' },
          ],
          custom_fields: {
            junit_status: 'PASSED',
            ...(time !== undefined ? { junit_duration_seconds: time } : {}),
          },
        };
      } else if (tagName === 'failure' || tagName === 'error' || tagName === 'skipped') {
        currentOutcomeTag = tagName;
        if (currentCase && currentCase.custom_fields) {
          currentCase.custom_fields.junit_status = tagName === 'failure' ? 'FAILED' : tagName === 'error' ? 'ERROR' : 'SKIPPED';
          const message = node.attributes.message as string | undefined;
          if (message) {
            currentCase.custom_fields.junit_failure_message = message;
          }
        }
      }
    };

    parser.ontext = (text) => {
      textBuffer += text;
    };
    parser.oncdata = (cdata) => {
      textBuffer += cdata;
    };

    parser.onclosetag = (tagName) => {
      const name = tagName.toLowerCase();
      const textVal = textBuffer.trim();

      if (currentOutcomeTag && name === currentOutcomeTag) {
        // A <failure>/<error> body (not just its message="" attribute) is the fallback
        // failure message when no attribute was present.
        if (currentCase?.custom_fields && !currentCase.custom_fields.junit_failure_message && textVal) {
          currentCase.custom_fields.junit_failure_message = textVal;
        }
        currentOutcomeTag = null;
      } else if (currentCase && name === 'testcase') {
        const parentSuite = suiteStack[suiteStack.length - 1];
        if (parentSuite) {
          // Nest by the full dotted classname (e.g. com.acme.LoginTest -> 3 suite levels),
          // consistent with how CsvParser's suite-path hierarchy already works; a path classname
          // nests by its folders and file (junitClassname.ts).
          const classname = currentCase.classname || '';
          const segments = junitClassnameSuites(classname);
          let targetSuite = parentSuite;
          if (isPathClassname(classname)) {
            if (isPathClassname(parentSuite.name) && sameSuites(junitClassnameSuites(parentSuite.name), segments)) {
              fileSuites.add(parentSuite);
              targetSuite = suiteStack[suiteStack.length - 2] ?? folderRoots;
            }
            holdsFolders.add(targetSuite);
          }
          for (const seg of segments) {
            targetSuite = getOrCreateSubSuite(targetSuite, seg);
          }
          const { classname: _classname, ...parsedCase } = currentCase;
          targetSuite.test_cases.push(parsedCase as ParsedCase);
        }
        currentCase = null;
      } else if (suiteStack.length > 0 && name === 'testsuite') {
        const completedSuite = suiteStack.pop()!;
        const emptied = !completedSuite.test_cases.length && !completedSuite.sub_suites.length;
        if (fileSuites.has(completedSuite) && emptied) {
          // Its tests went into the folder tree.
        } else if (suiteStack.length > 0) {
          const parent = suiteStack[suiteStack.length - 1];
          parent.sub_suites.push(completedSuite);
          if (holdsFolders.has(completedSuite)) holdsFolders.add(parent);
        } else if (holdsFolders.has(completedSuite)) {
          mergeSuite(folderRoots, completedSuite);
        } else {
          rootSuitesQueue.push(completedSuite);
        }
      }

      textBuffer = '';
    };

    const processChunk = (chunk: Buffer | string) => {
      parser.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    };

    if (Symbol.asyncIterator in (inputStream as any)) {
      for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
        processChunk(chunk);
        while (rootSuitesQueue.length > 0) yield rootSuitesQueue.shift()!;
      }
    } else if (typeof (inputStream as any).on === 'function') {
      const stream = inputStream as Readable;
      for await (const chunk of stream) {
        processChunk(chunk);
        while (rootSuitesQueue.length > 0) yield rootSuitesQueue.shift()!;
      }
    } else {
      processChunk(inputStream as any);
    }

    parser.close();
    while (rootSuitesQueue.length > 0) yield rootSuitesQueue.shift()!;
    yield* folderRoots.sub_suites;
  }
}

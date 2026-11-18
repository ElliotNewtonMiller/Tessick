import sax from 'sax';
import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
} from './types.js';
import { normalizePriority, type ParsedPriority } from './types.js';
import { versionStatusFromTestLink } from '../testlink/migration.js';

/** sax's table of the HTML entities (missing from its type definitions). */
const HTML_ENTITIES = (sax as unknown as { ENTITIES: Record<string, string | number | undefined> }).ENTITIES;

/**
 * Decodes the HTML entities in TestLink's rich text, in one pass (so `&amp;mdash;` stays the text
 * `&mdash;`): numeric ones (`&#8212;`, `&#x2014;`) and every named HTML entity (sax's table:
 * `&mdash;`, `&rsquo;`, `&eacute;`, ...). A non-breaking space becomes a plain space; an unknown
 * entity is left as it is.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (entity, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code === 0xa0) return ' ';
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
    }
    if (ref === 'nbsp') return ' ';
    const named = HTML_ENTITIES[ref];
    if (named === undefined) return entity;
    return typeof named === 'number' ? String.fromCodePoint(named) : named;
  });
}

/** Marks a table cell's end while tags are removed; each line's cells are joined with " | " afterwards. */
const CELL_END = '\u0001';

/**
 * TestLink's HTML (summaries, steps) as plain text: paragraphs and line breaks kept, lists as
 * "- item" or "1. item" lines, a table row as one line of cells joined by " | ", tags dropped,
 * entities decoded. In HTML the source's own line breaks and indents are only spaces (TestLink's
 * editor writes many), so they're collapsed; text without tags keeps its line breaks.
 */
export function cleanHtmlText(html: string): string {
  if (!html) return '';
  let text = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  if (!/<\/?[a-z][^>]*>/i.test(text)) return decodeHtmlEntities(text).trim();

  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    // A paragraph that is a whole table cell or list item is part of that line.
    .replace(/<\/p\s*>\s*(?=<\/(?:t[dh]|li)\s*>)/gi, '');
  // Numbered lists first, innermost first, so a list inside a list keeps its own numbers.
  const innermostList = /<ol\b[^>]*>((?:(?!<ol\b)[\s\S])*?)<\/ol\s*>/i;
  while (innermostList.test(text)) {
    text = text.replace(innermostList, (_list, items: string) => {
      let n = 0;
      return `\n${items.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `)}\n`;
    });
  }
  text = text
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:li|ul|ol|tr|div|h[1-6]|blockquote|pre)\s*>|<(?:ul|ol|table)\b[^>]*>|<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|table)\s*>/gi, '\n\n')
    .replace(/<\/t[dh]\s*>/gi, CELL_END)
    .replace(/<[^>]+>/g, '');

  const lines = decodeHtmlEntities(text)
    .split('\n')
    .map((line) => {
      if (!line.includes(CELL_END)) return line.trim();
      const cells = line.split(CELL_END).map((cell) => cell.trim());
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      return cells.join(' | ');
    });
  return (
    lines
      .join('\n')
      // At most one blank line, and none between a list's items (TestLink wraps each in a <p>).
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n\n(?=- |\d+\. )/g, '\n')
      .replace(/^(- |\d+\. ) +/gm, '$1')
      .trim()
  );
}

/** TestLink importance: 1-3 (low, medium, high), or a priority name. */
function mapImportance(val?: string, defaultVal: string = 'MEDIUM'): ParsedPriority {
  return normalizePriority(val, defaultVal);
}

function mapExecutionType(val?: string, defaultVal: string = 'MANUAL'): 'MANUAL' | 'AUTOMATED' {
  if (!val) return (defaultVal.toUpperCase() as any) || 'MANUAL';
  const clean = val.trim();
  if (clean === '1') return 'MANUAL';
  if (clean === '2') return 'AUTOMATED';
  const upper = clean.toUpperCase();
  if (upper === 'AUTOMATED') return 'AUTOMATED';
  return 'MANUAL';
}

/** The top-level suite that takes a file's cases outside any suite (see parseStream). */
export const LOOSE_CASES_SUITE_NAME = 'Imported cases';

export class SaxXmlParser implements IFileParser {
  readonly formatId = 'TESTLINK_XML';

  canHandle(fileHeader: Buffer, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.xml')) return true;
    const headerStr = fileHeader.toString('utf-8', 0, Math.min(fileHeader.length, 512)).trim();
    return headerStr.startsWith('<?xml') || headerStr.includes('<testsuite') || headerStr.includes('<testsuites') || headerStr.includes('<testcases');
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const parser = sax.parser(false, { trim: true });

    const rootSuitesQueue: ParsedSuite[] = [];
    // TestLink's export of a whole project wraps its suites in a nameless <testsuite>, the project
    // itself: its suites come out as top-level suites instead. Cases outside any suite (a
    // <testcases> export of single cases) go into one top-level suite, named LOOSE_CASES_SUITE_NAME.
    const projectWrappers = new WeakSet<ParsedSuite>();
    const looseCases: ParsedCase[] = [];
    const keepLooseCase = (tc: ParsedCase) =>
      looseCases.push({ ...tc, parser_warnings: [...(tc.parser_warnings ?? []), 'CASE_OUTSIDE_SUITE'] });

    // Parser State Stack
    const suiteStack: ParsedSuite[] = [];
    let currentCase: Partial<ParsedCase> | null = null;
    let currentStep: Partial<ParsedStep> | null = null;
    let currentCustomField: { name?: string; value?: string } | null = null;
    // The current case's TestLink `<status>` and `<active>`, when the file has them.
    let caseStatus: { status?: number; active?: number } = {};

    let tagStack: string[] = [];
    let textBuffer = '';

    parser.onopentag = (node) => {
      const tagName = node.name.toLowerCase();
      tagStack.push(tagName);
      textBuffer = '';

      const attrName =
        (node.attributes.name || node.attributes.NAME || node.attributes.Name) as string;
      // TestLink's own ids (a suite's `id`, a case's `internalid`), when the file has them.
      const idAttr = (key: string) => {
        // The parser may upper-case attribute names, as with `name` above.
        const found = Object.entries(node.attributes).find(([k]) => k.toLowerCase() === key);
        const raw = String(found?.[1] ?? '').trim();
        return /^\d+$/.test(raw) ? Number(raw) : undefined;
      };

      if (tagName === 'testsuite') {
        const suite: ParsedSuite = {
          name: attrName ? attrName.trim() : 'Unnamed Suite',
          ...(idAttr('id') !== undefined ? { testlink_id: idAttr('id') } : {}),
          details: '',
          node_order: 0,
          sub_suites: [],
          test_cases: [],
        };
        if (suiteStack.length === 0 && !attrName?.trim()) projectWrappers.add(suite);
        suiteStack.push(suite);
      } else if (tagName === 'testcase') {
        caseStatus = {};
        currentCase = {
          title: attrName ? attrName.trim() : 'Unnamed Case',
          ...(idAttr('internalid') !== undefined ? { testlink_id: idAttr('internalid') } : {}),
          summary: '',
          preconditions: '',
          importance: mapImportance(undefined, options?.defaultImportance),
          execution_type: mapExecutionType(undefined, options?.defaultExecutionType),
          steps: [],
          custom_fields: {},
        };
      } else if (tagName === 'step') {
        currentStep = {
          step_number: (currentCase?.steps?.length || 0) + 1,
          actions: '',
          expected_results: '',
          execution_type: 'MANUAL',
        };
      } else if (tagName === 'custom_field') {
        currentCustomField = {};
      } else if (tagName === 'keyword' && currentCase && !currentStep && attrName?.trim()) {
        currentCase.keywords = [...new Set([...(currentCase.keywords ?? []), attrName.trim()])];
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

      if (currentCustomField) {
        if (name === 'name') {
          currentCustomField.name = textVal;
        } else if (name === 'value') {
          currentCustomField.value = textVal;
        } else if (name === 'custom_field') {
          if (currentCustomField.name && currentCase && currentCase.custom_fields) {
            currentCase.custom_fields[currentCustomField.name] = currentCustomField.value || '';
          }
          currentCustomField = null;
        }
      } else if (currentStep) {
        if (name === 'step_number') {
          const num = parseInt(textVal, 10);
          if (!isNaN(num)) currentStep.step_number = num;
        } else if (name === 'actions') {
          currentStep.actions = cleanHtmlText(textBuffer);
        } else if (name === 'expectedresults') {
          currentStep.expected_results = cleanHtmlText(textBuffer);
        } else if (name === 'execution_type') {
          currentStep.execution_type = mapExecutionType(textVal);
        } else if (name === 'step') {
          if (currentCase && currentCase.steps) {
            currentCase.steps.push(currentStep as ParsedStep);
          }
          currentStep = null;
        }
      } else if (currentCase) {
        if (name === 'externalid') {
          currentCase.external_id = textVal;
        } else if (name === 'summary') {
          currentCase.summary = cleanHtmlText(textBuffer);
        } else if (name === 'preconditions') {
          currentCase.preconditions = cleanHtmlText(textBuffer);
        } else if (name === 'importance') {
          currentCase.importance = mapImportance(textVal, options?.defaultImportance);
        } else if (name === 'execution_type') {
          currentCase.execution_type = mapExecutionType(textVal, options?.defaultExecutionType);
        } else if ((name === 'status' || name === 'active') && /^\d+$/.test(textVal)) {
          caseStatus[name] = Number(textVal);
        } else if (name === 'testcase') {
          if (caseStatus.status !== undefined || caseStatus.active !== undefined) {
            // A file with only one of them: TestLink's defaults, draft (1) and active.
            currentCase.status = versionStatusFromTestLink(caseStatus.status ?? 1, caseStatus.active ?? 1);
          }
          if (currentCase.title && currentCase.title.length > 255) {
            currentCase.title = currentCase.title.substring(0, 255);
          }
          const parentSuite = suiteStack[suiteStack.length - 1];
          if (parentSuite) {
            parentSuite.test_cases.push(currentCase as ParsedCase);
          } else {
            keepLooseCase(currentCase as ParsedCase);
          }
          currentCase = null;
        }
      } else if (suiteStack.length > 0) {
        const activeSuite = suiteStack[suiteStack.length - 1];
        if (name === 'details') {
          activeSuite.details = cleanHtmlText(textBuffer);
        } else if (name === 'node_order') {
          const order = parseInt(textVal, 10);
          if (!isNaN(order)) activeSuite.node_order = order;
        } else if (name === 'testsuite') {
          const completedSuite = suiteStack.pop()!;
          if (suiteStack.length > 0) {
            suiteStack[suiteStack.length - 1].sub_suites.push(completedSuite);
          } else if (projectWrappers.has(completedSuite)) {
            rootSuitesQueue.push(...completedSuite.sub_suites);
            completedSuite.test_cases.forEach(keepLooseCase);
          } else {
            rootSuitesQueue.push(completedSuite);
          }
        }
      }

      tagStack.pop();
      textBuffer = '';
    };

    // Helper to stream chunks through sax parser
    const processChunk = (chunk: Buffer | string) => {
      parser.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    };

    // Handle different stream formats (Node.js stream or AsyncIterable)
    if (Symbol.asyncIterator in (inputStream as any)) {
      for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
        processChunk(chunk);
        while (rootSuitesQueue.length > 0) {
          yield rootSuitesQueue.shift()!;
        }
      }
    } else if (typeof (inputStream as any).on === 'function') {
      const stream = inputStream as Readable;
      for await (const chunk of stream) {
        processChunk(chunk);
        while (rootSuitesQueue.length > 0) {
          yield rootSuitesQueue.shift()!;
        }
      }
    } else {
      processChunk(inputStream as any);
    }

    parser.close();
    if (looseCases.length > 0) {
      rootSuitesQueue.push({ name: LOOSE_CASES_SUITE_NAME, details: '', node_order: 0, sub_suites: [], test_cases: looseCases });
    }
    while (rootSuitesQueue.length > 0) {
      yield rootSuitesQueue.shift()!;
    }
  }
}

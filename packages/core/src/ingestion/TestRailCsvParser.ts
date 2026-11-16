import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
  ParsedPriority,
} from './types.js';
import { bufferStreamToText, parseCsvText, splitSuitePath, slugifyColumnName } from './csvHelpers.js';

const PRIORITY_MAP: Record<string, ParsedPriority> = {
  '1 - low': 'LOW',
  low: 'LOW',
  '2 - medium': 'MEDIUM',
  medium: 'MEDIUM',
  '3 - high': 'HIGH',
  high: 'HIGH',
  '4 - critical': 'CRITICAL',
  critical: 'CRITICAL',
};

function foldPriority(raw: string | undefined): ParsedPriority {
  if (!raw) return 'MEDIUM';
  return PRIORITY_MAP[raw.trim().toLowerCase()] ?? 'MEDIUM';
}

const NUMBERED = /^\s*\d+[.)]\s*/;

/**
 * Splits a cell holding several steps (or expected results) into one entry each. A numbered
 * list ("1. Do X\n2. Do Y") splits at the numbers, and unnumbered lines join the item above
 * (a step written over several lines); without numbers, each line is one entry.
 */
function splitStepLines(raw: string): string[] {
  const lines = (raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => NUMBERED.test(l))) return lines;
  const items: string[] = [];
  for (const line of lines) {
    if (NUMBERED.test(line) || items.length === 0) items.push(line.replace(NUMBERED, ''));
    else items[items.length - 1] += `\n${line}`;
  }
  return items;
}

/** Combined step and expected-result columns, by header (lower case). */
const STEP_HEADERS = new Set(['steps', 'step', 'steps (step)', 'steps (steps)', 'steps (text)']);
const EXPECTED_HEADERS = new Set(['expected result', 'expected results', 'expected', 'steps (expected result)', 'steps (expected results)', 'steps (expected)']);
/** TestRail's indexed variant: `Steps (Step 1)`, `Steps (Expected Result 1)`, ... */
const INDEXED_STEP = /^steps?\s*\(\s*step\s*(\d+)\s*\)$/i;
const INDEXED_EXPECTED = /^steps?\s*\(\s*expected\s*results?\s*(\d+)\s*\)$/i;

/**
 * Parses TestRail CSV exports, in any of the layouts TestRail writes steps in:
 * - one row per case, with a `Steps` (or `Step`) column and an `Expected Result` column holding
 *   several steps, as a numbered list or one per line;
 * - one row per case with indexed columns, `Steps (Step 1)`, `Steps (Expected Result 1)`, ...;
 * - one row per step: the case's fields on its first row, then rows with no ID or title that add
 *   a step each.
 * `Section` ("Parent > Child") becomes the suite tree, `Priority` maps onto Tessick's four, and
 * a `Type` of "Automated" makes the case AUTOMATED. Other columns become custom fields.
 */
export class TestRailCsvParser implements IFileParser {
  readonly formatId = 'TESTRAIL_CSV';

  // Always requires explicit format selection -- TestRail's header set can plausibly
  // collide with the generic STANDARD_CSV fuzzy matcher.
  canHandle(): boolean {
    return false;
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    _options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const text = await bufferStreamToText(inputStream);
    const rows = parseCsvText(text);
    if (rows.length === 0) return;

    const headers = rows[0].map((h) => h.trim());
    const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell.trim()));

    let titleIdx = -1;
    let sectionIdx = -1;
    let idIdx = -1;
    let priorityIdx = -1;
    let preconditionsIdx = -1;
    let typeIdx = -1;
    let stepsIdx = -1;
    let expectedIdx = -1;
    const indexed = new Map<number, { step?: number; expected?: number }>();
    const customFieldCols: Array<{ index: number; key: string }> = [];

    headers.forEach((h, idx) => {
      const lower = h.toLowerCase();
      const indexedStep = INDEXED_STEP.exec(h);
      const indexedExpected = INDEXED_EXPECTED.exec(h);
      if (indexedStep || indexedExpected) {
        const n = Number((indexedStep ?? indexedExpected)![1]);
        const entry = indexed.get(n) ?? {};
        if (indexedStep) entry.step = idx;
        else entry.expected = idx;
        indexed.set(n, entry);
      } else if (lower === 'title') {
        if (titleIdx === -1) titleIdx = idx;
      } else if (lower === 'section' || lower === 'section hierarchy') {
        if (sectionIdx === -1) sectionIdx = idx;
      } else if (lower === 'id' || lower === 'case id') {
        if (idIdx === -1) idIdx = idx;
      } else if (lower === 'priority') {
        if (priorityIdx === -1) priorityIdx = idx;
      } else if (lower === 'preconditions' || lower === 'precondition') {
        if (preconditionsIdx === -1) preconditionsIdx = idx;
      } else if (STEP_HEADERS.has(lower) && stepsIdx === -1) {
        stepsIdx = idx;
      } else if (EXPECTED_HEADERS.has(lower) && expectedIdx === -1) {
        expectedIdx = idx;
      } else {
        // Type stays a custom field too; it also decides the execution type below.
        if (lower === 'type' && typeIdx === -1) typeIdx = idx;
        customFieldCols.push({ index: idx, key: slugifyColumnName(h) });
      }
    });
    const indexedColumns = [...indexed.entries()].sort(([a], [b]) => a - b).map(([, cols]) => cols);
    const cell = (row: string[], idx: number) => (idx !== -1 ? (row[idx] ?? '').trim() : '');

    // One row per step: rows with step text but no ID or title continue the case above them.
    // Then each row's step cell is one step (which may span lines), not a list to split.
    const isContinuation = (row: string[]) => !cell(row, titleIdx) && !cell(row, idIdx);
    const rowPerStep = dataRows.some((row, i) => i > 0 && isContinuation(row) && (cell(row, stepsIdx) || cell(row, expectedIdx)));

    const rootSuitesMap = new Map<string, ParsedSuite>();
    let current: ParsedCase | null = null;

    for (const row of dataRows) {
      if (rowPerStep && current && isContinuation(row)) {
        const action = cell(row, stepsIdx);
        const expected = cell(row, expectedIdx);
        if (action || expected) current.steps.push(this.step(current.steps.length + 1, action, expected));
        continue;
      }

      const title = cell(row, titleIdx) || 'Unnamed Case';
      const externalId = cell(row, idIdx) || undefined;
      const type = cell(row, typeIdx);
      const customFields: Record<string, string> = {};
      for (const cf of customFieldCols) {
        const val = cell(row, cf.index);
        if (val) customFields[cf.key] = val;
      }
      const parserWarnings: string[] = [];

      let steps: ParsedStep[];
      if (indexedColumns.length > 0) {
        steps = [];
        for (const cols of indexedColumns) {
          const action = cols.step !== undefined ? cell(row, cols.step) : '';
          const expected = cols.expected !== undefined ? cell(row, cols.expected) : '';
          if (action || expected) steps.push(this.step(steps.length + 1, action, expected));
        }
      } else if (rowPerStep) {
        const action = cell(row, stepsIdx);
        const expected = cell(row, expectedIdx);
        steps = action || expected ? [this.step(1, action, expected)] : [];
      } else {
        const actions = splitStepLines(cell(row, stepsIdx));
        const expectations = splitStepLines(cell(row, expectedIdx));
        const misaligned = actions.length > 0 && expectations.length > 0 && expectations.length !== actions.length;
        // Mismatched counts: the expected results go on the last step (they usually describe where
        // the test ends up); the import warns so someone can check.
        steps = actions.map((action, i) =>
          this.step(i + 1, action, misaligned ? (i === actions.length - 1 ? expectations.join('\n') : '') : expectations[i] || '')
        );
        if (actions.length === 0 && expectations.length > 0) steps = [this.step(1, '', expectations.join('\n'))];
        if (misaligned) parserWarnings.push('STEP_EXPECTED_MISALIGNED');
      }

      current = {
        external_id: externalId,
        title: title.length > 255 ? title.substring(0, 255) : title,
        summary: '',
        preconditions: cell(row, preconditionsIdx),
        importance: foldPriority(cell(row, priorityIdx) || undefined),
        execution_type: /^automated$/i.test(type) ? 'AUTOMATED' : 'MANUAL',
        steps,
        custom_fields: customFields,
        ...(parserWarnings.length > 0 ? { parser_warnings: parserWarnings } : {}),
      };
      this.suiteFor(rootSuitesMap, cell(row, sectionIdx)).test_cases.push(current);
    }

    for (const suite of rootSuitesMap.values()) {
      yield suite;
    }
  }

  private step(stepNumber: number, action: string, expected: string): ParsedStep {
    return { step_number: stepNumber, actions: action, expected_results: expected, execution_type: 'MANUAL' };
  }

  /** The suite for a `Section` ("Parent > Child"), created on first use. */
  private suiteFor(roots: Map<string, ParsedSuite>, section: string): ParsedSuite {
    const segments = splitSuitePath(section);
    if (!roots.has(segments[0])) roots.set(segments[0], { name: segments[0], details: '', node_order: roots.size, sub_suites: [], test_cases: [] });
    let suite = roots.get(segments[0])!;
    for (const seg of segments.slice(1)) {
      let sub = suite.sub_suites.find((s) => s.name === seg);
      if (!sub) {
        sub = { name: seg, details: '', node_order: suite.sub_suites.length, sub_suites: [], test_cases: [] };
        suite.sub_suites.push(sub);
      }
      suite = sub;
    }
    return suite;
  }
}

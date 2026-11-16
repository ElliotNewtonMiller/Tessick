import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { TestRailCsvParser } from '../src/ingestion/TestRailCsvParser.js';
import type { ParsedSuite } from '../src/ingestion/types.js';

async function parseAll(csv: string): Promise<ParsedSuite[]> {
  const parser = new TestRailCsvParser();
  const suites: ParsedSuite[] = [];
  for await (const suite of parser.parseStream(Readable.from([csv]))) {
    suites.push(suite);
  }
  return suites;
}

describe('TestRailCsvParser', () => {
  it('canHandle always returns false -- this format requires explicit selection', () => {
    const parser = new TestRailCsvParser();
    expect(parser.canHandle()).toBe(false);
  });

  it('parses Title/Section/Priority/Preconditions/Steps/Expected Result, mapping Critical to CRITICAL', async () => {
    const csv = [
      'ID,Title,Section,Priority,Preconditions,Steps,Expected Result,Type,References',
      'C1,Checkout works,Payments > Checkout,Critical,User is logged in,"1. Add item to cart\n2. Click checkout","1. Item appears in cart\n2. Checkout page loads",Regression,JIRA-42',
    ].join('\n');

    const suites = await parseAll(csv);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('Payments');
    expect(suites[0].sub_suites).toHaveLength(1);
    expect(suites[0].sub_suites[0].name).toBe('Checkout');

    const tc = suites[0].sub_suites[0].test_cases[0];
    expect(tc.external_id).toBe('C1');
    expect(tc.title).toBe('Checkout works');
    expect(tc.importance).toBe('CRITICAL');
    expect(tc.preconditions).toBe('User is logged in');
    expect(tc.steps).toHaveLength(2);
    expect(tc.steps[0]).toMatchObject({ actions: 'Add item to cart', expected_results: 'Item appears in cart' });
    expect(tc.steps[1]).toMatchObject({ actions: 'Click checkout', expected_results: 'Checkout page loads' });
    expect(tc.custom_fields).toEqual({ cf_type: 'Regression', cf_references: 'JIRA-42' });
  });

  it('maps every known TestRail priority label onto the four Tessick priorities, defaulting to MEDIUM', async () => {
    const csv = [
      'Title,Priority',
      'A,Low',
      'B,2 - Medium',
      'C,High',
      'D,4 - Critical',
      'E,NotARealPriority',
    ].join('\n');
    const suites = await parseAll(csv);
    const byTitle = Object.fromEntries(suites[0].test_cases.map((c) => [c.title, c.importance]));
    expect(byTitle).toEqual({ A: 'LOW', B: 'MEDIUM', C: 'HIGH', D: 'CRITICAL', E: 'MEDIUM' });
  });

  it('flags a step/expected line-count mismatch, putting the expected results on the last step', async () => {
    const csv = ['Title,Steps,Expected Result', 'A,"1. Do X\n2. Do Y","1. Result X"'].join('\n');
    const tc = (await parseAll(csv))[0].test_cases[0];
    expect(tc.parser_warnings).toContain('STEP_EXPECTED_MISALIGNED');
    expect(tc.steps.map((s) => [s.actions, s.expected_results])).toEqual([
      ['Do X', ''],
      ['Do Y', 'Result X'],
    ]);
  });

  it('reads a Step column with one step per line, unnumbered, beside Expected Result (as TestRail exports it)', async () => {
    const csv = [
      '"ID","Title","Section","Type","Priority","Estimate","Preconditions","Step","Expected Result"',
      '"C1","Sign in","Auth > Login","Functional","High","2m","A user exists.","Open the page.\nEnter the password.\nPress Sign in.","The form shows.\nThe field is masked.\nThe dashboard opens."',
      '"C2","Run the batch","API > Batch","Automated","Critical","5m","","Send the batch.","201 Created."',
    ].join('\n');
    const suites = await parseAll(csv);
    const [login, batch] = [suites[0].sub_suites[0].test_cases[0], suites[1].sub_suites[0].test_cases[0]];
    expect(login.steps.map((s) => [s.step_number, s.actions, s.expected_results])).toEqual([
      [1, 'Open the page.', 'The form shows.'],
      [2, 'Enter the password.', 'The field is masked.'],
      [3, 'Press Sign in.', 'The dashboard opens.'],
    ]);
    expect(login).toMatchObject({ external_id: 'C1', importance: 'HIGH', execution_type: 'MANUAL', preconditions: 'A user exists.', custom_fields: { cf_type: 'Functional', cf_estimate: '2m' } });
    expect(login.custom_fields).not.toHaveProperty('cf_step');
    expect(login.parser_warnings).toBeUndefined();
    // Type "Automated" makes the case AUTOMATED (and stays a custom field).
    expect(batch).toMatchObject({ importance: 'CRITICAL', execution_type: 'AUTOMATED', custom_fields: { cf_type: 'Automated' } });
  });

  it('reads indexed step columns: Steps (Step 1), Steps (Expected Result 1), ...', async () => {
    const csv = [
      'Title,Section,Steps (Step 1),Steps (Expected Result 1),Steps (Step 2),Steps (Expected Result 2),Steps (Step 3),Steps (Expected Result 3)',
      'A,S,Do X,Result X,"Do Y\non two lines",Result Y,,',
    ].join('\n');
    const tc = (await parseAll(csv))[0].test_cases[0];
    expect(tc.steps.map((s) => [s.step_number, s.actions, s.expected_results])).toEqual([
      [1, 'Do X', 'Result X'],
      [2, 'Do Y\non two lines', 'Result Y'],
    ]);
    expect(Object.keys(tc.custom_fields)).toEqual([]);
    expect(tc.parser_warnings).toBeUndefined();
  });

  it('reads one row per step: rows with no ID or title add a step to the case above', async () => {
    const csv = [
      'ID,Title,Section,Priority,Steps (Step),Steps (Expected Result)',
      'C1,First,S,High,Open the page,"It shows,\nfully"',
      ',,,,Click save,Saved',
      'C2,Second,S,Low,Do one thing,Done',
      ',,,,Do another,Also done',
      ',,,,"1. Numbered text stays\n2. one step here",',
    ].join('\n');
    const [first, second] = (await parseAll(csv))[0].test_cases;
    expect(first.steps.map((s) => [s.step_number, s.actions, s.expected_results])).toEqual([
      [1, 'Open the page', 'It shows,\nfully'],
      [2, 'Click save', 'Saved'],
    ]);
    expect(second.steps.map((s) => s.actions)).toEqual(['Do one thing', 'Do another', '1. Numbered text stays\n2. one step here']);
  });

  it('a numbered list keeps a step written over several lines together', async () => {
    const csv = ['Title,Steps,Expected Result', 'A,"1. Fill in the form:\nname and email\n2. Submit","1. Accepted\n2. Thanks page"'].join('\n');
    const tc = (await parseAll(csv))[0].test_cases[0];
    expect(tc.steps.map((s) => [s.actions, s.expected_results])).toEqual([
      ['Fill in the form:\nname and email', 'Accepted'],
      ['Submit', 'Thanks page'],
    ]);
  });

  it('splits Section hierarchy the same way CsvParser splits Suite Path', async () => {
    const csv = ['Title,Section', 'A,Root > Mid > Leaf'].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].name).toBe('Root');
    expect(suites[0].sub_suites[0].name).toBe('Mid');
    expect(suites[0].sub_suites[0].sub_suites[0].name).toBe('Leaf');
  });

  it('names a custom field made from a column readably', async () => {
    const { fieldLabelFromKey } = await import('../src/ingestion/csvHelpers.js');
    expect(['cf_type', 'cf_test_type', 'cf_estimate__min_', 'plain'].map(fieldLabelFromKey)).toEqual(['Type', 'Test type', 'Estimate min', 'Plain']);
  });
});

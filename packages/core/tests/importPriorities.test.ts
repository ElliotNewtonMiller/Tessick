import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { CsvParser, JsonSchemaParser, TestRailCsvParser, SaxXmlParser, normalizePriority, type IFileParser, type ParsedSuite } from '../src/index.js';

async function parseAll(parser: IFileParser, text: string): Promise<ParsedSuite[]> {
  const suites: ParsedSuite[] = [];
  for await (const suite of parser.parseStream(Readable.from([text]))) suites.push(suite);
  return suites;
}

describe('priorities in imports: all four of Testify\'s', () => {
  it('normalizePriority reads names in any case, 1-4, and falls back', () => {
    expect(['critical', 'High', 'MEDIUM', 'low', ' Critical '].map((p) => normalizePriority(p))).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'CRITICAL']);
    expect(['1', '2', '3', '4', 4].map((p) => normalizePriority(p))).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'CRITICAL']);
    expect(normalizePriority('urgent')).toBe('MEDIUM');
    expect(normalizePriority('', 'low')).toBe('LOW');
    expect(normalizePriority(undefined, 'nonsense')).toBe('MEDIUM');
  });

  it('CSV: an Importance or a Priority column, CRITICAL included', async () => {
    const byImportance = await parseAll(new CsvParser(), 'Suite Path,Title,Importance\nA,One,CRITICAL\nA,Two,4\nA,Three,low');
    expect(byImportance[0].test_cases.map((c) => c.importance)).toEqual(['CRITICAL', 'CRITICAL', 'LOW']);
    const byPriority = await parseAll(new CsvParser(), 'Suite Path,Title,Priority\nA,One,Critical');
    expect(byPriority[0].test_cases[0]).toMatchObject({ importance: 'CRITICAL', custom_fields: {} });
  });

  it('JSON: importance or priority; TestRail: Critical; TestLink XML: 1-3', async () => {
    const json = await parseAll(new JsonSchemaParser(), JSON.stringify({ suites: [{ name: 'S', test_cases: [{ title: 'a', importance: 'CRITICAL' }, { title: 'b', priority: 'HIGH' }] }] }));
    expect(json[0].test_cases.map((c) => c.importance)).toEqual(['CRITICAL', 'HIGH']);
    const testrail = await parseAll(new TestRailCsvParser(), 'Title,Section,Priority\na,S,4 - Critical\nb,S,Critical\nc,S,2 - Medium');
    expect(testrail[0].test_cases.map((c) => c.importance)).toEqual(['CRITICAL', 'CRITICAL', 'MEDIUM']);
    const xml = await parseAll(new SaxXmlParser(), '<testsuite name="S"><testcase name="a"><importance>3</importance></testcase></testsuite>');
    expect(xml[0].test_cases[0].importance).toBe('HIGH');
  });

  it("JSON: reads Testify's own export (cases, priority, version content, custom field values)", async () => {
    const bundle = {
      object: 'definitions_export_bundle',
      suites: [
        {
          id: 's1',
          name: 'Checkout',
          description: 'Paying',
          position: 2,
          cases: [
            {
              id: 'c1',
              external_id: 'SHOP-7',
              title: 'Pays by card',
              priority: 'CRITICAL',
              execution_type: 'AUTOMATED',
              version: { id: 'v1', version_number: 3, status: 'APPROVED', summary: 'Card payment', preconditions: 'A cart' },
              steps: [{ id: 'st1', step_number: 1, action: 'Pay', expected_result: 'Paid', execution_type: 'MANUAL' }],
              custom_field_values: [
                { definition_id: 'd1', name: 'component', field_label: 'Component', field_type: 'TEXT', value: 'payments' },
                { definition_id: 'd2', name: 'tags', field_label: 'Tags', field_type: 'MULTI_SELECT', value: ['smoke', 'web'] },
                { definition_id: 'd3', name: 'unset', field_label: 'Unset', field_type: 'TEXT', value: null },
              ],
            },
          ],
          sub_suites: [{ id: 's2', name: 'Refunds', description: null, position: 0, cases: [], sub_suites: [] }],
        },
      ],
    };
    const [suite] = await parseAll(new JsonSchemaParser(), JSON.stringify(bundle));
    expect(suite).toMatchObject({ name: 'Checkout', details: 'Paying', node_order: 2, sub_suites: [{ name: 'Refunds' }] });
    expect(suite.test_cases[0]).toEqual({
      external_id: 'SHOP-7',
      title: 'Pays by card',
      summary: 'Card payment',
      preconditions: 'A cart',
      importance: 'CRITICAL',
      execution_type: 'AUTOMATED',
      steps: [{ step_number: 1, actions: 'Pay', expected_results: 'Paid', execution_type: 'MANUAL' }],
      custom_fields: { component: 'payments', tags: 'smoke, web' },
    });
  });
});

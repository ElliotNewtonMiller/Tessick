import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { SaxXmlParser, JsonSchemaParser, CsvParser, LOOSE_CASES_SUITE_NAME } from '../src/index.js';

describe('Core Ingestion Parsers', () => {
  it('SaxXmlParser parses TestLink XML streaming payload', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Auth Suite">
    <details><![CDATA[<p>Authentication details</p>]]></details>
    <node_order><![CDATA[1]]></node_order>
    <testcase name="Verify Login">
      <externalid><![CDATA[TC-AUTH-1]]></externalid>
      <summary><![CDATA[User login verification]]></summary>
      <preconditions><![CDATA[User registered]]></preconditions>
      <importance><![CDATA[3]]></importance>
      <execution_type><![CDATA[2]]></execution_type>
      <steps>
        <step>
          <step_number><![CDATA[1]]></step_number>
          <actions><![CDATA[Enter credentials]]></actions>
          <expectedresults><![CDATA[Redirect to dashboard]]></expectedresults>
        </step>
      </steps>
      <custom_fields>
        <custom_field>
          <name><![CDATA[cf_browser]]></name>
          <value><![CDATA[Chrome]]></value>
        </custom_field>
      </custom_fields>
    </testcase>
  </testsuite>
</testsuites>`;

    const parser = new SaxXmlParser();
    expect(parser.canHandle(Buffer.from(xmlContent), 'test.xml')).toBe(true);

    const stream = Readable.from([xmlContent]);
    const suites = [];
    for await (const suite of parser.parseStream(stream)) {
      suites.push(suite);
    }

    expect(suites.length).toBe(1);
    expect(suites[0].name).toBe('Auth Suite');
    expect(suites[0].details).toBe('Authentication details');
    expect(suites[0].test_cases.length).toBe(1);
    const tc = suites[0].test_cases[0];
    expect(tc.title).toBe('Verify Login');
    expect(tc.external_id).toBe('TC-AUTH-1');
    expect(tc.importance).toBe('HIGH');
    expect(tc.execution_type).toBe('AUTOMATED');
    expect(tc.steps.length).toBe(1);
    expect(tc.steps[0].actions).toBe('Enter credentials');
    expect(tc.custom_fields.cf_browser).toBe('Chrome');
  });

  it('SaxXmlParser decodes the HTML entities in TestLink rich text', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="Checkout">
  <testcase name="Pay">
    <summary><![CDATA[<p>Before &mdash; after &#8212; and &#x2014;</p>]]></summary>
    <preconditions><![CDATA[<p>Don&rsquo;t use caf&eacute;&nbsp;Wi-Fi &hellip; 5 &lt; 6 &amp;&amp; &quot;ok&quot; &#39;x&#39;</p>]]></preconditions>
    <steps>
      <step>
        <actions><![CDATA[Type &amp;mdash; literally]]></actions>
        <expectedresults><![CDATA[Unknown &foo; and bad &#0; stay]]></expectedresults>
      </step>
    </steps>
  </testcase>
</testsuite>`;

    const suites = [];
    for await (const suite of new SaxXmlParser().parseStream(Readable.from([xmlContent]))) suites.push(suite);
    const tc = suites[0].test_cases[0];
    expect(tc.summary).toBe('Before — after — and —');
    expect(tc.preconditions).toBe('Don’t use café Wi-Fi … 5 < 6 && "ok" \'x\'');
    // One pass: an escaped entity is text, not a second entity.
    expect(tc.steps[0].actions).toBe('Type &mdash; literally');
    expect(tc.steps[0].expected_results).toBe('Unknown &foo; and bad &#0; stay');
  });

  it("SaxXmlParser reads TestLink's export of a whole project: its suites are top-level suites", async () => {
    // TestLink wraps a project's suites in a nameless <testsuite>, the project itself.
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="" name="" >
<node_order><![CDATA[]]></node_order>
<details><![CDATA[]]></details>
<testsuite id="12" name="Checkout" >
  <testsuite id="13" name="Cards" >
    <testcase internalid="331" name="Pay with a saved card"><externalid><![CDATA[331]]></externalid></testcase>
  </testsuite>
  <testcase internalid="340" name="Apply a voucher"><externalid><![CDATA[340]]></externalid></testcase>
</testsuite>
<testsuite id="20" name="Search" >
  <testcase internalid="350" name="Search by name"><externalid><![CDATA[350]]></externalid></testcase>
</testsuite>
</testsuite>`;

    const suites = [];
    for await (const suite of new SaxXmlParser().parseStream(Readable.from([xmlContent]))) suites.push(suite);
    const outline = (s: any): unknown => [s.name, s.testlink_id, s.test_cases.map((c: any) => c.external_id), s.sub_suites.map(outline)];
    expect(suites.map(outline)).toEqual([
      ['Checkout', 12, ['340'], [['Cards', 13, ['331'], []]]],
      ['Search', 20, ['350'], []],
    ]);
    expect(suites.flatMap((s) => s.test_cases).every((c) => !c.parser_warnings)).toBe(true);
  });

  it("SaxXmlParser puts cases outside any suite (TestLink's <testcases> export) into one suite, with a warning", async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<testcases>
  <testcase internalid="360" name="Reset a password"><externalid><![CDATA[360]]></externalid></testcase>
  <testcase internalid="361" name="Sign out"><externalid><![CDATA[361]]></externalid></testcase>
</testcases>`;

    const parser = new SaxXmlParser();
    expect(parser.canHandle(Buffer.from(xmlContent), 'upload')).toBe(true);
    const suites = [];
    for await (const suite of parser.parseStream(Readable.from([xmlContent]))) suites.push(suite);
    expect(suites.map((s) => [s.name, s.sub_suites.length])).toEqual([[LOOSE_CASES_SUITE_NAME, 0]]);
    expect(suites[0].test_cases.map((c) => [c.title, c.testlink_id, c.parser_warnings])).toEqual([
      ['Reset a password', 360, ['CASE_OUTSIDE_SUITE']],
      ['Sign out', 361, ['CASE_OUTSIDE_SUITE']],
    ]);
  });

  it('JsonSchemaParser parses Native JSON payload', async () => {
    const jsonContent = JSON.stringify([
      {
        name: 'Payment Suite',
        details: 'Stripe integration',
        node_order: 2,
        test_cases: [
          {
            title: 'Stripe 3DS',
            external_id: 'TC-PAY-1',
            importance: 'HIGH',
            execution_type: 'AUTOMATED',
            steps: [{ step_number: 1, actions: 'Click pay', expected_results: 'Challenge popup' }],
            custom_fields: { cf_gateway: 'Stripe' },
          },
        ],
      },
    ]);

    const parser = new JsonSchemaParser();
    expect(parser.canHandle(Buffer.from(jsonContent), 'test.json')).toBe(true);

    const stream = Readable.from([jsonContent]);
    const suites = [];
    for await (const suite of parser.parseStream(stream)) {
      suites.push(suite);
    }

    expect(suites.length).toBe(1);
    expect(suites[0].name).toBe('Payment Suite');
    expect(suites[0].test_cases[0].title).toBe('Stripe 3DS');
    expect(suites[0].test_cases[0].custom_fields.cf_gateway).toBe('Stripe');
  });

  it('CsvParser parses CSV tabular payload', async () => {
    const csvContent = `Suite Path,Title,External ID,Summary,Importance,Execution Type,Step Number,Action,Expected Result,CF: Environment
Payments / Checkout,Verify Payment,TC-PAY-2,Summary text,HIGH,AUTOMATED,1,Submit form,Success,Staging
Payments / Checkout,Verify Payment,TC-PAY-2,Summary text,HIGH,AUTOMATED,2,Check DB,Record inserted,Staging`;

    const parser = new CsvParser();
    expect(parser.canHandle(Buffer.from(csvContent), 'test.csv')).toBe(true);

    const stream = Readable.from([csvContent]);
    const suites = [];
    for await (const suite of parser.parseStream(stream)) {
      suites.push(suite);
    }

    expect(suites.length).toBe(1);
    expect(suites[0].name).toBe('Payments');
    expect(suites[0].sub_suites.length).toBe(1);
    expect(suites[0].sub_suites[0].name).toBe('Checkout');
    expect(suites[0].sub_suites[0].test_cases.length).toBe(1);
    const tc = suites[0].sub_suites[0].test_cases[0];
    expect(tc.title).toBe('Verify Payment');
    expect(tc.steps.length).toBe(2);
    expect(tc.custom_fields.cf_environment).toBe('Staging');
  });

  it('SaxXmlParser operates under <64MB heap on simulated large dataset stream', async () => {
    // Generate streaming chunks of XML
    async function* generateLargeXmlStream() {
      yield '<?xml version="1.0" encoding="UTF-8"?><testsuites>';
      for (let i = 0; i < 5000; i++) {
        yield `<testsuite name="Suite ${i}"><testcase name="Case ${i}"><externalid>TC-${i}</externalid><summary>Summary for case ${i}</summary></testcase></testsuite>`;
      }
      yield '</testsuites>';
    }

    const parser = new SaxXmlParser();
    let count = 0;
    const initialHeap = process.memoryUsage().heapUsed;

    for await (const suite of parser.parseStream(generateLargeXmlStream())) {
      count++;
    }

    const finalHeap = process.memoryUsage().heapUsed;
    const heapDiffMb = (finalHeap - initialHeap) / (1024 * 1024);

    expect(count).toBe(5000);
    expect(heapDiffMb).toBeLessThan(64);
  });
});

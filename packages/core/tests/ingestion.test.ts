import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { SaxXmlParser, JsonSchemaParser, CsvParser, LOOSE_CASES_SUITE_NAME, cleanHtmlText, parseTestLinkPlanXml, isTestLinkPlanXml, TestLinkPlanFileError } from '../src/index.js';

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

  it("cleanHtmlText turns TestLink's lists, tables and editor whitespace into readable lines", () => {
    // TestLink's editor indents its HTML and wraps list items and table cells in paragraphs.
    const list = `<p>Filters:</p>

<ul>
	<li>
	<p>By type</p>
	</li>
	<li>
	<p>By &lsquo;length&rsquo;</p>
	</li>
</ul>
<ol><li>Open the page</li><li>Apply a filter<ol><li>first</li><li>second</li></ol></li></ol>`;
    expect(cleanHtmlText(list)).toBe('Filters:\n- By type\n- By ‘length’\n1. Open the page\n2. Apply a filter\n1. first\n2. second');

    const table = `<p>Files:</p>

<table border="1">
	<tbody>
		<tr>
			<td><strong>Type</strong></td>
			<td><strong>Name</strong></td>
		</tr>
		<tr>
			<td>.docx</td>
			<td>
			<p>Plan &amp; guide</p>
			</td>
		</tr>
	</tbody>
</table>

<p>&nbsp;</p>`;
    expect(cleanHtmlText(table)).toBe('Files:\n\nType | Name\n.docx | Plan & guide');

    // In HTML the source's line breaks are spaces; <br> and paragraphs make the lines.
    expect(cleanHtmlText('<p>One\n\t two<br />\nthree</p>\n\n<p>four</p>')).toBe('One two\nthree\n\nfour');
    // Text without tags keeps its own line breaks.
    expect(cleanHtmlText('First line\n  indented line\n\nlast &amp; done')).toBe('First line\n  indented line\n\nlast & done');
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

  it("SaxXmlParser reads each case's TestLink status: final approved, obsolete or inactive deprecated, the rest draft", async () => {
    const tcase = (name: string, extra: string) => `<testcase name="${name}">${extra}</testcase>`;
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="Statuses">
  ${tcase('final', '<status>7</status><active>1</active>')}
  ${tcase('draft', '<status>1</status><active>1</active>')}
  ${tcase('review', '<status>2</status><active>1</active>')}
  ${tcase('rework', '<status>4</status><active>1</active>')}
  ${tcase('obsolete', '<status>5</status><active>1</active>')}
  ${tcase('inactive final', '<status>7</status><active>0</active>')}
  ${tcase('active only', '<active>1</active>')}
  ${tcase('no status', '')}
</testsuite>`;

    const suites = [];
    for await (const suite of new SaxXmlParser().parseStream(Readable.from([xmlContent]))) suites.push(suite);
    expect(suites[0].test_cases.map((c) => [c.title, c.status])).toEqual([
      ['final', 'APPROVED'],
      ['draft', 'DRAFT'],
      ['review', 'DRAFT'],
      ['rework', 'DRAFT'],
      ['obsolete', 'DEPRECATED'],
      ['inactive final', 'DEPRECATED'],
      ['active only', 'DRAFT'],
      ['no status', undefined],
    ]);
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

// TestLink's export of a test plan's linked test cases (linkedItems_<plan>.xml).
const PLAN_XML = `<?xml version="1.0" encoding="UTF-8"?>


	<testplan>
		<name><![CDATA[Regression & smoke]]></name>
		<platforms>
			<platform><name><![CDATA[Chrome]]></name><internal_id><![CDATA[3]]></internal_id></platform>
		</platforms>
<executables>
	<link>
		<platform><name><![CDATA[Chrome]]></name></platform>
		<testcase>
			<name><![CDATA[Pays by card]]></name>
			<externalid><![CDATA[7]]></externalid>
			<version><![CDATA[2]]></version>
			<execution_order><![CDATA[20]]></execution_order>
		</testcase>
</link>
	<link>
		<platform><name><![CDATA[Firefox]]></name></platform>
		<testcase>
			<name><![CDATA[Pays by card]]></name>
			<externalid><![CDATA[7]]></externalid>
			<version><![CDATA[2]]></version>
			<execution_order><![CDATA[20]]></execution_order>
		</testcase>
</link>
	<link>
		<platform><name><![CDATA[]]></name></platform>
		<testcase>
			<name><![CDATA[Logs in]]></name>
			<externalid><![CDATA[3]]></externalid>
			<version><![CDATA[1]]></version>
			<execution_order><![CDATA[]]></execution_order>
		</testcase>
</link>
</executables>
	</testplan>`;

describe("TestLink's test plan export", () => {
  it('reads the name, platforms and every link in file order', () => {
    const plan = parseTestLinkPlanXml(PLAN_XML);
    expect(plan.name).toBe('Regression & smoke');
    expect(plan.platforms).toEqual(['Chrome', 'Firefox']);
    expect(plan.links).toEqual([
      { external_id: '7', name: 'Pays by card', version: 2, execution_order: 20, platform: 'Chrome' },
      { external_id: '7', name: 'Pays by card', version: 2, execution_order: 20, platform: 'Firefox' },
      { external_id: '3', name: 'Logs in', version: 1, execution_order: null, platform: '' },
    ]);
  });

  it('refuses a file that is not a plan export, or not XML', () => {
    expect(() => parseTestLinkPlanXml('<testsuite name="x"></testsuite>')).toThrow(/starts with <testsuite>, not <testplan>/);
    expect(() => parseTestLinkPlanXml('<testplan><name>x</name>')).toThrow(/isn't readable XML/);
    expect(() => parseTestLinkPlanXml('')).toThrow(/empty/);
  });

  it('is recognised by its first element', () => {
    expect(isTestLinkPlanXml(PLAN_XML)).toBe(true);
    expect(isTestLinkPlanXml('\uFEFF<!-- exported --><testplan>')).toBe(true);
    expect(isTestLinkPlanXml('<?xml version="1.0"?><testsuite name=""><testplan>')).toBe(false);
  });

  it("isn't read as test cases by the TestLink XML import", async () => {
    const read = async () => {
      for await (const _suite of new SaxXmlParser().parseStream(Readable.from([PLAN_XML]))) {
        // nothing should be read
      }
    };
    await expect(read()).rejects.toBeInstanceOf(TestLinkPlanFileError);
  });
});

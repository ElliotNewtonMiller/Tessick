import sax from 'sax';

/**
 * TestLink's export of a test plan (Test Plan Management → the plan's export icon, a file named
 * `linkedItems_<plan>.xml`): the plan's name, its platforms and, for each linked test case, the
 * case's number, name and version, the platform and the execution order.
 *
 *   <testplan>
 *     <name>Regression</name>
 *     <platforms><platform><name>Chrome</name><internal_id>3</internal_id></platform></platforms>
 *     <executables>
 *       <link>
 *         <platform><name>Chrome</name></platform>
 *         <testcase><name>Log in</name><externalid>12</externalid><version>2</version><execution_order>10</execution_order></testcase>
 *       </link>
 *     </executables>
 *   </testplan>
 *
 * The case's number has no project prefix; a case on several platforms has a link for each.
 */

export interface TestLinkPlanLink {
  /** <externalid>: the case's number in TestLink (`12`), or '' when the link has none */
  external_id: string;
  /** <testcase><name> */
  name: string;
  /** <version>: the TestLink version the plan holds, or null */
  version: number | null;
  /** <execution_order>, or null */
  execution_order: number | null;
  /** <link><platform><name>, or '' (no platform) */
  platform: string;
}

export interface TestLinkPlanFile {
  name: string;
  /** The plan's platforms: those listed in <platforms> and those its links name, each once, in order */
  platforms: string[];
  /** Every link, in the file's order */
  links: TestLinkPlanLink[];
}

/**
 * Thrown by the test case import (SaxXmlParser) when it's given a test plan export, whose
 * <externalid>s it would otherwise read as cases to update.
 */
export class TestLinkPlanFileError extends Error {
  constructor() {
    super(
      "This is a TestLink test plan export (a plan's linked test cases), not test cases. Import it as a test plan: choose “TestLink test plan (XML)” in the Import wizard."
    );
    this.name = 'TestLinkPlanFileError';
  }
}

/** Whether the text's first element is <testplan> (after an XML declaration, comments or a DOCTYPE). */
export function isTestLinkPlanXml(head: string): boolean {
  return /^﻿?\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<testplan[\s>/]/i.test(head);
}

const wholeNumber = (text: string): number | null => (/^-?\d+$/.test(text) ? Number(text) : null);

/** Reads a test plan export; a file that isn't one is refused with an Error whose message says why. */
export function parseTestLinkPlanXml(xml: string): TestLinkPlanFile {
  const parser = sax.parser(false, { trim: false });
  const stack: string[] = [];
  const plan: TestLinkPlanFile = { name: '', platforms: [], links: [] };
  let link: TestLinkPlanLink | null = null;
  let text = '';
  let rootSeen = false;
  let error: Error | null = null;

  const addPlatform = (name: string) => {
    if (name && !plan.platforms.includes(name)) plan.platforms.push(name);
  };

  parser.onerror = (e) => {
    error ??= new Error(`The file isn't readable XML: ${e.message.split('\n')[0]}`);
    // sax keeps throwing on the same error otherwise.
    (parser as unknown as { error: Error | null }).error = null;
  };
  parser.onopentag = (node) => {
    const tag = node.name.toLowerCase();
    if (!rootSeen) {
      rootSeen = true;
      if (tag !== 'testplan') {
        error ??= new Error(
          `This isn't a TestLink test plan export: it starts with <${tag}>, not <testplan>. Export the plan in TestLink (Test Plan Management → the plan's export icon), or import test cases as "TestLink XML".`
        );
      }
    }
    stack.push(tag);
    text = '';
    if (tag === 'link' && stack[stack.length - 2] === 'executables') {
      link = { external_id: '', name: '', version: null, execution_order: null, platform: '' };
    }
  };
  parser.ontext = (t) => {
    text += t;
  };
  parser.oncdata = (t) => {
    text += t;
  };
  parser.onclosetag = () => {
    const tag = stack.pop();
    const parent = stack[stack.length - 1];
    const grandparent = stack[stack.length - 2];
    const value = text.trim();
    text = '';
    if (tag === 'name' && parent === 'testplan') plan.name = value;
    else if (tag === 'name' && parent === 'platform' && grandparent === 'platforms') addPlatform(value);
    else if (link && tag === 'name' && parent === 'platform' && grandparent === 'link') link.platform = value;
    else if (link && parent === 'testcase') {
      if (tag === 'name') link.name = value;
      else if (tag === 'externalid') link.external_id = value;
      else if (tag === 'version') link.version = wholeNumber(value);
      else if (tag === 'execution_order') link.execution_order = wholeNumber(value);
    } else if (link && tag === 'link') {
      plan.links.push(link);
      addPlatform(link.platform);
      link = null;
    }
  };

  parser.write(xml).close();
  if (error) throw error;
  if (!rootSeen) throw new Error("The file is empty, or isn't XML.");
  // The lenient parser doesn't mind a missing end, but the cases after the cut would be lost.
  if (stack.length > 0) throw new Error(`The file isn't readable XML: it ends inside <${stack[stack.length - 1]}>, so it may be cut short.`);
  return plan;
}

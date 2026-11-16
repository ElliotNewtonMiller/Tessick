import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
} from './types.js';
import { normalizePriority } from './types.js';

export class JsonSchemaParser implements IFileParser {
  readonly formatId = 'NATIVE_JSON';

  canHandle(fileHeader: Buffer, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.json')) return true;
    const headerStr = fileHeader.toString('utf-8', 0, Math.min(fileHeader.length, 512)).trim();
    return headerStr.startsWith('{') || headerStr.startsWith('[');
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const chunks: string[] = [];
    if (Symbol.asyncIterator in (inputStream as any)) {
      for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      }
    } else {
      const stream = inputStream as Readable;
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      }
    }

    const fullContent = chunks.join('');
    if (!fullContent.trim()) return;

    let parsed: any;
    try {
      parsed = JSON.parse(fullContent);
    } catch (e) {
      throw new Error(`Failed to parse JSON schema: ${(e as Error).message}`);
    }

    let rawSuites: any[] = [];
    if (Array.isArray(parsed)) {
      rawSuites = parsed;
    } else if (parsed && Array.isArray(parsed.suites)) {
      rawSuites = parsed.suites;
    } else if (parsed && typeof parsed === 'object' && parsed.name) {
      rawSuites = [parsed];
    }

    for (const rawSuite of rawSuites) {
      yield this.normalizeSuite(rawSuite, options);
    }
  }

  private normalizeSuite(raw: any, options?: ParseOptions): ParsedSuite {
    const subSuites = Array.isArray(raw.sub_suites)
      ? raw.sub_suites.map((s: any) => this.normalizeSuite(s, options))
      : [];

    // `test_cases` in the import format; `cases` in Tessick's own JSON export (DefinitionsExportBundle).
    const rawCases = Array.isArray(raw.test_cases) ? raw.test_cases : Array.isArray(raw.cases) ? raw.cases : [];
    const testCases = rawCases.map((c: any) => this.normalizeCase(c, options));

    return {
      name: (raw.name || 'Unnamed Suite').trim(),
      details: raw.details || raw.description || '',
      node_order: typeof raw.node_order === 'number' ? raw.node_order : typeof raw.position === 'number' ? raw.position : 0,
      sub_suites: subSuites,
      test_cases: testCases,
    };
  }

  private normalizeCase(raw: any, options?: ParseOptions): ParsedCase {
    const steps = Array.isArray(raw.steps)
      ? raw.steps.map((st: any, idx: number) => ({
          step_number: typeof st.step_number === 'number' ? st.step_number : idx + 1,
          actions: st.actions || st.action || '',
          expected_results: st.expected_results || st.expected_result || st.expected || '',
          execution_type: (st.execution_type || 'MANUAL').toUpperCase() === 'AUTOMATED' ? 'AUTOMATED' : 'MANUAL',
        }))
      : [];

    // `importance` in the import format; `priority` in Tessick's export.
    const importance = normalizePriority(raw.importance ?? raw.priority, options?.defaultImportance);

    const rawExecType = (raw.execution_type || options?.defaultExecutionType || 'MANUAL').toString().toUpperCase();
    const executionType = rawExecType === 'AUTOMATED' ? 'AUTOMATED' : 'MANUAL';

    const customFields: Record<string, string> = {};
    if (raw.custom_fields && typeof raw.custom_fields === 'object') {
      for (const [k, v] of Object.entries(raw.custom_fields)) {
        customFields[k] = String(v ?? '');
      }
    }
    // Tessick's export: [{ name, value }], values typed. Lists become "a, b" (how imports read a
    // MULTI_SELECT value); unset values are left out.
    if (Array.isArray(raw.custom_field_values)) {
      for (const cf of raw.custom_field_values) {
        if (!cf || typeof cf.name !== 'string' || cf.value === null || cf.value === undefined || cf.value === '') continue;
        customFields[cf.name] = Array.isArray(cf.value) ? cf.value.join(', ') : String(cf.value);
      }
    }

    let title = (raw.title || raw.name || 'Unnamed Case').trim();
    if (title.length > 255) {
      title = title.substring(0, 255);
    }

    return {
      external_id: raw.external_id || raw.externalid || undefined,
      title,
      // Tessick's export keeps a case's content in `version`.
      summary: raw.summary || raw.version?.summary || '',
      preconditions: raw.preconditions || raw.version?.preconditions || '',
      importance,
      execution_type: executionType as any,
      steps: steps as ParsedStep[],
      custom_fields: customFields,
    };
  }
}

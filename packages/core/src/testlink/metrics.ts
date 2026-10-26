import type { TlCase } from './query.js';

/**
 * GET /testcasemetrics (Dave's custom route): a project's cases counted by their
 * `automationStatus` custom field, over the cases the query layer selected, so the metrics count
 * exactly what the case lists do.
 */

/** The field the metrics count, and the values they count (any other value counts only in `total`). */
export const AUTOMATION_STATUS_FIELD = 'automationStatus';
export const AUTOMATION_STATUS_VALUES = ['N/A', 'To Do', 'In Progress', 'Done', 'No'] as const;

/** The suite /testcasemetrics leaves out unless excludeSuiteNames is given (TestLink's configured Deprecated suite). */
export const METRICS_DEFAULT_EXCLUDED_SUITE = 'Deprecated';

function automationStatus(c: TlCase): string | null {
  // By its internal name, as Dave's route needs it.
  const field = Object.values(c.customfields).find((f) => f.name === AUTOMATION_STATUS_FIELD);
  const value = field?.value;
  return value === null || value === undefined || value.trim() === '' ? null : value;
}

export interface MetricsOptions {
  projectName: string;
  /** Add `byExecutionType` and `automated`. */
  includeExecutionType: boolean;
  /** The SWAG file's entry for this project (its productKey matched the project's API key). */
  swagProduct?: Record<string, unknown>;
}

export function testCaseMetrics(cases: TlCase[], opts: MetricsOptions): Record<string, unknown> {
  const counts: Record<string, number> = Object.fromEntries(AUTOMATION_STATUS_VALUES.map((v) => [v, 0]));
  const without: number[] = [];
  let automated = 0;
  const byExecutionType: Record<string, number> = { '1': 0, '2': 0 };
  for (const c of [...cases].sort((a, b) => a.id - b.id)) {
    const status = automationStatus(c);
    if (status === null) without.push(c.id);
    else if (status in counts) counts[status]++;
    byExecutionType[String(c.execution_type)] = (byExecutionType[String(c.execution_type)] ?? 0) + 1;
    if (c.execution_type === 2 && status === 'Done') automated++;
  }
  const metrics: Record<string, unknown> = {
    projectName: opts.projectName,
    total: cases.length,
    automation_status: counts,
    testcases_without_automation_status: without,
  };
  if (opts.includeExecutionType) Object.assign(metrics, { byExecutionType, automated });
  if (opts.swagProduct) {
    const { productKey: _key, ...coverage } = opts.swagProduct;
    metrics.testCoverageSWAGS = coverage;
  }
  return metrics;
}

/** The SWAG file's entry whose productKey is the project's API key, if any. */
export function swagProductFor(swag: unknown, projectApiKey: string): Record<string, unknown> | undefined {
  if (!swag || typeof swag !== 'object') return undefined;
  const entries = Array.isArray(swag) ? swag : Object.values(swag as Record<string, unknown>);
  return entries.find((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && (e as any).productKey === projectApiKey);
}

// The Import wizard's TestLink test plan import (imports/testlink-plan/...): its answers' types
// and the small rules the wizard shows them by.

export type PlanImportState = "READY" | "DRAFT" | "DEPRECATED" | "NOT_FOUND" | "ALREADY_IN_PLAN";
export type PlanImportOutcome = "ADDED" | "ALREADY_IN_PLAN" | "SKIPPED" | "FAILED";

export interface PlanImportItem {
  testlink_external_id: string;
  external_id: string | null;
  file_name: string;
  testlink_version: number | null;
  test_case_id: string | null;
  title: string | null;
  state: PlanImportState;
  title_differs: boolean;
}

export interface PlanImportPreview {
  object: "testlink_plan_preview";
  plan_name: string;
  matching_plans: Array<{ id: string; name: string; status: string }>;
  platforms: string[];
  summary: { links: number; total: number; ready: number; draft: number; deprecated: number; not_found: number; already_in_plan: number; title_differs: number };
  items: PlanImportItem[];
  warnings: Array<{ code: string; message: string }>;
}

export interface PlanImportResultItem extends PlanImportItem {
  outcome: PlanImportOutcome;
  approved: boolean;
  code?: string;
  detail?: string;
}

export interface PlanImportResult {
  object: "testlink_plan_import_result";
  plan: { id: string; name: string; status: string };
  plan_created: boolean;
  platforms: string[];
  summary: { total: number; added: number; approved: number; already_in_plan: number; skipped: number; failed: number };
  items: PlanImportResultItem[];
  warnings: Array<{ code: string; message: string }>;
}

/** Where the cases go: a new plan, or an existing plan's id. */
export type PlanImportTarget = "NEW" | string;

/** The `configuration` sent with the file. */
export function planImportConfiguration(target: PlanImportTarget, planName: string, approveDrafts: boolean) {
  return {
    ...(target === "NEW" ? (planName.trim() ? { plan_name: planName.trim() } : {}) : { test_plan_id: target }),
    ...(approveDrafts ? { approve_drafts: true } : {}),
  };
}

/** How many cases the import would add. */
export function casesToAdd(preview: PlanImportPreview, approveDrafts: boolean): number {
  return preview.summary.ready + (approveDrafts ? preview.summary.draft : 0);
}

const STATE_TEXT: Record<PlanImportState, string> = {
  READY: "Approved: added",
  DRAFT: "Draft: added only if approved",
  DEPRECATED: "Deprecated: can't be added",
  NOT_FOUND: "Not in this project",
  ALREADY_IN_PLAN: "Already in the plan",
};

/** What happens (preview) or happened (result) to a case, in a few words. */
export function planItemText(item: PlanImportItem | PlanImportResultItem, approveDrafts = false): string {
  if ("outcome" in item) {
    if (item.outcome === "ADDED") return item.approved ? "Approved and added" : "Added";
    if (item.outcome === "ALREADY_IN_PLAN") return "Already in the plan";
    if (item.outcome === "FAILED") return item.detail ?? "Failed";
    return item.state === "DRAFT" ? "Draft: not added" : STATE_TEXT[item.state];
  }
  if (item.state === "DRAFT" && approveDrafts) return "Draft: approved and added";
  return STATE_TEXT[item.state];
}

/** Whether a case is (or would be) in the plan after the import. */
export function planItemIncluded(item: PlanImportItem | PlanImportResultItem, approveDrafts = false): boolean {
  if ("outcome" in item) return item.outcome === "ADDED" || item.outcome === "ALREADY_IN_PLAN";
  return item.state === "READY" || item.state === "ALREADY_IN_PLAN" || (item.state === "DRAFT" && approveDrafts);
}

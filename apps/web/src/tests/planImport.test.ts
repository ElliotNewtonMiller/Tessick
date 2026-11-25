import { describe, it, expect } from "vitest";
import { casesToAdd, planImportConfiguration, planItemIncluded, planItemText, type PlanImportItem, type PlanImportPreview } from "../utils/planImport";

const item = (state: PlanImportItem["state"]): PlanImportItem => ({
  testlink_external_id: "7",
  external_id: "TL-7",
  file_name: "Pays by card",
  testlink_version: 1,
  test_case_id: state === "NOT_FOUND" ? null : "c7",
  title: state === "NOT_FOUND" ? null : "Pays by card",
  state,
  title_differs: false,
});

describe("TestLink test plan import (wizard)", () => {
  it("sends a new plan's name, or the existing plan, and the approval only when asked", () => {
    expect(planImportConfiguration("NEW", "  Regression ", false)).toEqual({ plan_name: "Regression" });
    expect(planImportConfiguration("NEW", "", true)).toEqual({ approve_drafts: true });
    expect(planImportConfiguration("plan-1", "ignored", true)).toEqual({ test_plan_id: "plan-1", approve_drafts: true });
  });

  it("counts drafts as added only when they're approved", () => {
    const preview = { summary: { ready: 20, draft: 59 } } as PlanImportPreview;
    expect(casesToAdd(preview, false)).toBe(20);
    expect(casesToAdd(preview, true)).toBe(79);
    expect(planItemIncluded(item("DRAFT"))).toBe(false);
    expect(planItemIncluded(item("DRAFT"), true)).toBe(true);
    expect(planItemText(item("DRAFT"), true)).toBe("Draft: approved and added");
    expect(planItemIncluded(item("DEPRECATED"), true)).toBe(false);
  });

  it("says what happened to each case after the import", () => {
    expect(planItemText({ ...item("DRAFT"), outcome: "ADDED", approved: true })).toBe("Approved and added");
    expect(planItemText({ ...item("DRAFT"), outcome: "SKIPPED", approved: false })).toBe("Draft: not added");
    expect(planItemText({ ...item("NOT_FOUND"), outcome: "SKIPPED", approved: false })).toBe("Not in this project");
    expect(planItemText({ ...item("READY"), outcome: "FAILED", approved: false, detail: "Plan is locked" })).toBe("Plan is locked");
    expect(planItemIncluded({ ...item("READY"), outcome: "ALREADY_IN_PLAN", approved: false })).toBe(true);
  });
});

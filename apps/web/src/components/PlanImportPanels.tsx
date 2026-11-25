import React from "react";
import {
  casesToAdd,
  planItemIncluded,
  planItemText,
  type PlanImportItem,
  type PlanImportPreview,
  type PlanImportResult,
  type PlanImportResultItem,
  type PlanImportTarget,
} from "../utils/planImport";

// The Import wizard's steps for a TestLink test plan export (ImportWizardModal): the preview, where
// the plan and the drafts are chosen, and the result.

const label: React.CSSProperties = { fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "6px" };

function Tiles({ tiles }: { tiles: Array<[string, number, string?]> }) {
  return (
    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "14px" }}>
      {tiles.map(([text, value, color]) => (
        <div
          key={text}
          style={{ flex: "1 1 100px", backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "6px", padding: "8px", textAlign: "center" }}
        >
          <div style={{ fontSize: "18px", fontWeight: 700, color: value > 0 ? (color ?? "#38bdf8") : "#475569" }}>{value}</div>
          <div style={{ fontSize: "10px", color: "#94a3b8" }}>{text}</div>
        </div>
      ))}
    </div>
  );
}

function CaseTable({ items, approveDrafts, heading }: { items: Array<PlanImportItem | PlanImportResultItem>; approveDrafts: boolean; heading: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <label style={label}>{heading}</label>
      <div style={{ maxHeight: "260px", overflowY: "auto", border: "1px solid #334155", borderRadius: "6px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
          <tbody>
            {items.map((item, i) => {
              const included = planItemIncluded(item, approveDrafts);
              const failed = "outcome" in item && item.outcome === "FAILED";
              const color = failed ? "#fca5a5" : included ? "#4ade80" : item.state === "DRAFT" ? "#fbbf24" : "#94a3b8";
              return (
                <tr key={`${item.testlink_external_id}-${i}`} style={{ borderTop: i === 0 ? "none" : "1px solid #1e293b" }}>
                  <td style={{ padding: "6px 8px", color: "#cbd5e1", whiteSpace: "nowrap", verticalAlign: "top", fontFamily: "monospace" }}>
                    {item.external_id ?? item.testlink_external_id ?? "—"}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#e2e8f0", verticalAlign: "top" }}>
                    {item.title ?? item.file_name}
                    {item.title_differs && (
                      <div style={{ fontSize: "11px", color: "#fbbf24" }}>In the plan file: {item.file_name}</div>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px", color, verticalAlign: "top", whiteSpace: "nowrap" }}>{planItemText(item, approveDrafts)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Warnings({ warnings }: { warnings: Array<{ code: string; message: string }> }) {
  if (warnings.length === 0) return null;
  return (
    <div style={{ marginBottom: "14px" }}>
      {warnings.map((w) => (
        <div
          key={w.code}
          style={{
            padding: "8px 10px",
            marginBottom: "6px",
            backgroundColor: "rgba(245, 158, 11, 0.1)",
            border: "1px solid #b45309",
            borderRadius: "4px",
            color: "#fcd34d",
            fontSize: "12px",
          }}
        >
          {w.message}
        </div>
      ))}
    </div>
  );
}

export function PlanImportPreviewPanel(props: {
  preview: PlanImportPreview;
  projectName: string;
  target: PlanImportTarget;
  onTargetChange: (target: PlanImportTarget) => void;
  planName: string;
  onPlanNameChange: (name: string) => void;
  approveDrafts: boolean;
  onApproveDraftsChange: (approve: boolean) => void;
  canApprove: boolean;
}) {
  const { preview, target, approveDrafts } = props;
  const { summary } = preview;
  const activePlans = preview.matching_plans.filter((p) => p.status === "ACTIVE");
  // The drafts get their own choice below, rather than a warning.
  const warnings = preview.warnings.filter((w) => w.code !== "DRAFT_CASES");
  return (
    <div>
      <div style={{ fontSize: "13px", marginBottom: "14px", color: "#e2e8f0" }}>
        TestLink test plan <strong>{preview.plan_name || "(unnamed)"}</strong>: {summary.total} cases, into <strong>{props.projectName}</strong>.
      </div>

      <label style={label}>TEST PLAN</label>
      <div style={{ marginBottom: "14px", fontSize: "12px", color: "#e2e8f0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
          <input type="radio" name="plan-target" checked={target === "NEW"} onChange={() => props.onTargetChange("NEW")} />
          A new plan named
          <input
            type="text"
            value={props.planName}
            maxLength={255}
            disabled={target !== "NEW"}
            onChange={(e) => props.onPlanNameChange(e.target.value)}
            style={{
              flex: 1,
              padding: "6px 8px",
              backgroundColor: "#1e293b",
              border: "1px solid #334155",
              borderRadius: "4px",
              color: "#e2e8f0",
              fontSize: "12px",
              opacity: target === "NEW" ? 1 : 0.5,
            }}
          />
        </label>
        {activePlans.map((p) => (
          <label key={p.id} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <input type="radio" name="plan-target" checked={target === p.id} onChange={() => props.onTargetChange(p.id)} />
            Add to the existing plan <strong>{p.name}</strong> (cases already in it stay as they are)
          </label>
        ))}
      </div>

      <Tiles
        tiles={[
          ["Will be added", casesToAdd(preview, approveDrafts), "#4ade80"],
          ["Drafts", summary.draft, "#fbbf24"],
          ["Deprecated", summary.deprecated, "#94a3b8"],
          ["Not in project", summary.not_found, "#fca5a5"],
          ["Already in plan", summary.already_in_plan],
          ["Other title here", summary.title_differs, "#fbbf24"],
        ]}
      />

      {summary.draft > 0 &&
        (props.canApprove ? (
          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "14px", fontSize: "12px", color: "#e2e8f0" }}>
            <input type="checkbox" checked={approveDrafts} onChange={(e) => props.onApproveDraftsChange(e.target.checked)} style={{ marginTop: "2px" }} />
            <span>
              Approve the {summary.draft} draft {summary.draft === 1 ? "case" : "cases"} and add {summary.draft === 1 ? "it" : "them"} too.
              <span style={{ color: "#94a3b8" }}> A plan takes only approved cases. Each approval is recorded as yours.</span>
            </span>
          </label>
        ) : (
          <Warnings
            warnings={[
              {
                code: "DRAFT_CASES",
                message: `${summary.draft} draft ${summary.draft === 1 ? "case is" : "cases are"} skipped: a plan takes only approved cases. Someone who can approve cases can approve them and import this plan again into the same plan.`,
              },
            ]}
          />
        ))}

      <Warnings warnings={warnings} />
      <CaseTable items={preview.items} approveDrafts={approveDrafts} heading={`CASES, IN TESTLINK'S ORDER (${preview.items.length})`} />
    </div>
  );
}

export function PlanImportResultPanel({ result }: { result: PlanImportResult }) {
  const { summary } = result;
  const notAdded = result.items.filter((i) => !planItemIncluded(i));
  return (
    <div>
      <div
        style={{
          padding: "12px",
          marginBottom: "16px",
          backgroundColor: "rgba(34, 197, 94, 0.1)",
          border: "1px solid #22c55e",
          borderRadius: "6px",
          color: "#4ade80",
          fontSize: "13px",
          fontWeight: 700,
        }}
      >
        ✓ {result.plan_created ? `Test plan “${result.plan.name}” created` : `Cases added to test plan “${result.plan.name}”`}
      </div>
      <Tiles
        tiles={[
          ["Added", summary.added, "#4ade80"],
          ["Approved", summary.approved, "#4ade80"],
          ["Already in plan", summary.already_in_plan],
          ["Not added", summary.skipped, "#fbbf24"],
          ["Failed", summary.failed, "#fca5a5"],
        ]}
      />
      {result.platforms.length > 0 && (
        <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "14px" }}>
          Platforms linked for the TestLink-compatible API: {result.platforms.join(", ")}.
        </div>
      )}
      <CaseTable items={notAdded} approveDrafts={false} heading={`NOT ADDED (${notAdded.length})`} />
    </div>
  );
}

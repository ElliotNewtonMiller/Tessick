import { useApp } from "../../app/AppContext";
import { NO_RUN_MESSAGE } from "../../app/messages";
import type { UnsavedNotes } from "../../hooks/useExecution";

interface StatusBannersProps {
  removeFromPlanPrompt: { kind: "case" | "suite"; id: string; detail: string } | null;
  setRemoveFromPlanPrompt: (prompt: null) => void;
  handleToggleCaseInclusion: (testCaseId: string, include: boolean, force?: boolean) => void;
  handleToggleSuiteInclusion: (suiteId: string, action: "ADD" | "REMOVE", force?: boolean) => void;
  isRunMissing: boolean;
  executionDenied: string | null;
  setExecutionDenied: (message: null) => void;
  unsavedNotes: UnsavedNotes | null;
  setUnsavedNotes: (notes: null) => void;
}

/** The yellow banners under the header: delete and removal confirmations, "no run", "Not
 *  permitted", "Notes not saved", and "No test plan set". */
export function StatusBanners({
  removeFromPlanPrompt,
  setRemoveFromPlanPrompt,
  handleToggleCaseInclusion,
  handleToggleSuiteInclusion,
  isRunMissing,
  executionDenied,
  setExecutionDenied,
  unsavedNotes,
  setUnsavedNotes,
}: StatusBannersProps) {
  const { scope, showToast } = useApp();
  const {
    deleteProjectPrompt,
    setDeleteProjectPrompt,
    handleConfirmDeleteProject,
    deletePlanPrompt,
    setDeletePlanPrompt,
    handleConfirmDeletePlan,
    deleteRunPrompt,
    setDeleteRunPrompt,
    handleConfirmDeleteRun,
    noPlanSetWarning,
    setNoPlanSetWarning,
  } = scope;

  return (
    <>
      {deleteProjectPrompt && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Confirm Deletion
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>{deleteProjectPrompt.detail}</div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setDeleteProjectPrompt(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDeleteProject}
              style={{
                padding: "5px 12px",
                backgroundColor: "#dc2626",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete Anyway
            </button>
          </div>
        </div>
      )}

      {deletePlanPrompt && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Confirm Deletion
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>{deletePlanPrompt.detail}</div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setDeletePlanPrompt(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDeletePlan}
              style={{
                padding: "5px 12px",
                backgroundColor: "#dc2626",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete Anyway
            </button>
          </div>
        </div>
      )}

      {removeFromPlanPrompt && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>⚠️ Confirm Removal</div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{removeFromPlanPrompt.detail}</div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setRemoveFromPlanPrompt(null)}
              style={{ padding: "5px 12px", backgroundColor: "#334155", border: "none", borderRadius: "4px", color: "#fff", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                const prompt = removeFromPlanPrompt;
                setRemoveFromPlanPrompt(null);
                if (prompt.kind === "case") handleToggleCaseInclusion(prompt.id, false, true);
                else handleToggleSuiteInclusion(prompt.id, "REMOVE", true);
              }}
              style={{ padding: "5px 12px", backgroundColor: "#dc2626", border: "none", borderRadius: "4px", color: "#fff", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
            >
              Remove anyway
            </button>
          </div>
        </div>
      )}

      {deleteRunPrompt && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Confirm Deletion
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>{deleteRunPrompt.detail}</div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setDeleteRunPrompt(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDeleteRun}
              style={{
                padding: "5px 12px",
                backgroundColor: "#dc2626",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete Anyway
            </button>
          </div>
        </div>
      )}

      {/* Execute mode with no run to record against -- results are blocked until one exists. */}
      {isRunMissing && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ No test run
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>{NO_RUN_MESSAGE}</div>
        </div>
      )}

      {executionDenied && (
        <div
          role="alert"
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Not permitted
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>
            {executionDenied}
          </div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setExecutionDenied(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {unsavedNotes && (
        <div
          role="alert"
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ Notes not saved
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1, minWidth: 0 }}>
            <div>
              Your notes for {unsavedNotes.externalId} weren't saved. {unsavedNotes.reason}
            </div>
            <div
              style={{
                marginTop: "6px",
                padding: "6px 8px",
                backgroundColor: "#451a03",
                borderRadius: "4px",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: "96px",
                overflowY: "auto",
              }}
            >
              {unsavedNotes.notes}
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => {
                navigator.clipboard
                  ?.writeText(unsavedNotes.notes)
                  .then(() => showToast("Notes copied"))
                  .catch(() => showToast("Couldn't copy: select the text instead"));
              }}
              style={{
                padding: "5px 12px",
                backgroundColor: "#b45309",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Copy notes
            </button>
            <button
              onClick={() => setUnsavedNotes(null)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {noPlanSetWarning && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #92400e",
            backgroundColor: "#78350f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, flexShrink: 0 }}>
            ⚠️ No test plan set
          </div>
          <div style={{ fontSize: "11px", color: "#fde68a", flex: 1 }}>
            Select or create a test plan before creating a test run
          </div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            <button
              onClick={() => setNoPlanSetWarning(false)}
              style={{
                padding: "5px 12px",
                backgroundColor: "#334155",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </>
  );
}

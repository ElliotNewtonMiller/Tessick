import type { Dispatch, SetStateAction } from "react";
import { useApp } from "../../app/AppContext";
import { PickerMenu } from "./PickerMenu";
import tessickMark from "../../assets/tessick-mark.svg";
import tessickWordmark from "../../assets/tessick-wordmark.svg";

/** Value of the Plan dropdown's "Show/Hide archived plans" entry -- never a real plan id. */
const TOGGLE_ARCHIVED_PLANS_VALUE = "__toggle_archived_plans__";

/** The header is a step lighter than the panes below it, with a border and shadow, so it reads
 *  as its own bar; its controls are a size up from the panes' dense 11px text. */
const pickerLabelStyle = { color: "#94a3b8", fontWeight: 600, fontSize: "13px" } as const;

const selectStyle = {
  backgroundColor: "#1e293b",
  color: "#f8fafc",
  border: "1px solid #3b4a63",
  borderRadius: "6px",
  padding: "5px 8px",
  fontSize: "13px",
  fontWeight: 600,
  outline: "none",
  cursor: "pointer",
  // Long project, plan or run names are cut off ("…") rather than pushing the header onto two rows.
  maxWidth: "220px",
  textOverflow: "ellipsis",
} as const;

const actionButtonStyle = (backgroundColor: string) =>
  ({
    backgroundColor,
    color: "#ffffff",
    border: "1px solid transparent",
    padding: "6px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
  }) as const;

/** A thin vertical rule between the header's groups. */
function Divider() {
  return <span aria-hidden style={{ width: "1px", height: "26px", backgroundColor: "#2e3d57" }} />;
}

type WorkspaceMode = "EXECUTION" | "SPECIFICATION";

interface AppHeaderProps {
  appView: "WORKSPACE" | "REPORTS";
  setAppView: Dispatch<SetStateAction<"WORKSPACE" | "REPORTS">>;
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: Dispatch<SetStateAction<WorkspaceMode>>;
  setImportWizardOpen: (open: boolean) => void;
  setExportModalOpen: (open: boolean) => void;
  setAdminPanelOpen: (open: boolean) => void;
  setAuthModalOpen: (open: boolean) => void;
}

/** The top bar: the Spec / Execute / Reports switch, the Project / Plan / Run pickers with their
 *  add/edit/delete buttons, Import, Export, the Admin Panel, and the signed-in user. */
export function AppHeader({
  appView,
  setAppView,
  workspaceMode,
  setWorkspaceMode,
  setImportWizardOpen,
  setExportModalOpen,
  setAdminPanelOpen,
  setAuthModalOpen,
}: AppHeaderProps) {
  const { currentUser, handleLogout, can, globalCan, scope } = useApp();
  const {
    projectsList,
    plansList,
    runsList,
    selectedProjectId,
    selectedPlanId,
    selectedRunId,
    handleSelectProject,
    handleSelectPlan,
    handleSelectRun,
    handleDeleteProjectClick,
    handleDeletePlanClick,
    handleDeleteRunClick,
    openEntityModal,
    setNoPlanSetWarning,
    showArchivedPlans,
    setShowArchivedPlans,
  } = scope;
  // Creating a project and the Admin Panel are global; everything else is about the selected project.
  const { hasAdminPanelAccess } = globalCan;
  const {
    hasExportDataPermission,
    hasImportDataPermission,
    hasPlanManagePermission,
    hasProjectCreatePermission,
    hasProjectDeletePermission,
    hasRunManagePermission,
    hasSpecViewPermission,
  } = can;

  return (
    <header
      style={{
        minHeight: "60px",
        backgroundColor: "#141b2d",
        borderBottom: "1px solid #2e3d57",
        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.45)",
        position: "relative",
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 14px",
        fontSize: "13px",
        gap: "12px",
        flexWrap: "wrap",
      }}
    >
      {/* ENTITY DROPDOWNS & ACTIONS (PROJECT, PLAN, RUN) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <img src={tessickMark} alt="" style={{ height: "22px", display: "block" }} />
          <img src={tessickWordmark} alt="Tessick" style={{ height: "13px", display: "block" }} />
        </span>
        <Divider />

        {/* VIEW SWITCH: Spec and Execute are the two workspace modes; Reports replaces the panes. */}
        <div role="group" aria-label="View" style={{ display: "flex", border: "1px solid #3b4a63", borderRadius: "6px", overflow: "hidden" }}>
          {(
            [
              { view: "SPECIFICATION", label: "Spec" },
              { view: "EXECUTION", label: "Execute" },
              ...(hasSpecViewPermission ? [{ view: "REPORTS", label: "Reports" }] : []),
            ] as Array<{ view: WorkspaceMode | "REPORTS"; label: string }>
          ).map(({ view, label }) => {
            const active = view === "REPORTS" ? appView === "REPORTS" : appView !== "REPORTS" && workspaceMode === view;
            const blocked = view === "SPECIFICATION" && !hasSpecViewPermission;
            return (
              <button
                key={view}
                aria-pressed={active}
                disabled={blocked}
                title={blocked ? "Your role can't view test specifications" : undefined}
                onClick={() => {
                  if (view === "REPORTS") {
                    setAppView("REPORTS");
                  } else {
                    setAppView("WORKSPACE");
                    setWorkspaceMode(view);
                  }
                }}
                style={{
                  border: "none",
                  borderLeft: view === "SPECIFICATION" ? "none" : "1px solid #3b4a63",
                  padding: "6px 14px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: blocked ? "not-allowed" : "pointer",
                  opacity: blocked ? 0.4 : 1,
                  backgroundColor: active ? "#3b82f6" : "#1e293b",
                  color: active ? "#ffffff" : "#9ca3af",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <Divider />

        {/* PROJECT SELECT & ACTIONS */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={pickerLabelStyle}>Project:</span>
          <select
            value={selectedProjectId}
            onChange={(e) => handleSelectProject(e.target.value)}
            style={selectStyle}
          >
            {projectsList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.prefix})
              </option>
            ))}
          </select>
          <PickerMenu
            label="Project actions"
            items={[
              ...(globalCan.hasProjectCreatePermission ? [{ label: "➕ New project", onSelect: () => openEntityModal("PROJECT", "CREATE") }] : []),
              ...(hasProjectCreatePermission
                ? [{ label: "✏️ Edit project", disabled: !selectedProjectId, onSelect: () => openEntityModal("PROJECT", "EDIT") }]
                : []),
              ...(hasProjectDeletePermission
                ? [{ label: "🗑️ Delete project", danger: true, disabled: !selectedProjectId, onSelect: handleDeleteProjectClick }]
                : []),
            ]}
          />
        </div>

        <Divider />

        {/* PLAN SELECT & ACTIONS */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={pickerLabelStyle}>Plan:</span>
          <select
            value={selectedPlanId}
            onChange={(e) => {
              // The last entry toggles archived plans; it never becomes the selection.
              if (e.target.value === TOGGLE_ARCHIVED_PLANS_VALUE) {
                setShowArchivedPlans((v) => !v);
                return;
              }
              handleSelectPlan(e.target.value);
            }}
            style={selectStyle}
          >
            {(() => {
              const current = plansList.filter((p) => p.status !== "ARCHIVED");
              const archived = plansList.filter((p) => p.status === "ARCHIVED");
              // An archived plan that's currently selected always stays visible, so the
              // select never shows a blank value.
              const archivedShown = showArchivedPlans
                ? archived
                : archived.filter((p) => p.id === selectedPlanId);
              return (
                <>
                  {current.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {/* ACTIVE is the normal state, so only LOCKED gets a suffix here. */}
                      {p.status && p.status !== "ACTIVE" ? ` [${p.status}]` : ""}
                    </option>
                  ))}
                  {archivedShown.length > 0 && (
                    <optgroup label="Archived">
                      {archivedShown.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {archived.length > 0 && (
                    <option value={TOGGLE_ARCHIVED_PLANS_VALUE} style={{ color: "#94a3b8", fontStyle: "italic" }}>
                      {showArchivedPlans ? "Hide archived plans" : `Show archived plans (${archived.length})`}
                    </option>
                  )}
                </>
              );
            })()}
          </select>
          <PickerMenu
            label="Plan actions"
            items={
              hasPlanManagePermission
                ? [
                    { label: "➕ New plan", onSelect: () => openEntityModal("PLAN", "CREATE") },
                    { label: "✏️ Edit plan", disabled: !selectedPlanId, onSelect: () => openEntityModal("PLAN", "EDIT") },
                    { label: "🗑️ Delete plan", danger: true, disabled: !selectedPlanId, onSelect: () => handleDeletePlanClick(selectedPlanId) },
                  ]
                : []
            }
          />
        </div>

        <Divider />

        {/* RUN SELECT & ACTIONS */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={pickerLabelStyle}>Run:</span>
          <select
            value={selectedRunId}
            onChange={(e) => handleSelectRun(e.target.value)}
            style={selectStyle}
          >
            {runsList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.status === "CLOSED" ? " [CLOSED]" : ""}
              </option>
            ))}
          </select>
          <PickerMenu
            label="Run actions"
            items={
              hasRunManagePermission
                ? [
                    {
                      label: "➕ New run",
                      onSelect: () => (selectedPlanId ? openEntityModal("RUN", "CREATE") : setNoPlanSetWarning(true)),
                    },
                    { label: "✏️ Edit run", disabled: !selectedRunId, onSelect: () => openEntityModal("RUN", "EDIT") },
                    { label: "🗑️ Delete run", danger: true, disabled: !selectedRunId, onSelect: () => handleDeleteRunClick(selectedRunId) },
                  ]
                : []
            }
          />
        </div>
      </div>

      {/* USER WIDGET & ADMIN PANEL */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" }}>
        {hasImportDataPermission && (
          <button
            onClick={() => setImportWizardOpen(true)}
            style={actionButtonStyle("#0ea5e9")}
          >
            📥 Import
          </button>
        )}
        {hasExportDataPermission && (
          <button
            onClick={() => setExportModalOpen(true)}
            style={actionButtonStyle("#0ea5e9")}
          >
            📤 Export
          </button>
        )}
        {hasAdminPanelAccess && (
          <button
            onClick={() => setAdminPanelOpen(true)}
            style={actionButtonStyle("#7c3aed")}
          >
            🛡️ Admin Panel
          </button>
        )}

        {/* USER PROFILE WIDGET */}
        {currentUser ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={() => setAuthModalOpen(true)}
              style={{
                backgroundColor: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "6px",
                padding: "5px 10px",
                color: "#f8fafc",
                fontSize: "12px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>
                👤 <strong>{currentUser.username}</strong>
              </span>
              <span
                style={{
                  backgroundColor:
                    currentUser.global_role === "Admin"
                      ? "#6d28d9"
                      : "#0284c7",
                  color: "#fff",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  fontSize: "10px",
                  fontWeight: 700,
                }}
              >
                {currentUser.global_role}
              </span>
            </button>
            <button
              onClick={handleLogout}
              style={{
                backgroundColor: "transparent",
                border: "1px solid #475569",
                color: "#94a3b8",
                padding: "5px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              Sign Out
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAuthModalOpen(true)}
            style={actionButtonStyle("#0284c7")}
          >
            🔑 Sign In
          </button>
        )}
      </div>
    </header>
  );
}

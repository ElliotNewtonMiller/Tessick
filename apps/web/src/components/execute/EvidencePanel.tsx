import { useRef } from "react";
import type { EvidenceItem } from "../../types";
import type { Evidence } from "../../hooks/useEvidence";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const KIND_ICON: Record<EvidenceItem["kind"], string> = { image: "🖼", video: "▶", log: "📄", trace: "🧭" };

const labelStyle = {
  fontSize: "11px",
  fontWeight: 600,
  color: "#6b7280",
  textTransform: "uppercase" as const,
};

/** One file: a thumbnail for an image, a tile for the rest; opens the viewer. */
function EvidenceTile({ item, onOpen, onDelete }: { item: EvidenceItem; onOpen: () => void; onDelete?: () => void }) {
  return (
    <div
      style={{ position: "relative", width: "96px", border: "1px solid #1f2937", borderRadius: "6px", backgroundColor: "#111827", overflow: "hidden" }}
      title={`${item.filename} · ${formatBytes(item.size_bytes)} · ${item.uploaded_by}${item.description ? `\n${item.description}` : ""}`}
    >
      <button
        onClick={onOpen}
        aria-label={`Open ${item.filename}`}
        style={{ display: "block", width: "100%", padding: 0, border: "none", background: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{ height: "64px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#0b1120", fontSize: "24px", color: "#9ca3af" }}>
          {item.kind === "image" ? (
            <img src={item.content_url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            KIND_ICON[item.kind]
          )}
        </div>
        <div style={{ padding: "4px 6px" }}>
          <div style={{ fontSize: "11px", color: "#e5e7eb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.filename}</div>
          <div style={{ fontSize: "10px", color: "#6b7280" }}>
            {item.kind} · {formatBytes(item.size_bytes)}
          </div>
        </div>
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          aria-label={`Delete ${item.filename}`}
          title="Delete"
          style={{ position: "absolute", top: "3px", right: "3px", width: "20px", height: "20px", padding: 0, borderRadius: "4px", border: "none", backgroundColor: "rgba(17,24,39,0.85)", color: "#fca5a5", fontSize: "12px", cursor: "pointer", lineHeight: "20px" }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The Evidence section under the notes in Execute mode: the active case's files in this run,
 * and adding more (the button, a drop on the pane, or a pasted screenshot). Disabled, with the
 * server's reason, until the case has a result, and when the run's window has passed.
 */
export function EvidencePanel({ evidence }: { evidence: Evidence }) {
  const { items, canAdd, loadError, uploads, addFiles, confirmDeleteId, setConfirmDeleteId, deleteEvidence, openViewer } = evidence;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const confirming = items.find((e) => e.id === confirmDeleteId) ?? null;

  return (
    <div style={{ marginTop: "20px" }} data-testid="evidence-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <span style={labelStyle}>Evidence{items.length > 0 ? ` (${items.length})` : ""}</span>
        <button
          onClick={() => (canAdd.allowed ? fileInputRef.current?.click() : undefined)}
          disabled={!canAdd.allowed}
          title={canAdd.allowed ? "Screenshots, videos, logs or Playwright traces. You can also drop files on the pane, or paste a screenshot (Ctrl+V)." : (canAdd.reason ?? undefined)}
          style={{
            padding: "4px 10px",
            backgroundColor: canAdd.allowed ? "#1f2937" : "transparent",
            border: "1px solid #374151",
            borderRadius: "4px",
            color: canAdd.allowed ? "#e5e7eb" : "#4b5563",
            fontSize: "12px",
            cursor: canAdd.allowed ? "pointer" : "not-allowed",
          }}
        >
          + Add files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,.log,.txt,.zip,text/plain"
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            addFiles(files);
          }}
        />
      </div>

      {confirming && (
        <div style={{ padding: "10px 12px", marginBottom: "8px", border: "1px solid #92400e", borderRadius: "6px", backgroundColor: "#78350f" }}>
          <div style={{ fontSize: "12px", color: "#fde68a", marginBottom: "8px", lineHeight: 1.4 }}>
            ⚠️ Delete <strong>{confirming.filename}</strong> ({formatBytes(confirming.size_bytes)})? It's gone for good; the deletion is recorded in the audit log.
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => setConfirmDeleteId(null)}
              style={{ padding: "5px 12px", backgroundColor: "#334155", border: "none", borderRadius: "4px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              Cancel
            </button>
            <button
              onClick={() => deleteEvidence(confirming)}
              style={{ padding: "5px 12px", backgroundColor: "#dc2626", border: "none", borderRadius: "4px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              Delete Anyway
            </button>
          </div>
        </div>
      )}

      {loadError ? (
        <div style={{ fontSize: "12px", color: "#fca5a5" }}>{loadError}</div>
      ) : items.length === 0 && uploads.length === 0 ? (
        <div style={{ fontSize: "12px", color: "#4b5563" }}>
          {canAdd.allowed ? "No evidence yet. Add files, drop them here, or paste a screenshot (Ctrl+V)." : canAdd.reason ?? "No evidence."}
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {items.map((item, i) => (
            <EvidenceTile key={item.id} item={item} onOpen={() => openViewer(i)} onDelete={item.can_delete ? () => setConfirmDeleteId(item.id) : undefined} />
          ))}
          {uploads.map((u) => (
            <div key={u.key} style={{ width: "96px", border: "1px dashed #374151", borderRadius: "6px", padding: "6px", boxSizing: "border-box" }} title={u.filename}>
              <div style={{ fontSize: "11px", color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: "6px" }}>{u.filename}</div>
              <div style={{ height: "4px", backgroundColor: "#1f2937", borderRadius: "2px", overflow: "hidden" }}>
                <div style={{ width: `${u.total ? Math.round((u.loaded / u.total) * 100) : 0}%`, height: "100%", backgroundColor: "#3b82f6" }} />
              </div>
              <div style={{ fontSize: "10px", color: "#6b7280", marginTop: "4px" }}>{u.total ? Math.round((u.loaded / u.total) * 100) : 0}%</div>
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && !canAdd.allowed && canAdd.reason && <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "6px" }}>{canAdd.reason}</div>}
    </div>
  );
}

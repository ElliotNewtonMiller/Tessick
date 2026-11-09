import { useEffect, useState } from "react";
import type { EvidenceItem } from "../../types";
import { api } from "../../api/routes";
import { authHeaders } from "../../utils/session";
import { formatBytes } from "./EvidencePanel";

const LOG_SHOWN_BYTES = 1024 * 1024;

interface EvidenceViewerProps {
  items: EvidenceItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/** A log's first 1 MB as text (a Range request; the rest is a download away). */
function LogText({ item }: { item: EvidenceItem }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailed(false);
    fetch(item.content_url, { headers: { ...authHeaders(), Range: `bytes=0-${LOG_SHOWN_BYTES - 1}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.text();
        if (!cancelled) setText(body);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [item.content_url]);
  if (failed) return <div style={{ color: "#fca5a5", fontSize: "13px" }}>The log couldn't be loaded.</div>;
  if (text === null) return <div style={{ color: "#9ca3af", fontSize: "13px" }}>Loading…</div>;
  return (
    // The full height of the viewer, scrolling inside it (centred, a long log would cover the header).
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: "6px", minHeight: 0 }}>
      <pre
        style={{
          margin: 0,
          minHeight: 0,
          padding: "12px",
          backgroundColor: "#030712",
          border: "1px solid #1f2937",
          borderRadius: "6px",
          color: "#d1d5db",
          fontSize: "12px",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "auto",
          flex: 1,
        }}
      >
        {text}
      </pre>
      {item.size_bytes > LOG_SHOWN_BYTES && (
        <div style={{ fontSize: "11px", color: "#fbbf24" }}>
          Showing the first 1 MB of {formatBytes(item.size_bytes)}. Download the file for all of it.
        </div>
      )}
    </div>
  );
}

/**
 * Evidence full size: an image, a video with controls, a log as text, or a trace to download
 * (Playwright opens traces). Esc closes; ← and → step through the case's other files.
 */
export function EvidenceViewer({ items, index, onIndex, onClose }: EvidenceViewerProps) {
  const item = items[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, items.length, onIndex, onClose]);
  if (!item) return null;

  const navButton = (label: string, to: number, enabled: boolean) => (
    <button
      onClick={() => enabled && onIndex(to)}
      disabled={!enabled}
      aria-label={label === "‹" ? "Previous file" : "Next file"}
      style={{
        background: "none",
        border: "1px solid #374151",
        borderRadius: "4px",
        color: enabled ? "#e5e7eb" : "#4b5563",
        padding: "2px 10px",
        fontSize: "16px",
        cursor: enabled ? "pointer" : "default",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Evidence: ${item.filename}`}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.8)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "#111827",
          border: "1px solid #374151",
          borderRadius: "8px",
          width: "min(1100px, 100%)",
          height: "min(820px, 100%)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", borderBottom: "1px solid #1f2937" }}>
          {items.length > 1 && navButton("‹", index - 1, index > 0)}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "#f9fafb", fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.filename}>
              {item.filename}
            </div>
            <div style={{ color: "#9ca3af", fontSize: "11px" }}>
              {item.kind} · {formatBytes(item.size_bytes)} · {item.uploaded_by}
              {item.uploaded_via !== "UI" ? ` via ${item.uploaded_via}` : ""} · {new Date(item.created_at).toLocaleString()}
              {item.after_close ? " · added after the run closed" : ""}
              {items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}
            </div>
          </div>
          {items.length > 1 && navButton("›", index + 1, index < items.length - 1)}
          <a
            href={api.evidenceContent(item.id, true)}
            download={item.filename}
            style={{ color: "#93c5fd", fontSize: "12px", textDecoration: "none", border: "1px solid #374151", borderRadius: "4px", padding: "4px 10px" }}
          >
            Download
          </a>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "#9ca3af", fontSize: "20px", cursor: "pointer" }}>
            ×
          </button>
        </div>
        {item.description && <div style={{ padding: "8px 14px", color: "#d1d5db", fontSize: "12px", borderBottom: "1px solid #1f2937" }}>{item.description}</div>}
        <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "14px", backgroundColor: "#0b1120" }}>
          {item.kind === "image" ? (
            <img src={item.content_url} alt={item.filename} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          ) : item.kind === "video" ? (
            <video key={item.id} src={item.content_url} controls autoPlay={false} style={{ maxWidth: "100%", maxHeight: "100%" }} />
          ) : item.kind === "log" ? (
            <LogText item={item} />
          ) : (
            <div style={{ color: "#d1d5db", fontSize: "13px", textAlign: "center", lineHeight: 1.7 }}>
              A Playwright trace: download it, then open it with
              <code style={{ display: "block", margin: "8px 0", color: "#a7f3d0" }}>npx playwright show-trace {item.filename}</code>
              or drop it on trace.playwright.dev.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

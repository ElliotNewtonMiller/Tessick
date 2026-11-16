import React, { useEffect, useState } from "react";
import { authHeaders } from "../utils/session";
import { errorMessage } from "../api/errors";
import { api } from "../api/routes";

interface TestLinkKey {
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * My Account: your TestLink API key, for scripts and tools written for TestLink's REST API.
 * They send it as the APIKEY header to Tessick's TestLink-compatible API (/lib/api/rest/...).
 * The key is shown once, when made; making a new one replaces the old.
 */
export function TestLinkKeySection() {
  const [key, setKey] = useState<TestLinkKey | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(api.myTestLinkKey, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setKey(d.testlink_key ?? null))
      .catch(() => setKey(null))
      .finally(() => setLoaded(true));
  }, []);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api.myTestLinkKey, { method: "POST", headers: authHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(errorMessage(d) || "Couldn't make the key");
      setKey(d.testlink_key);
      setPlaintext(d.plaintext);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api.myTestLinkKey, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) throw new Error(errorMessage(await res.json().catch(() => ({}))) || "Couldn't remove the key");
      setKey(null);
      setPlaintext(null);
      setConfirmRemove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const small: React.CSSProperties = { fontSize: "11px", color: "#94a3b8", lineHeight: 1.4 };
  const button: React.CSSProperties = {
    padding: "6px 10px",
    border: "1px solid #475569",
    borderRadius: "4px",
    backgroundColor: "#1e293b",
    color: "#e2e8f0",
    fontSize: "12px",
    cursor: busy ? "not-allowed" : "pointer",
  };

  return (
    <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #334155" }}>
      <div style={{ fontSize: "12px", color: "#cbd5e1", fontWeight: 600, marginBottom: "4px" }}>TestLink API key</div>
      <div style={{ ...small, marginBottom: "8px" }}>
        For scripts and tools written for TestLink's REST API: they send it as the <code>APIKEY</code> header to{" "}
        <code>/lib/api/rest/custom/…</code> on this server. It acts as you, with your permissions.
      </div>
      {!loaded ? null : plaintext ? (
        <div style={{ backgroundColor: "#052e16", border: "1px solid #166534", borderRadius: "4px", padding: "8px", marginBottom: "8px" }}>
          <div style={{ ...small, color: "#86efac", marginBottom: "4px" }}>Copy it now: it won't be shown again.</div>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <code style={{ fontSize: "12px", color: "#f8fafc", wordBreak: "break-all", flex: 1 }}>{plaintext}</code>
            <button type="button" style={button} onClick={() => navigator.clipboard?.writeText(plaintext)}>
              Copy
            </button>
          </div>
        </div>
      ) : key ? (
        <div style={{ ...small, marginBottom: "8px" }}>
          Key <code>{key.key_prefix}…</code>, made {new Date(key.created_at).toLocaleDateString()}
          {key.last_used_at ? `, last used ${new Date(key.last_used_at).toLocaleString()}` : ", never used"}.
        </div>
      ) : (
        <div style={{ ...small, marginBottom: "8px" }}>You have none.</div>
      )}
      {confirmRemove ? (
        <div style={{ backgroundColor: "#451a03", border: "1px solid #b45309", borderRadius: "4px", padding: "8px", color: "#fde68a", fontSize: "12px" }}>
          Scripts using this key stop working at once.
          <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
            <button type="button" style={{ ...button, borderColor: "#b45309", color: "#fde68a" }} disabled={busy} onClick={remove}>
              Remove Anyway
            </button>
            <button type="button" style={button} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "6px" }}>
          <button type="button" style={button} disabled={busy} onClick={make}>
            {key ? "Make a new key" : "Make a key"}
          </button>
          {key && (
            <button type="button" style={button} disabled={busy} onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
        </div>
      )}
      {key && !plaintext && !confirmRemove && <div style={{ ...small, marginTop: "6px" }}>A new key replaces this one.</div>}
      {error && <div style={{ fontSize: "12px", color: "#fca5a5", marginTop: "6px" }}>{error}</div>}
    </div>
  );
}

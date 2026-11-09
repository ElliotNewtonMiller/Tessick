import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceItem, TestCase } from "../types";
import { api, withQuery } from "../api/routes";
import { errorMessage } from "../api/errors";
import { authHeaders } from "../utils/session";

/** A file on its way up, shown with its progress until the list reloads. */
export interface EvidenceUpload {
  key: string;
  /** The execution it's for (run/case), so another case's uploads aren't shown here. */
  target: string;
  filename: string;
  loaded: number;
  total: number;
}

export interface EvidenceOptions {
  workspaceMode: "EXECUTION" | "SPECIFICATION";
  runId: string;
  /** OPEN or CLOSED: closing or reopening changes who may add and delete. */
  runStatus: string | undefined;
  activeCase: TestCase | null;
  /** Bumped by useExecution each time a result is recorded (the first one makes adding possible). */
  resultsRecorded: number;
  showToast: (msg: string) => void;
  onAuthExpired: () => void;
}

interface CanAdd {
  allowed: boolean;
  code: string | null;
  reason: string | null;
}

const NOT_YET: CanAdd = { allowed: false, code: null, reason: null };

/** One raw upload with progress (fetch can't report upload progress). */
function sendFile(url: string, file: File, onProgress: (loaded: number) => void): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (a proxy's error page): the status says enough.
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: null });
    xhr.send(file);
  });
}

/** A pasted screenshot is called "image.png" by every browser: give it a findable name. */
function pastedName(file: File): string {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}

/**
 * Execute mode: the active case's evidence in the selected run (screenshots, videos, logs,
 * Playwright traces), adding files (picked, dropped or pasted), deleting with a warning first,
 * and which file the viewer shows. Whether adding or deleting is allowed comes from the server
 * (`can_add`, `can_delete`), which applies the same rules as the upload and delete themselves.
 */
export function useEvidence({ workspaceMode, runId, runStatus, activeCase, resultsRecorded, showToast, onAuthExpired }: EvidenceOptions) {
  const caseId = workspaceMode === "EXECUTION" ? activeCase?.test_case_id ?? null : null;
  const target = runId && caseId ? `${runId}/${caseId}` : null;
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [canAdd, setCanAdd] = useState<CanAdd>(NOT_YET);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<EvidenceUpload[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The viewer: the list it steps through, and which one it shows (null = closed).
  const [viewer, setViewer] = useState<{ items: EvidenceItem[]; index: number } | null>(null);
  const loadSeqRef = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!runId || !caseId) return;
    try {
      const res = await fetch(api.runCaseEvidence(runId, caseId), { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (seq !== loadSeqRef.current) return;
      if (!res.ok) {
        setItems([]);
        setCanAdd(NOT_YET);
        setLoadError(errorMessage(data) || "The evidence couldn't be loaded.");
        return;
      }
      setItems(data.evidence ?? []);
      setCanAdd(data.can_add ?? NOT_YET);
      setLoadError(null);
    } catch {
      if (seq === loadSeqRef.current) setLoadError("The evidence couldn't be loaded.");
    }
  }, [runId, caseId]);

  // Another case or run: nothing of the last one may show while this one loads.
  useEffect(() => {
    loadSeqRef.current++;
    setItems([]);
    setCanAdd(NOT_YET);
    setLoadError(null);
    setConfirmDeleteId(null);
  }, [target]);

  useEffect(() => {
    load();
  }, [load, resultsRecorded, runStatus]);

  const addFiles = useCallback(
    async (files: File[], { pasted = false } = {}) => {
      if (!runId || !caseId || !target || files.length === 0) return;
      if (!canAdd.allowed) {
        showToast(canAdd.reason ?? "Evidence can't be added to this case now.");
        return;
      }
      const url = api.runCaseEvidence(runId, caseId);
      const problems: string[] = [];
      let duplicates = 0;
      await Promise.all(
        files.map(async (file) => {
          const name = pasted ? pastedName(file) : file.name;
          const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          setUploads((prev) => [...prev, { key, target, filename: name, loaded: 0, total: file.size }]);
          const res = await sendFile(withQuery(url, { filename: name }), file, (loaded) =>
            setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, loaded } : u))),
          );
          setUploads((prev) => prev.filter((u) => u.key !== key));
          if (res.status === 401) return onAuthExpired();
          if (res.status === 200 && res.body?.evidence?.every((e: EvidenceItem & { duplicate?: boolean }) => e.duplicate)) duplicates++;
          else if (res.status === 0) problems.push(`${name}: the server couldn't be reached`);
          else if (res.status >= 400) problems.push(`${name}: ${errorMessage(res.body) || `the server answered ${res.status}`}`);
        }),
      );
      if (problems.length) showToast(`Not added: ${problems.join("; ")}`);
      else if (duplicates) showToast(duplicates === files.length && files.length === 1 ? "That file is already here." : `${duplicates} of the files were already here.`);
      if (targetRef.current === target) load();
    },
    [runId, caseId, target, canAdd, showToast, onAuthExpired, load],
  );

  const deleteEvidence = useCallback(
    async (item: EvidenceItem) => {
      setConfirmDeleteId(null);
      try {
        const res = await fetch(api.evidence(item.id), { method: "DELETE", headers: authHeaders() });
        if (!res.ok && res.status !== 404) {
          showToast(errorMessage(await res.json().catch(() => ({}))) || `${item.filename} wasn't deleted.`);
          return;
        }
        showToast(`Deleted ${item.filename}.`);
      } catch {
        showToast("The server couldn't be reached.");
        return;
      }
      load();
    },
    [showToast, load],
  );

  // A screenshot pasted anywhere in Execute mode (Ctrl+V) is added to the active case. Text
  // pastes are left alone, so pasting into the notes or search box works as always.
  useEffect(() => {
    if (workspaceMode !== "EXECUTION" || !target || viewer) return;
    const onPaste = (e: ClipboardEvent) => {
      const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      e.preventDefault();
      addFiles(images, { pasted: true });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [workspaceMode, target, viewer, addFiles]);

  return {
    items,
    canAdd,
    loadError,
    uploads: uploads.filter((u) => u.target === target),
    addFiles,
    confirmDeleteId,
    setConfirmDeleteId,
    deleteEvidence,
    viewer,
    openViewer: (index: number) => setViewer({ items, index }),
    setViewer,
  };
}

export type Evidence = ReturnType<typeof useEvidence>;

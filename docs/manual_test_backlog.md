# Manual test backlog

Checks Elliot plans to do himself in the web app, kept here so they can be caught up on later (decided with Elliot, 2026-11-09: for the sake of progress, the agent verifies each change itself and records Elliot's checklist here rather than waiting for it).

Each entry says what the agent already checked, and how, so it's clear what a person's run adds: a real clipboard, file picker and drag from the desktop, other browsers, and how it looks and feels. Tick an item off (or delete it) once done; note anything that misbehaved in `docs/changelog.md` and fix it.

API and MCP changes aren't listed: the agent tests those itself.

## Evidence in the web app (2026-11-09)

Commits `cc48c79` (the Execute pane's Evidence section, the viewer, the Reports chip) and the audit log grouping after it. Sign in as `admin` / `password`, with a plan that has a run.

- [ ] **Before a result:** in Execute, the Evidence section says to record a result first, and **+ Add files** is disabled. Press **Fail**: it becomes enabled.
- [ ] **Paste a real screenshot:** take one with the OS screenshot tool and press Ctrl+V (with the notes box focused, and without). It appears as `screenshot-<time>.png`. A text paste into the notes still pastes text.
- [ ] **The file picker:** **+ Add files**, choose several files at once.
- [ ] **Drag from the file manager:** drop a video (MP4 or WebM) and a `.log` on the pane. The pane is outlined while dragging, and each upload shows its progress (a large video shows it best).
- [ ] **The viewer:** open the video and seek in it; → to the next file, ← back; Esc closes it, and so does a click outside. Press `p` while it's open: no verdict is recorded.
- [ ] **A long log:** it shows the first 1 MB, scrolling inside the viewer with the header still visible, and a note to download the rest. **Download** saves the whole file with its name.
- [ ] **Deleting:** × on a file shows the amber warning, then **Delete Anyway** removes it.
- [ ] **After Close Run:** you can still add files to a case you recorded (for 24 hours). A case with no result says the run is closed. Sign in as `tester` (`DevTest123!`): on a case the admin recorded, adding is disabled with the reason, and the × doesn't show.
- [ ] **Reports → Run:** a failed case with files shows 📎 and a count; click it to open the viewer.
- [ ] **Refused files:** try a PDF, and an `.exe` renamed to `.png`. Each is refused with a message naming the file.
- [ ] **Other browsers:** Firefox and Safari (or a phone): thumbnails, video playback and seeking, paste.
- [ ] **Admin Panel → Security Audit Log:** after a CI-style upload of several files (or several of your own within the hour), the additions show as one `EVIDENCE_ADDED ×n` line with their time span, kinds, size and first names. **×n ▸** lists each one; a single addition shows as its own line; deletions show one by one.

**Already checked by the agent** (live at `127.0.0.1:3000`, a separate tab, and in the smoke test):
- every item above with page events, not the real desktop: a paste event carrying a canvas PNG; one drop carrying a 4-second WebM recorded with MediaRecorder and a 1.7 MB log; a drop carrying a PDF and a disguised executable;
- video playback and seeking, the log viewer's layout (a bug found and fixed), Esc and ← →, `p` ignored while open, the two-step delete, the closed run's answers, the Reports chip, and the audit log's grouped line and its expansion.

**Not checked by the agent:** the real clipboard, file picker and desktop drag; browsers other than Chromium; how it looks at other window sizes.

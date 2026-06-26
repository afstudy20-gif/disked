# Disked Roadmap

This document tracks known architectural debt and planned features.

## Architectural improvements

### 1. Consolidate the duplicated backend

**Problem:** The disk scanning, deletion, smart-scan, and duplicate-finder logic is implemented twice: once in `server.js` (Express dev backend) and again in `src-tauri/src/lib.rs` (Tauri production backend). Every new filesystem feature has to be written in both JavaScript and Rust, which guarantees drift.

**Recommended direction:**
- Make Rust the single source of truth for all filesystem operations.
- Provide a small Rust CLI binary (`disked-core`) or JSON-RPC sidecar that the Express dev server can spawn and call.
- The Tauri app continues to invoke the same Rust code directly.
- Long-term, consider whether the Express dev server is still needed; the Tauri dev command already provides a webview with hot reload.

### 2. Streaming / bounded scans for very large drives

**Current state:** The scanner still walks the entire directory tree. Total size and top files need a full walk, but the in-memory `tree` map is the biggest memory consumer.

**Recommended next steps:**
- Split scanning into two phases: (1) a fast accounting pass that only tracks total size and top-N files, and (2) an optional detailed tree pass with strict bounds.
- Make `maxDepth` and `maxChildren` configurable in the UI rather than hard-coded defaults.
- Consider streaming tree nodes to the frontend in chunks instead of holding the whole map in memory.
- Add a `minSize` filter for the tree view so tiny files are counted toward totals but not rendered.

### 3. Undo / recovery

**Current state:** Deletions now move files to Trash, which is much safer than permanent deletion, but there is no in-app undo.

**Recommended approach:**
- Record each batch of moved items (original path, Trash path) in an operation log.
- Offer an "Undo last move" button that restores items from Trash back to their original locations.
- Note: system Trash paths vary by platform (`~/.Trash` on macOS, `Recycle Bin` on Windows, `~/.local/share/Trash` on Linux).

### 4. Scan history

**Idea:** Persist scan results to a local SQLite or JSON file so users can compare disk usage over time.

**Use cases:**
- "What grew since last week?"
- Trend charts in the UI
- Baseline before/after cleanup

### 5. Theme / appearance

**Current state:** The app ships with a single dark theme.

**Recommended improvement:**
- Define a complete light-theme variable set.
- Add a theme toggle and respect `prefers-color-scheme`.
- Audit hardcoded colors in components.

### 6. Additional features under consideration

- Duplicate file bulk deletion (select all but one with one click)
- Find empty folders
- Large folder heatmap / sunburst chart
- Scheduled cleanups
- Cloud-storage-aware scanning (skip synced placeholders)

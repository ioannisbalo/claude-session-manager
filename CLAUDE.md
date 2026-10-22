# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build       # TypeScript compile (composite) + copy HTML/CSS assets to dist/
npm start           # Build + launch Electron app
npm run watch       # Parallel TypeScript watchers for main + renderer (use with `electron .` in another terminal)
npm run test        # Run tests (vitest)
npm run test:watch  # Run tests in watch mode
```

Tests use Vitest. Test files are co-located with source (`src/*.test.ts`). No linting configured.

### Test structure

- `src/state-detector.test.ts` — StateDetector unit tests (ANSI stripping, pattern matching, state machine transitions, timer behavior)
- `src/app-state-logic.test.ts` — Pure logic tests for the task model: section partitioning and ordering, status transitions and the 24h done window, session attach/detach, saved-state versioning and the v1→v2 migration
- `src/session-manager.test.ts` — SessionManager tests with mocked PTY and TransitionLogger (buffer management, write guards, kill/cleanup, state detection integration)

`src/app-state-logic.ts` is the **single implementation** of the task/sidebar state logic, and the only part of the renderer path with tests. It is bundled by esbuild to `dist/src/renderer/app-state-logic.js` as the `TaskLogic` IIFE global; `src/renderer/appState.ts` holds thin wrappers over it plus the impure parts the pure module cannot own (pane layout, async session re-creation over IPC). Do not re-implement an algorithm in the renderer — a second copy is what Phase 2b removed.

### Debugging state detection

StateDetector logs all state transitions to a JSONL file. To find the log path, open DevTools in the app and run:

```js
await window.api.getLogPath()
```

Each line is a JSON object with `from`, `to`, `matchedPattern`, `trigger`, and `linesExamined`. To find misclassifications:

```bash
# Show all transitions (most recent last)
cat <logpath>/state-transitions.jsonl | jq -c '{session: .sessionName, from, to, pattern: .matchedPattern, trigger}'

# Find manual corrections (user clicked status dot to fix wrong state)
grep '"correction"' <logpath>/state-transitions.jsonl | jq .

# Find needs-input transitions to check for false positives
grep '"needs-input"' <logpath>/state-transitions.jsonl | jq '{session: .sessionName, pattern: .matchedPattern, lines: .linesExamined}'
```

When you find a misclassification, the `linesExamined` field shows the last 10 lines of output that were used for classification — use these as test fixtures in `state-detector.test.ts` to reproduce and fix the pattern.

## Architecture

Electron app with two TypeScript compilation targets (tsconfig.main.json for Node/main process, tsconfig.renderer.json for browser/renderer process). Renderer scripts load as plain `<script>` tags and are **not** modules. The one exception is `src/app-state-logic.ts`, which esbuild bundles into an IIFE exposing the `TaskLogic` global (`npm run bundle-state`), so the renderer can share the tested logic without importing it. The renderer target uses `module: "preserve"` (TypeScript 7 removed `module: "none"`); since no renderer file has a top-level `import`/`export`, each one still emits as a classic global script. Adding an `import` to a renderer file would emit untransformed ESM into a classic script and break it silently — keep renderer modules global.

### Main Process (main.ts, src/*.ts)

- **main.ts** — App entry point. Creates BrowserWindow, sets up IPC handlers, validates working directory paths, wires SessionManager events to renderer.
- **SessionManager** — Spawns `claude` CLI processes via `node-pty`. Each session has a PTY, rolling output buffer (512KB cap), and a StateDetector. Emits `output`, `state-change`, `exit` events.
- **StateDetector** — Heuristic state machine that infers Claude's state (`idle`/`working`/`needs-input`/`done`) from the rendered screen, not the raw byte stream: all PTY output feeds a headless xterm instance (`@xterm/headless`, scrollback 0), and the bottom ~10 screen rows are pattern-matched (working indicators like `esc to interrupt`/spinners first, then permission prompts, then `❯`/completion for idle). While in `working` it polls the screen every 1s — Claude Code repaints continuously even at a permission prompt, so waiting for quiet output would never classify. Transitions out of `working` need 2 consecutive agreeing reads (3 for the no-match idle fallback).
- **NotificationService** — Sends native macOS notifications when a non-focused session changes state. Clicking a notification switches to that session.

### Renderer Process (src/renderer/*.ts)

- **app.ts** — Session lifecycle UI. Manages sidebar rendering, session switching (with buffer replay), keyboard shortcuts (Cmd+N, Cmd+Arrow).
- **terminal.ts** — TerminalWrapper class around xterm.js. Catppuccin Mocha theme. Uses FitAddon + ResizeObserver for responsive sizing. On session switch, clears and replays the full buffer.
- **types.d.ts** — Global type declarations for xterm.js (loaded via script tag), ElectronAPI bridge, and session types.

### IPC Bridge (preload.ts)

Context-isolated bridge (`window.api`). Invoke channels: `session:create`, `session:kill`, `session:list`, `session:buffer`. Send channels: `session:input`, `session:resize`, `session:active`. Event channels from main: `session:output`, `session:state`, `session:exit`, `new-session`, `switch-session`.

## Key Design Decisions

- State detection is heuristic (screen parsing via headless terminal emulation), not message-based. Claude Code draws its TUI with cursor positioning rather than newlines, so regexing the raw stream cannot recover line structure — patterns must run against emulated screen rows.
- Renderer uses no bundler except for the one `TaskLogic` bundle. Script load order in index.html matters: xterm.js → addon-fit.js → addon-web-links.js → layoutTree.js → terminal.js → paneManager.js → **app-state-logic.js** → appState.js → app.js.
- The renderer's files share globals with no `import` edges, so `tsc` has no dependency graph for them: editing one can leave a dependent's cached result stale and the build will report success on code that cannot compile. `npm run build` therefore uses `tsc --build --force` (a full rebuild is ~0.4s).
- `src/renderer/types.d.ts` declares the `TaskLogic` shape by hand, since the renderer cannot import. If it drifts from the module, `tsc` fails at a call site — a deliberate trade to avoid duplicating logic.
- User-typed text (task titles, session names) is set via `textContent`, never interpolated into `innerHTML`: a `<` would swallow the rest of the row and the following `querySelector` calls would return null.
- The renderer has **no tests**. Its gate is `npm run build` plus running the app.
- Session buffers are replayed on switch, so scrollback is preserved across tab changes.

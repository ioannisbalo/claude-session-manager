# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build       # TypeScript compile (composite) + copy HTML/CSS assets to dist/
npm start           # Build + launch Electron app
npm run watch       # Parallel TypeScript watchers for main + renderer (use with `electron .` in another terminal)
```

There are no tests or linting configured.

## Architecture

Electron app with two TypeScript compilation targets (tsconfig.main.json for Node/main process, tsconfig.renderer.json for browser/renderer process). Renderer scripts are **not bundled** — they load as plain `<script>` tags via `module: "none"`.

### Main Process (main.ts, src/*.ts)

- **main.ts** — App entry point. Creates BrowserWindow, sets up IPC handlers, validates working directory paths, wires SessionManager events to renderer.
- **SessionManager** — Spawns `claude` CLI processes via `node-pty`. Each session has a PTY, rolling output buffer (512KB cap), and a StateDetector. Emits `output`, `state-change`, `exit` events.
- **StateDetector** — Heuristic state machine that parses raw PTY output to infer Claude's state (`idle`/`working`/`needs-input`/`done`). Strips ANSI escape sequences, then pattern-matches prompt characters (`❯` for idle, y/n/accept/deny patterns for needs-input). Has a 200ms settle delay and a 3s stale-working fallback.
- **NotificationService** — Sends native macOS notifications when a non-focused session changes state. Clicking a notification switches to that session.

### Renderer Process (src/renderer/*.ts)

- **app.ts** — Session lifecycle UI. Manages sidebar rendering, session switching (with buffer replay), keyboard shortcuts (Cmd+N, Cmd+Arrow).
- **terminal.ts** — TerminalWrapper class around xterm.js. Catppuccin Mocha theme. Uses FitAddon + ResizeObserver for responsive sizing. On session switch, clears and replays the full buffer.
- **types.d.ts** — Global type declarations for xterm.js (loaded via script tag), ElectronAPI bridge, and session types.

### IPC Bridge (preload.ts)

Context-isolated bridge (`window.api`). Invoke channels: `session:create`, `session:kill`, `session:list`, `session:buffer`. Send channels: `session:input`, `session:resize`, `session:active`. Event channels from main: `session:output`, `session:state`, `session:exit`, `new-session`, `switch-session`.

## Key Design Decisions

- Sessions spawn real PTY processes, so IDE integrations (e.g., IntelliJ plugin) work transparently.
- State detection is heuristic (output parsing), not message-based — ANSI stripping quality directly affects state accuracy.
- Renderer uses no bundler. Script load order in index.html matters: xterm.js → addon-fit.js → terminal.js → app.js.
- Session buffers are replayed on switch, so scrollback is preserved across tab changes.
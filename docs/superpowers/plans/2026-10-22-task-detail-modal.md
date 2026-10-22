# Task Detail Modal (Phase 2d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One modal that creates and edits tasks, carrying description, type, repos and links.

**Architecture:** Five tasks. Task 1 widens the pure model and is fully tested. Task 2 adds the one new IPC channel the modal needs. Tasks 3–5 build the modal in the renderer, which has no tests by design: create mode first (replacing the inline `+`), then the repos/links lists, then edit mode (retiring the inline task rename). Each task leaves a working app.

**Tech Stack:** TypeScript 7.0.2 (strict), Vitest 5.0.5, esbuild 0.28.2, Electron 44. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-task-detail-modal-design.md`

## Global Constraints

- Pure logic lives **only** in `src/app-state-logic.ts`, bundled as the `TaskLogic` global. The renderer reaches it through wrappers in `src/renderer/appState.ts` and never re-implements an algorithm.
- Every shape the renderer uses must be mirrored in `src/renderer/types.d.ts`, including additions to the `TaskLogic` declaration.
- No `Date.now()` inside `src/app-state-logic.ts`; time is an injected `now: number`.
- User-typed text is set via `textContent`, never interpolated into `innerHTML`.
- Type values are exactly `feature | bug | chore | review | spike`, labelled Feature, Bug, Chore, Review, Spike. Untyped is the default.
- The new `Task` fields are optional and **no `SAVED_STATE_VERSION` bump is allowed** — existing v2 files must load unchanged.
- Build is `npm run build`; tests are `npm test`. The renderer has no tests: its gate is a clean build plus a manual run.
- Single-user tool: hardcode, do not generalize.

## Review Focus

Failure modes the spec implies that the obvious tests would miss. Each has a test assigned to the task that owns the code.

1. **A whitespace-only title must not create a task.** The gate is the modal's disabled Save (Task 3, verified by hand); `createTask`'s "New task" fallback is the last line of defence behind it and is pinned in Task 1 so nobody deletes it as unused.
2. **A task saved before this phase must open in the modal without throwing** — `description`, `type`, `repos` and `links` are all absent, and the list renderers must treat absent as empty. Task 1 (defaulting) and Task 4 (rendering).
3. **`Esc` in edit mode must discard the edits, not the task.** Task 5.
4. **`Enter` in the description must insert a newline**, not save — the save-and-reopen shortcut is bound to the title field only. Task 3.
5. **A link that is not `http`/`https` must not appear to work.** The `open-url` handler silently ignores it, so the UI must reject it at entry rather than storing a dead row. Task 4.

---

### Task 1: Task fields in the pure model

**Files:**
- Modify: `src/app-state-logic.ts`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskStatus`, `AppState`, `createTask`, `toTask` (the migration normaliser)
- Produces: `export type TaskType = 'feature' | 'bug' | 'chore' | 'review' | 'spike'`; `Task` gains optional `description?: string`, `type?: TaskType`, `repos?: string[]`, `links?: string[]`; `createTask(state, title, status, now, fields?: TaskFields): Task` where `export interface TaskFields { description?: string; type?: TaskType; repos?: string[]; links?: string[] }`

- [ ] **Step 1: Write the failing tests**

In the existing `createTask` describe block:

```typescript
it('stores the optional fields when given', () => {
  const state = createState();
  const task = createTask(state, 'Fix retry', 'backlog', 1, {
    description: 'See the thread',
    type: 'bug',
    repos: ['/a', '/b'],
    links: ['https://example.com/1'],
  });
  expect(task.description).toBe('See the thread');
  expect(task.type).toBe('bug');
  expect(task.repos).toEqual(['/a', '/b']);
  expect(task.links).toEqual(['https://example.com/1']);
});

it('still falls back to "New task" for a blank title', () => {
  // The modal disables Save on a blank title, so this is defence in depth —
  // pinned so it is not removed as dead code.
  expect(createTask(createState(), '   ', 'backlog', 1).title).toBe('New task');
});

it('omits the optional fields entirely when not given', () => {
  const task = createTask(createState(), 'Bare', 'backlog', 1);
  expect('description' in task).toBe(false);
  expect('type' in task).toBe(false);
  expect('repos' in task).toBe(false);
  expect('links' in task).toBe(false);
});
```

In the `migrateSavedState` describe block — Review Focus #2:

```typescript
it('loads a task saved before the optional fields existed', () => {
  const pre2d = {
    version: 2, sessions: [], taskCounter: 1,
    tasks: [{ id: 't1', title: 'Old', status: 'doing', sessionIds: [], collapsed: false, createdAt: 5 }],
  };
  const task = migrateSavedState(pre2d, 9000).tasks[0];
  expect(task.title).toBe('Old');
  expect(task.repos ?? []).toEqual([]);
  expect(task.links ?? []).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createTask` takes four arguments, so the fields are dropped.

- [ ] **Step 3: Add `TaskType`, `TaskFields` and the optional `Task` fields, and widen `createTask` to the signature in Interfaces**

Assign each optional field only when the caller supplied it, so a bare task has no empty keys — the second test pins this. Extend `toTask` to carry the four fields through, defaulting `repos`/`links` to absent rather than `[]` so a pre-2d file round-trips unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "feat: add description, type, repos and links to Task"
```

---

### Task 2: `dialog:pick-directory` IPC channel

Today's directory picker is welded to `session:create`, which spawns a process with the chosen path. Repos need a picker that only returns a path.

**Files:**
- Modify: `main.ts` (beside the `open-url` handler at `:205`), `preload.ts`, `src/renderer/types.d.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `window.api.pickDirectory(): Promise<string | null>` — resolves to an absolute path, or `null` if the dialog was cancelled

- [ ] **Step 1: Add the main-process handler**

`ipcMain.handle('dialog:pick-directory', …)` using `dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a repository for this task' })`. Return `path.resolve` of the first path, or `null` when cancelled or empty. Unlike `session:create` this does **not** apply the `riskyPaths` check — nothing is spawned, and a task may legitimately reference any directory.

- [ ] **Step 2: Expose it on the bridge**

Add `pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory')` to the `contextBridge` object in `preload.ts`, and the matching line to `interface ElectronAPI` in `src/renderer/types.d.ts`.

- [ ] **Step 3: Verify it compiles**

Run: `npm run build && npm test`
Expected: build clean, all tests pass (nothing calls it yet).

- [ ] **Step 4: Commit**

```bash
git add main.ts preload.ts src/renderer/types.d.ts
git commit -m "feat: add a directory picker that does not create a session"
```

---

### Task 3: The modal shell and create mode

After this task the section `+` opens the modal instead of creating a row inline, and title/description/type are saved. Repos and links arrive in Task 4, edit mode in Task 5.

**Files:**
- Modify: `src/renderer/index.html` (markup before `</body>`), `src/renderer/styles.css`, `src/renderer/app.ts` (the `+` handler at `:370`), `src/renderer/appState.ts`
- No tests: renderer

**Interfaces:**
- Consumes: `createTask` from Task 1
- Produces: renderer-local `openTaskModal(mode: 'create' | 'edit', context: TaskStatus | Task): void` and `closeTaskModal(): void`; the markup ids `#task-modal`, `#task-modal-title`, `#task-modal-description`, `#task-modal-type`, `#task-modal-save`, `#task-modal-cancel`

- [ ] **Step 1: Add the modal markup**

A `#task-modal` overlay before `</body>`, hidden by default, containing the title input, description textarea, a type `<select>` whose options are exactly the five values from Global Constraints plus an empty default labelled "No type", and Save/Cancel buttons.

- [ ] **Step 2: Style it**

A centred panel over a dimmed backdrop. Scope every rule to `#task-modal` so it cannot collide with the sidebar rules — note `#session-list li` already outranked a bare class once in this project.

- [ ] **Step 3: Implement open/close and the keyboard contract**

`openTaskModal` fills the fields (empty in create mode), shows the overlay and focuses the title. Save is disabled while the title is blank or whitespace-only.

Bind, per the spec:
- `Enter` in the **title field only**: save, then clear the fields and keep the modal open, focused on the title
- `Cmd+Enter` anywhere: save and close
- `Esc`, Cancel, or a backdrop click: close without saving
- `Enter` in the description inserts a newline — Review Focus #4, so do not bind a global `keydown` submit

- [ ] **Step 4: Replace the inline `+` handler**

At `src/renderer/app.ts:370`, replace the body that calls `addTask` + `startTaskRename` with `openTaskModal('create', createIn)`. Keep the `expandBacklog()` call so a backlog task saved from the modal is visible. Saving calls `createTask` with the modal's values, then `renderSidebar()` and `scheduleSave()`.

- [ ] **Step 5: Verify by hand**

Run: `npm run build && npm test`, then `npm start`.
Confirm: `+` on Doing and on Backlog opens the modal with the title focused; Save is dead until the title has non-space text; `Enter` saves and leaves the modal open for the next one; `Cmd+Enter` saves and closes; `Esc` and the backdrop close without creating anything; `Enter` in the description adds a newline; the task appears in the right section with its description and type stored.

- [ ] **Step 6: Commit**

```bash
git add src/renderer
git commit -m "feat: create tasks through a modal instead of an inline input"
```

---

### Task 4: Repos and links

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/app.ts`
- No tests: renderer

**Interfaces:**
- Consumes: `window.api.pickDirectory` (Task 2), `openTaskModal` (Task 3)
- Produces: the ids `#task-modal-repos`, `#task-modal-links`; renderer-local `renderModalList(kind: 'repos' | 'links'): void`

- [ ] **Step 1: Add both lists to the markup and style them**

Each is a `<ul>` plus an "Add…" button. Entries render their value with a `×` to remove.

- [ ] **Step 2: Implement the list state and `renderModalList`**

Hold the two arrays in modal-local state, seeded on open (absent means empty — Review Focus #2). Entry text goes in via `textContent`. Order is insertion order; neither list deduplicates.

- [ ] **Step 3: Wire "Add…"**

Repos: call `window.api.pickDirectory()` and append the result unless it is `null`. Links: reveal an inline text input where `Enter` appends and `Esc` cancels.

- [ ] **Step 4: Reject links that cannot open — Review Focus #5**

`open-url` in main silently ignores anything that is not `http://` or `https://`, so a stored `ftp://` row would look saved and do nothing on click. Reject at entry: a value failing that prefix check is not appended, and the input is marked invalid rather than cleared.

- [ ] **Step 5: Make link entries clickable**

Clicking a link entry's text calls `window.api.openUrl(value)`. The `×` must not
open it — stop propagation there. Repo entries are not clickable: nothing reads
them until Phase 3.

- [ ] **Step 6: Save them with the task**

Pass both arrays to `createTask` via `TaskFields`, omitting an array that is empty so a bare task stays bare.

- [ ] **Step 7: Verify by hand**

Run: `npm run build && npm test`, then `npm start`.
Confirm: "Add…" on repos opens a directory picker and **does not start a session**; cancelling it adds nothing; a link typed with `Enter` appears and `ftp://x` is refused; `×` removes an entry; the same repo can be added twice; saving stores both; reopening a task created before this task shows empty lists rather than throwing;
clicking a link opens it in the browser and clicking its `×` does not.

- [ ] **Step 8: Commit**

```bash
git add src/renderer
git commit -m "feat: add repos and links to the task modal"
```

---

### Task 5: Edit mode, retiring the inline task rename

**Files:**
- Modify: `src/renderer/app.ts` (`createTaskHeaderLi`'s `✎` handler), `src/renderer/appState.ts`
- No tests: renderer

**Interfaces:**
- Consumes: `openTaskModal` (Task 3), the list state (Task 4)
- Produces: no new exports; `startTaskRename` is deleted

- [ ] **Step 1: Fill the modal from an existing task**

`openTaskModal('edit', task)` seeds every field from the task. Saving mutates that task in place and must leave `status`, `collapsed`, `createdAt`, `completedAt` and `sessionIds` untouched — the spec names all five.

- [ ] **Step 2: Change `Enter` behaviour in edit mode — the spec's one divergence**

In edit mode `Enter` in the title saves and **closes**; there is no next task to capture. `Cmd+Enter` and `Esc` are unchanged.

- [ ] **Step 3: Point `✎` at the modal and delete `startTaskRename`**

The `✎` handler in `createTaskHeaderLi` calls `openTaskModal('edit', task)`. Delete `startTaskRename`. Leave `startRenameInput` and the `renameInProgress` guard in place — session rename still uses both.

- [ ] **Step 4: Verify by hand — including Review Focus #3**

Run: `npm run build && npm test`, then `npm start`.
Confirm: `✎` opens the modal populated; saving updates the row and leaves the task in its section with its sessions attached; **`Esc` after editing the title discards the edits and leaves the task otherwise intact**; a task created before Phase 2d opens with empty description, no type and empty lists; a restart restores everything.

- [ ] **Step 5: Commit**

```bash
git add src/renderer
git commit -m "feat: edit tasks through the modal, retiring the inline rename"
```

---

## Done when

- `npm run build` clean and `npm test` green
- `grep -rn "startTaskRename" src/` returns nothing
- A task can be created with all five fields, reopened, edited, and survives a restart
- A state file written before Phase 2d loads and its tasks open in the modal

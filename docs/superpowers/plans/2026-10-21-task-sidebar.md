# Task Sidebar (Phase 2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the task list the thing you look at: four status sections, derived ordering, and one-click status changes.

**Architecture:** Five tasks. The first two add pure, tested logic (`createTask`/`deleteTask`, then `partitionSidebar`). The next two rewrite the renderer against that logic, which stops reading `sidebarOrder`. The last deletes `sidebarOrder` once nothing reads it — the deletion comes last so every task leaves a working app.

**Tech Stack:** TypeScript 7.0.2 (strict), Vitest 5.0.5, esbuild 0.28.2, Electron 44. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-task-sidebar-design.md`

## Global Constraints

- Pure logic lives **only** in `src/app-state-logic.ts`. It is bundled to `TaskLogic` and the renderer reaches it through the thin wrappers in `src/renderer/appState.ts`. Never re-implement an algorithm in the renderer — that is the duplication Phase 2b removed.
- Every ambient shape the renderer uses must be mirrored in `src/renderer/types.d.ts`, including the `TaskLogic` declaration. A missing entry is a compile error, not a runtime bug.
- No `Date.now()` inside `src/app-state-logic.ts`. Time is always an injected `now: number`.
- The renderer has no tests by design. Its gate is `npm run build` plus a manual run.
- Build is `npm run build` (uses `tsc --build --force`); tests are `npm test`.
- Single-user tool: hardcode, do not generalize. No config options or extension points.
- Conventional commit messages.

## Review Focus

Failure modes the spec implies that the obvious tests would miss. Each has a test assigned to the task that owns the code.

1. **Deleting a task whose sessions are live must orphan them, never kill them.** The sessions keep running and become loose. Covered in Task 1.
2. **Attaching a session that already belongs to another task must move it, not duplicate it** — otherwise it renders under two tasks and `getVisibleSessionOrder` returns it twice. Covered in Task 5.
3. **A `done` task that still has live sessions must not disappear when its 24h window lapses.** Hiding it would strand running sessions with no way to reach them. Covered in Task 2 — see the spec gap below.
4. **Cmd+Arrow navigation must still reach a collapsed section's sessions.** Collapse is presentation only. Covered in Task 5.
5. **Two tasks created in the same millisecond must order deterministically**, not arbitrarily — `Date.now()` collides easily on quick successive creates. Covered in Task 2.

## Spec gap resolved in this plan

The spec defines the Done section as `status === 'done' && isTaskVisible(task, now)`. Taken literally, a done task whose 24h window lapses while it still holds a live Claude session vanishes from every section — and because "loose" means *belongs to no task*, its sessions are not loose either. They would keep running, unreachable from the sidebar and from Cmd+Arrow.

**Resolution:** a done task stays visible while it has live sessions, regardless of the window:

```
done = status === 'done' && (isTaskVisible(task, now) || hasLiveSessions(task))
```

This keeps the Done strip clean in the normal case and makes stranding impossible. Flagged for the spec to be amended.

---

### Task 1: `createTask` and `deleteTask`

**Files:**
- Modify: `src/app-state-logic.ts`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskStatus`, `AppState` from the existing module
- Produces: `createTask(state: AppState, title: string, status: TaskStatus, now: number): Task`, `deleteTask(state: AppState, taskId: string): void`

- [ ] **Step 1: Write the failing tests**

```typescript
  describe('createTask', () => {
    it('registers a task with a generated id and the given status', () => {
      const state = createState({ taskCounter: 4 });

      const task = createTask(state, 'Fix webhook retry', 'backlog', 1234);

      expect(task).toEqual({
        id: 'task-5',
        title: 'Fix webhook retry',
        status: 'backlog',
        sessionIds: [],
        collapsed: false,
        createdAt: 1234,
      });
      expect(state.tasks.get('task-5')).toBe(task);
      expect(state.taskCounter).toBe(5);
    });

    it('trims the title and falls back when it is blank', () => {
      const state = createState();
      expect(createTask(state, '  spaced  ', 'doing', 0).title).toBe('spaced');
      expect(createTask(state, '   ', 'doing', 0).title).toBe('New task');
    });
  });

  describe('deleteTask', () => {
    it('removes the task and orphans its sessions rather than killing them', () => {
      const state = createState();
      const task = createTask(state, 'Doomed', 'doing', 0);
      task.sessionIds = ['s1', 's2'];

      deleteTask(state, task.id);

      expect(state.tasks.has(task.id)).toBe(false);
      // The sessions themselves are untouched — nothing in this module can
      // kill a session, and the renderer must not either.
      expect(getTaskForSession(state.tasks, 's1')).toBeUndefined();
      expect(getTaskForSession(state.tasks, 's2')).toBeUndefined();
    });

    it('is a no-op for an unknown id', () => {
      const state = createState();
      expect(() => deleteTask(state, 'nope')).not.toThrow();
    });
  });
```

Add `createTask` and `deleteTask` to the test file's import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with "createTask is not a function".

- [ ] **Step 3: Implement**

Add to `src/app-state-logic.ts`, after `setTaskStatus`:

```typescript
/**
 * Create a task and register it. Tasks are created empty — sessions are
 * attached afterwards, which is what makes a task a todo item rather than a
 * container for sessions that already exist.
 */
export function createTask(state: AppState, title: string, status: TaskStatus, now: number): Task {
  state.taskCounter++;
  const trimmed = title.trim();
  const task: Task = {
    id: `task-${state.taskCounter}`,
    title: trimmed === '' ? 'New task' : trimmed,
    status,
    sessionIds: [],
    collapsed: false,
    createdAt: now,
  };
  state.tasks.set(task.id, task);
  return task;
}

/**
 * Delete a task. Its sessions are orphaned, not killed: "loose" means
 * belonging to no task, so dropping the task is all that is required. Killing
 * a session stays an explicit, separate act.
 */
export function deleteTask(state: AppState, taskId: string): void {
  state.tasks.delete(taskId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "feat: add createTask and deleteTask"
```

---

### Task 2: `partitionSidebar`

**Files:**
- Modify: `src/app-state-logic.ts`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: `createTask`, `setTaskStatus`, `isTaskVisible`, `Task`, `AppState`
- Produces: `interface SidebarSections { doing: Task[]; backlog: Task[]; done: Task[]; loose: string[] }` and `partitionSidebar(state: AppState, liveSessionIds: Set<string>, now: number): SidebarSections`

- [ ] **Step 1: Write the failing tests**

```typescript
  describe('partitionSidebar', () => {
    function stateWith(specs: Array<[string, TaskStatus, number, string[]]>): AppState {
      const state = createState();
      for (const [title, status, createdAt, sessionIds] of specs) {
        const task = createTask(state, title, status, createdAt);
        task.sessionIds = sessionIds;
      }
      return state;
    }

    it('splits tasks by status and orders doing/backlog oldest first', () => {
      const state = stateWith([
        ['newer doing', 'doing', 200, []],
        ['older doing', 'doing', 100, []],
        ['backlog b', 'backlog', 400, []],
        ['backlog a', 'backlog', 300, []],
      ]);

      const result = partitionSidebar(state, new Set(), 1000);

      expect(result.doing.map(t => t.title)).toEqual(['older doing', 'newer doing']);
      expect(result.backlog.map(t => t.title)).toEqual(['backlog a', 'backlog b']);
    });

    it('orders done by completedAt, most recently closed first', () => {
      const state = createState();
      const first = createTask(state, 'closed first', 'doing', 0);
      const second = createTask(state, 'closed second', 'doing', 0);
      setTaskStatus(first, 'done', 100);
      setTaskStatus(second, 'done', 200);

      const result = partitionSidebar(state, new Set(), 300);

      expect(result.done.map(t => t.title)).toEqual(['closed second', 'closed first']);
    });

    it('drops a done task once its 24h window lapses', () => {
      const state = createState();
      const task = createTask(state, 'old news', 'doing', 0);
      setTaskStatus(task, 'done', 0);

      expect(partitionSidebar(state, new Set(), DONE_VISIBILITY_MS).done).toHaveLength(1);
      expect(partitionSidebar(state, new Set(), DONE_VISIBILITY_MS + 1).done).toHaveLength(0);
    });

    it('keeps a lapsed done task visible while it still has live sessions', () => {
      const state = createState();
      const task = createTask(state, 'done but busy', 'doing', 0);
      task.sessionIds = ['s1'];
      setTaskStatus(task, 'done', 0);

      const live = new Set(['s1']);
      const result = partitionSidebar(state, live, DONE_VISIBILITY_MS + 1);

      // Hiding it would strand s1: it is in a task, so it is not loose either.
      expect(result.done.map(t => t.title)).toEqual(['done but busy']);
      expect(result.loose).toEqual([]);
    });

    it('reports sessions belonging to no task as loose', () => {
      const state = stateWith([['owns s1', 'doing', 0, ['s1']]]);

      const result = partitionSidebar(state, new Set(['s1', 's2', 's3']), 100);

      expect(result.loose).toEqual(['s2', 's3']);
    });

    it('orders tasks created in the same millisecond deterministically', () => {
      const state = stateWith([
        ['a', 'backlog', 500, []],
        ['b', 'backlog', 500, []],
        ['c', 'backlog', 500, []],
      ]);

      const once = partitionSidebar(state, new Set(), 1000).backlog.map(t => t.id);
      const twice = partitionSidebar(state, new Set(), 1000).backlog.map(t => t.id);

      expect(once).toEqual(twice);
      expect(once).toEqual(['task-1', 'task-2', 'task-3']);
    });
  });
```

Add `partitionSidebar` to the test file's import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with "partitionSidebar is not a function".

- [ ] **Step 3: Implement**

```typescript
export interface SidebarSections {
  doing: Task[];
  backlog: Task[];
  done: Task[];
  /** Live session ids belonging to no task. */
  loose: string[];
}

/** Oldest first, with a stable tie-break — Date.now() collides on quick creates. */
function byCreatedAsc(a: Task, b: Task): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** Most recently closed first. */
function byCompletedDesc(a: Task, b: Task): number {
  return (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.id.localeCompare(b.id);
}

/**
 * Split state into the four sidebar sections, already ordered. The ordering
 * rules live here rather than in render code so they are testable.
 */
export function partitionSidebar(
  state: AppState,
  liveSessionIds: Set<string>,
  now: number,
): SidebarSections {
  const doing: Task[] = [];
  const backlog: Task[] = [];
  const done: Task[] = [];
  const owned = new Set<string>();

  for (const task of state.tasks.values()) {
    for (const sid of task.sessionIds) owned.add(sid);

    if (task.status === 'doing') {
      doing.push(task);
    } else if (task.status === 'backlog') {
      backlog.push(task);
    } else {
      // A done task whose window has lapsed still shows while it holds live
      // sessions — hiding it would strand them, since a session inside a task
      // is not loose and would be reachable from nowhere.
      const hasLive = task.sessionIds.some(sid => liveSessionIds.has(sid));
      if (isTaskVisible(task, now) || hasLive) done.push(task);
    }
  }

  return {
    doing: doing.sort(byCreatedAsc),
    backlog: backlog.sort(byCreatedAsc),
    done: done.sort(byCompletedDesc),
    loose: Array.from(liveSessionIds).filter(sid => !owned.has(sid)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "feat: add partitionSidebar with derived section ordering"
```

---

### Task 3: Render the four sections

Replaces `renderSidebar`'s walk over `sidebarOrder` with a walk over `partitionSidebar`. After this task the app shows sections and the status buttons work; creation and deletion arrive in Task 4.

**Files:**
- Modify: `src/renderer/appState.ts` (wrappers), `src/renderer/types.d.ts` (ambient shapes), `src/renderer/app.ts` (`renderSidebar`), `src/renderer/styles.css` (section + button styles)

**Interfaces:**
- Consumes: `partitionSidebar`, `setTaskStatus` from `TaskLogic`
- Produces: renderer-local `sidebarSections(): SidebarSections` and `advanceTaskStatus(task: Task): void`

- [ ] **Step 1: Declare the new shapes for the renderer**

In `src/renderer/types.d.ts`, add to the task-model block:

```typescript
interface SidebarSections {
  doing: Task[];
  backlog: Task[];
  done: Task[];
  loose: string[];
}
```

and add to the `declare const TaskLogic` object:

```typescript
  createTask(state: AppState, title: string, status: TaskStatus, now: number): Task;
  deleteTask(state: AppState, taskId: string): void;
  partitionSidebar(state: AppState, liveSessionIds: Set<string>, now: number): SidebarSections;
```

- [ ] **Step 2: Add the renderer wrappers**

In `src/renderer/appState.ts`, after `getVisibleSessionOrder`:

```typescript
/**
 * Backlog starts collapsed on every launch — the spec calls it "a backlog, not
 * a work surface". Deliberately not persisted: resetting to collapsed each
 * launch *is* the desired default.
 */
let backlogCollapsed = true;

function toggleBacklogCollapsed(): void {
  backlogCollapsed = !backlogCollapsed;
}

function sidebarSections(): SidebarSections {
  return TaskLogic.partitionSidebar(appState, liveSessionIds(), Date.now());
}

/** The contextual status button: backlog → doing → done → doing. */
function advanceTaskStatus(task: Task): void {
  const next: TaskStatus = task.status === 'backlog' ? 'doing'
    : task.status === 'doing' ? 'done'
    : 'doing';
  TaskLogic.setTaskStatus(task, next, Date.now());
}
```

- [ ] **Step 3: Rewrite `renderSidebar`**

Replace the body of `renderSidebar` in `src/renderer/app.ts` (the `for (const entry of appState.sidebarOrder)` loop and everything it builds) with a section walk. Keep `createSessionLi` and the existing drag handlers as they are.

```typescript
  function renderSidebar(): void {
    if (dragInProgress) return;

    const renameBtn = document.getElementById('rename-session-btn')!;
    renameBtn.style.display = activeSessionId ? 'inline-block' : 'none';

    const list = document.getElementById('session-list')!;
    list.innerHTML = '';

    const sections = sidebarSections();

    appendSection(list, 'Doing', sections.doing, 'doing', false);
    appendSection(list, 'Backlog', sections.backlog, 'backlog', backlogCollapsed);
    if (sections.done.length > 0) appendSection(list, 'Done', sections.done, 'done', false);

    if (sections.loose.length > 0) {
      list.appendChild(sectionHeader('Loose sessions', sections.loose.length, null));
      for (const id of sections.loose) {
        const session = sessions.get(id);
        if (session) list.appendChild(createSessionLi(id, session, false));
      }
    }
  }

  /** Section header row. `createIn` is the status a `+` here would create. */
  function sectionHeader(label: string, count: number, createIn: TaskStatus | null): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'sidebar-section-header';
    li.innerHTML = `
      <span class="section-label">${label}</span>
      <span class="section-count">${count > 0 ? count : ''}</span>
    `;
    // Only Backlog collapses; appendSection attaches the handler.
    if (createIn) {
      const add = document.createElement('button');
      add.className = 'section-add-btn';
      add.title = `New ${label.toLowerCase()} task`;
      add.textContent = '+';
      li.appendChild(add);
    }
    return li;
  }

  const STATUS_BUTTON: Record<TaskStatus, { glyph: string; title: string }> = {
    backlog: { glyph: '▶', title: 'Pick up' },
    doing: { glyph: '✓', title: 'Mark done' },
    done: { glyph: '↺', title: 'Reopen' },
  };

  function appendSection(
    list: HTMLElement,
    label: string,
    tasks: Task[],
    status: TaskStatus,
    collapsed: boolean,
  ): void {
    const header = sectionHeader(label, tasks.length, status);
    if (status === 'backlog') {
      header.classList.add('collapsible');
      header.addEventListener('click', (e: MouseEvent) => {
        if ((e.target as HTMLElement).classList.contains('section-add-btn')) return;
        toggleBacklogCollapsed();
        renderSidebar();
      });
    }
    list.appendChild(header);
    if (collapsed) return;
    for (const task of tasks) {
      list.appendChild(createTaskHeaderLi(task));
      if (task.collapsed) continue;
      for (const sid of task.sessionIds) {
        const session = sessions.get(sid);
        if (session) list.appendChild(createSessionLi(sid, session, true));
      }
    }
  }
```

- [ ] **Step 4: Build the task row**

Add `createTaskHeaderLi`, adapted from the group header this replaces. The status button is always visible; rename and delete are hover-only via CSS.

```typescript
  function createTaskHeaderLi(task: Task): HTMLLIElement {
    const header = document.createElement('li');
    header.className = 'session-group-header';
    header.dataset.taskId = task.id;

    const btn = STATUS_BUTTON[task.status];
    header.innerHTML = `
      <span class="group-collapse-icon">${task.collapsed ? '▸' : '▾'}</span>
      <span class="group-name">${task.title}</span>
      <button class="task-status-btn" title="${btn.title}">${btn.glyph}</button>
      <button class="group-rename-btn" title="Rename task">✎</button>
      <span class="group-count">${task.sessionIds.length || ''}</span>
    `;

    (header.querySelector('.task-status-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      advanceTaskStatus(task);
      renderSidebar();
      scheduleSave();
    });

    (header.querySelector('.group-rename-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      startTaskRename(task, header.querySelector('.group-name') as HTMLSpanElement);
    });

    header.addEventListener('click', (e: MouseEvent) => {
      const cls = (e.target as HTMLElement).classList;
      if (cls.contains('group-rename-btn') || cls.contains('task-status-btn')) return;
      if (cls.contains('session-rename-input')) return;
      task.collapsed = !task.collapsed;
      renderSidebar();
      scheduleSave();
    });

    return header;
  }
```

- [ ] **Step 5: Style the sections**

Append to `src/renderer/styles.css`:

```css
/* Sidebar sections (Doing / Backlog / Done / Loose) */
.sidebar-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted, #7f849c);
  cursor: default;
}

.sidebar-section-header .section-label { flex: 1; }
.sidebar-section-header.collapsible { cursor: pointer; }
.sidebar-section-header.collapsible:hover { color: var(--text, #cdd6f4); }
.sidebar-section-header .section-count { opacity: 0.7; }

.section-add-btn,
.task-status-btn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0 4px;
  font-size: 12px;
}

.section-add-btn:hover,
.task-status-btn:hover { color: var(--accent); }

/* Rename and delete stay out of the way until the row is hovered. */
.session-group-header .group-rename-btn { visibility: hidden; }
.session-group-header:hover .group-rename-btn { visibility: visible; }
```

- [ ] **Step 6: Build and verify by hand**

Run: `npm run build && npm test`
Expected: build clean, all tests pass (no renderer tests exist).

Then run `npm start` and confirm: existing tasks appear under **Doing** (migration gives them `status: 'doing'`), the `✓` moves one to **Done**, the `↺` in Done returns it to Doing, per-task collapse still works, **Backlog starts collapsed and its header toggles it**, and sessions with no task appear under **Loose sessions**.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app.ts src/renderer/appState.ts src/renderer/types.d.ts src/renderer/styles.css
git commit -m "feat: render the sidebar as status sections"
```

---

### Task 4: Create, delete, and attach sessions

**Files:**
- Modify: `src/renderer/app.ts`, `src/renderer/appState.ts`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: `createTask`, `deleteTask` from `TaskLogic`; `sectionHeader`, `createTaskHeaderLi`, `startRenameInput` from Task 3
- Produces: renderer-local `addTask(status: TaskStatus): Task`, `removeTask(taskId: string): void`, `attachSessionToTask(sessionId: string, taskId: string): void`

- [ ] **Step 1: Add the wrappers**

In `src/renderer/appState.ts`:

```typescript
function addTask(status: TaskStatus): Task {
  return TaskLogic.createTask(appState, '', status, Date.now());
}

function removeTask(taskId: string): void {
  TaskLogic.deleteTask(appState, taskId);
}

/** Attach a session to a task, moving it off any task it already belongs to. */
function attachSessionToTask(sessionId: string, taskId: string): void {
  TaskLogic.handleDrop(appState, liveSessionIds(), sessionId, taskId, 'merge', true, Date.now());
}
```

`attachSessionToTask` wraps `handleDrop` for now; Task 5 renames the underlying function and only this wrapper body changes.

- [ ] **Step 2: Wire the section `+` to an inline input**

In `sectionHeader`, replace the `add.textContent = '+';` block's surroundings so the button has a handler:

```typescript
    if (createIn) {
      const add = document.createElement('button');
      add.className = 'section-add-btn';
      add.title = `New ${label.toLowerCase()} task`;
      add.textContent = '+';
      add.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        const task = addTask(createIn);
        renderSidebar();
        // Immediately open the new row's title for editing, so creating a task
        // is: click +, type, Enter.
        const row = document.querySelector(`[data-task-id="${task.id}"] .group-name`) as HTMLSpanElement | null;
        if (row) startTaskRename(task, row);
        scheduleSave();
      });
      li.appendChild(add);
    }
```

- [ ] **Step 3: Add delete and `+ session` to the task row**

In `createTaskHeaderLi`, extend the markup and add the handlers:

```typescript
      <button class="task-status-btn" title="${btn.title}">${btn.glyph}</button>
      <button class="task-session-btn" title="New session for this task">⊞</button>
      <button class="group-rename-btn" title="Rename task">✎</button>
      <button class="task-delete-btn" title="Delete task (sessions are kept)">&times;</button>
      <span class="group-count">${task.sessionIds.length || ''}</span>
```

```typescript
    (header.querySelector('.task-delete-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      removeTask(task.id);
      renderSidebar();
      scheduleSave();
    });

    (header.querySelector('.task-session-btn') as HTMLElement).addEventListener('click', async (e: MouseEvent) => {
      e.stopPropagation();
      const session = await window.api.createSession();
      if (!session) return;
      sessions.set(session.id, session);
      attachSessionToTask(session.id, task.id);
      renderSidebar();
      scheduleSave();
    });
```

Extend the guard in the row's own click handler so the new buttons do not toggle collapse:

```typescript
      if (cls.contains('group-rename-btn') || cls.contains('task-status-btn')) return;
      if (cls.contains('task-delete-btn') || cls.contains('task-session-btn')) return;
```

- [ ] **Step 4: Style the new buttons as hover-only**

In `src/renderer/styles.css`, extend the hover rule written in Task 3:

```css
.session-group-header .group-rename-btn,
.session-group-header .task-delete-btn,
.session-group-header .task-session-btn { visibility: hidden; }

.session-group-header:hover .group-rename-btn,
.session-group-header:hover .task-delete-btn,
.session-group-header:hover .task-session-btn { visibility: visible; }

.task-delete-btn,
.task-session-btn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0 4px;
  font-size: 12px;
}

.task-delete-btn:hover { color: var(--red, #f38ba8); }
.task-session-btn:hover { color: var(--accent); }
```

- [ ] **Step 5: Build and verify by hand**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

Then run `npm start` and confirm: `+` on Backlog creates a row whose title is immediately editable, Enter commits and Esc leaves it as "New task"; `⊞` opens the directory picker and the new session appears nested under that task; `×` removes the task and **its sessions reappear under Loose sessions, still running**; and the app restores all of this after a restart.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app.ts src/renderer/appState.ts src/renderer/styles.css
git commit -m "feat: create, delete and populate tasks from the sidebar"
```

---

### Task 5: Delete `sidebarOrder`

Nothing renders from it now. This removes it from the model, the migration and the drag handlers.

**Files:**
- Modify: `src/app-state-logic.ts`, `src/renderer/types.d.ts`, `src/renderer/appState.ts`, `src/renderer/app.ts`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: `partitionSidebar` from Task 2
- Produces: `detachSession(state: AppState, sessionId: string): void`, `attachSessionToTask(state: AppState, sessionId: string, taskId: string): void`, and `getVisibleSessionOrder(state: AppState, sessionIds: Set<string>): string[]` now derived from sections. `AppState` becomes `{ tasks, taskCounter }`; `SavedState` loses `sidebarOrder`; `SidebarEntry` is deleted.

- [ ] **Step 1: Write the failing tests**

```typescript
  describe('attachSessionToTask', () => {
    it('moves a session off the task it already belongs to', () => {
      const state = createState();
      const from = createTask(state, 'from', 'doing', 0);
      const to = createTask(state, 'to', 'doing', 1);
      from.sessionIds = ['s1'];

      attachSessionToTask(state, 's1', to.id);

      expect(from.sessionIds).toEqual([]);
      expect(to.sessionIds).toEqual(['s1']);
      // Appearing under two tasks would also duplicate it in navigation.
      expect(getVisibleSessionOrder(state, new Set(['s1']))).toEqual(['s1']);
    });

    it('is a no-op when the session is already on that task', () => {
      const state = createState();
      const task = createTask(state, 'task', 'doing', 0);
      task.sessionIds = ['s1'];

      attachSessionToTask(state, 's1', task.id);

      expect(task.sessionIds).toEqual(['s1']);
    });
  });

  describe('getVisibleSessionOrder (derived)', () => {
    it('walks doing, then backlog, then done, then loose', () => {
      const state = createState();
      const doing = createTask(state, 'doing', 'doing', 0);
      const backlog = createTask(state, 'backlog', 'backlog', 0);
      const done = createTask(state, 'done', 'doing', 0);
      doing.sessionIds = ['d1'];
      backlog.sessionIds = ['b1'];
      done.sessionIds = ['x1'];
      setTaskStatus(done, 'done', 0);

      const live = new Set(['d1', 'b1', 'x1', 'loose1']);

      expect(getVisibleSessionOrder(state, live)).toEqual(['d1', 'b1', 'x1', 'loose1']);
    });

    it('still reaches a collapsed task\\'s sessions — collapse is presentation only', () => {
      const state = createState();
      const task = createTask(state, 'collapsed', 'backlog', 0);
      task.sessionIds = ['s1'];
      task.collapsed = true;

      expect(getVisibleSessionOrder(state, new Set(['s1']))).toEqual(['s1']);
    });

    it('omits dead sessions', () => {
      const state = createState();
      const task = createTask(state, 'task', 'doing', 0);
      task.sessionIds = ['alive', 'dead'];

      expect(getVisibleSessionOrder(state, new Set(['alive']))).toEqual(['alive']);
    });
  });
```

Update the test file: remove `sidebarOrder` from `createState`, drop every `sidebarOrder` key from `SavedState` literals and every `{ type: 'task'|'session' }` assertion, and replace `removeSidebarEntry`/`handleDrop` in the imports with `detachSession`/`attachSessionToTask`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with "attachSessionToTask is not a function".

- [ ] **Step 3: Reshape the types**

In `src/app-state-logic.ts`, delete the `SidebarEntry` type and remove `sidebarOrder` from both interfaces:

```typescript
export interface SavedState {
  version: number;
  sessions: Array<{ id: string; name: string; cwd: string }>;
  tasks: Task[];
  taskCounter: number;
  layout?: unknown;
}

export interface AppState {
  tasks: Map<string, Task>;
  taskCounter: number;
}
```

- [ ] **Step 4: Replace the three functions**

```typescript
/** Remove a session from whatever task holds it. It becomes loose. */
export function detachSession(state: AppState, sessionId: string): void {
  const task = getTaskForSession(state.tasks, sessionId);
  if (task) {
    task.sessionIds = task.sessionIds.filter(id => id !== sessionId);
  }
}

/** Attach a session to a task, moving it off any task it already belongs to. */
export function attachSessionToTask(state: AppState, sessionId: string, taskId: string): void {
  const target = state.tasks.get(taskId);
  if (!target) return;
  if (target.sessionIds.includes(sessionId)) return;
  detachSession(state, sessionId);
  target.sessionIds.push(sessionId);
}

/**
 * Session order for Cmd+Arrow navigation, derived from the sections. Collapse
 * is presentation only, so a collapsed task's sessions stay reachable.
 */
export function getVisibleSessionOrder(state: AppState, sessionIds: Set<string>): string[] {
  const sections = partitionSidebar(state, sessionIds, Number.MAX_SAFE_INTEGER);
  const result: string[] = [];
  for (const task of [...sections.doing, ...sections.backlog, ...sections.done]) {
    for (const sid of task.sessionIds) {
      if (sessionIds.has(sid)) result.push(sid);
    }
  }
  return [...result, ...sections.loose];
}
```

`Number.MAX_SAFE_INTEGER` is deliberate: navigation must reach every task's sessions, including a done task whose display window has lapsed.

Then delete `handleDrop` and `removeSidebarEntry` entirely, and strip `sidebarOrder` from `buildSavedState`, `reconstructFromSaved` (which loses its sidebar rebuild and back-fill loop) and `migrateSavedState` (drop `toSidebarEntry` and the `sidebarOrder` field).

- [ ] **Step 5: Update the renderer**

In `src/renderer/types.d.ts`: delete `SidebarEntry`, remove `sidebarOrder` from `AppState` and `SavedState`, and in `TaskLogic` replace `removeSidebarEntry`/`handleDrop` with:

```typescript
  detachSession(state: AppState, sessionId: string): void;
  attachSessionToTask(state: AppState, sessionId: string, taskId: string): void;
```

In `src/renderer/appState.ts`: drop `sidebarOrder` from the `appState` literal and from `restoreState`'s assignments, rename the `removeSidebarEntry` wrapper to `detachSession`, and point the `attachSessionToTask` wrapper at the new function:

```typescript
function attachSessionToTask(sessionId: string, taskId: string): void {
  TaskLogic.attachSessionToTask(appState, sessionId, taskId);
}
```

In `src/renderer/app.ts`: rename `removeSidebarEntry(` calls to `detachSession(`, delete the now-unused `handleDrop` wrapper and `getDropZone`, and change the session and task drop handlers to call `attachSessionToTask(draggedId, task.id)` — a drop on a task attaches, and there are no above/below zones. Remove `drop-target-above` and `drop-target-below` class toggles.

- [ ] **Step 6: Run the tests and build**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 7: Verify by hand**

Run `npm start` and confirm: dragging a session onto a task attaches it and removes it from its previous task, Cmd+Up/Down walks sessions in section order, a collapsed task's sessions are still reachable, and a restart restores everything.

- [ ] **Step 8: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts src/renderer
git commit -m "refactor: delete sidebarOrder in favour of derived sections"
```

---

## Done when

- `npm run build` clean and `npm test` green
- `grep -r sidebarOrder src/` returns nothing
- The sidebar shows Doing / Backlog / Done / Loose; `+` creates, `×` deletes without killing sessions, `▶`/`✓`/`↺` move a task between states
- A restart restores tasks, their sessions and the pane layout

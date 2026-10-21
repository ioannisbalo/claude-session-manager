# Task Model Inversion (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ephemeral `SessionGroup` into a durable `Task` in the tested state module, so a task can exist with zero sessions.

**Architecture:** Four sequential tasks against one source file and its test file. Task 1 is a behaviour-preserving rename that adds the new fields. Task 2 performs the actual lifetime inversion by deleting the disband rules. Task 3 adds status transitions and the derived 24h visibility rule. Task 4 versions the saved state and adds the v1→v2 migration. The running Electron app is untouched throughout and keeps working on its own copy of this logic in `src/renderer/appState.ts`.

**Tech Stack:** TypeScript 7.0.2 (strict), Vitest 5.0.5, Node 22. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-task-centric-architecture-design.md`

## Global Constraints

- **Only two files may be modified:** `src/app-state-logic.ts` and `src/app-state-logic.test.ts`. Touching `src/renderer/appState.ts`, `src/renderer/app.ts` or any other file is out of scope for this plan.
- The running app must keep working unchanged after every task. It loads `src/renderer/appState.ts`, which this plan does not touch.
- Single-user tool: hardcode, do not generalize. No config options, no extension points, no abstraction layers.
- All functions stay pure — no DOM, no `window.api`, no globals, no `Date.now()` inside logic. Time is always an injected `now: number` parameter.
- Run tests with `npm test`. Run the build with `npm run build`.
- Conventional commit messages, matching the existing history (`feat:`, `refactor:`, `fix:`).

## Review Focus

These are the failure modes the spec implies that the obvious tests would miss. Each has a test assigned to the task that owns the code.

1. **Zero- and single-session tasks flowing through code that previously could never see them.** Before this change the disband rule guaranteed every group held ≥2 sessions; `getVisibleSessionOrder`, `removeSidebarEntry` and `handleDrop` were all written under that assumption. Covered in Task 2.
2. **A `done` task with no `completedAt`.** Spec says treat as visible rather than silently vanishing. Covered in Task 3.
3. **Migration run on already-migrated (v2) state.** Must be idempotent and must not re-wrap or corrupt. Covered in Task 4.
4. **Migration of malformed or partial saved state** — a hand-edited or half-written file with missing arrays. Must not throw. Covered in Task 4.
5. **`completedAt` in the future (clock skew, restored backup).** `now - completedAt` goes negative; the task must stay visible rather than disappear. Covered in Task 3.

---

### Task 1: Rename `SessionGroup` to `Task`, behaviour unchanged

Mechanical rename plus the new fields. The disband rule stays in place for now — Task 2 removes it. After this task the test suite must pass with no behavioural change.

**Files:**
- Modify: `src/app-state-logic.ts` (whole file)
- Test: `src/app-state-logic.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `Task`, `TaskStatus`, `AppState` (`{ tasks, sidebarOrder, taskCounter }`), `SavedState` (`{ sessions, tasks, sidebarOrder, taskCounter }`), `SidebarEntry` (`{type:'session'|'task', id}`), `getTaskForSession(tasks, sessionId)`, `pruneDeadSessions(state, sessionIds)`, `getVisibleSessionOrder(state, sessionIds)`, `removeSidebarEntry(state, sessionId)`, `buildSavedState(sessions, state)`, `reconstructFromSaved(saved, idMap)`, `handleDrop(state, sessionIds, draggedId, targetId, zone, targetIsTask)`

- [ ] **Step 1: Update the types at the top of `src/app-state-logic.ts`**

Replace the `SessionGroup`, `SidebarEntry`, `SavedState` and `AppState` declarations with:

```typescript
export type TaskStatus = 'backlog' | 'doing' | 'done';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
  completedAt?: number;
}

export interface SessionData {
  id: string;
  name: string;
  cwd: string;
}

export type SidebarEntry = { type: 'session'; id: string } | { type: 'task'; id: string };

export interface SavedState {
  sessions: Array<{ id: string; name: string; cwd: string }>;
  tasks: Task[];
  sidebarOrder: SidebarEntry[];
  taskCounter: number;
}

export interface AppState {
  tasks: Map<string, Task>;
  sidebarOrder: SidebarEntry[];
  taskCounter: number;
}
```

- [ ] **Step 2: Rename through the rest of the file**

Apply consistently, leaving all logic intact:

- `getGroupForSession` → `getTaskForSession`; parameter `groups: Map<string, SessionGroup>` → `tasks: Map<string, Task>`
- `enforceGroupIntegrity` → `pruneDeadSessions` (keep the disband branch for now)
- `state.groups` → `state.tasks`, `state.groupCounter` → `state.taskCounter`
- `{ type: 'group' }` → `{ type: 'task' }` everywhere
- In `buildSavedState`, `groups: savedGroups` → `tasks: Array.from(state.tasks.values())`
- In `reconstructFromSaved`, iterate `saved.tasks`, carry `title`, `status`, `createdAt` and `completedAt` through unchanged
- `handleDrop`'s last parameter `targetIsGroup` → `targetIsTask`

In `handleDrop`, the merge branch that creates a new container becomes:

```typescript
state.taskCounter++;
const newTask: Task = {
  id: `task-${state.taskCounter}`,
  title: 'New task',
  status: 'doing',
  sessionIds: [targetId, draggedId],
  collapsed: false,
  createdAt: 0,
};
state.tasks.set(newTask.id, newTask);
```

`createdAt: 0` is a deliberate placeholder — `handleDrop` is pure and has no clock. Task 3 adds the `now` parameter that fills it.

- [ ] **Step 3: Update the test file's helpers and imports**

```typescript
import {
  AppState,
  Task,
  SavedState,
  SessionData,
  pruneDeadSessions,
  getVisibleSessionOrder,
  removeSidebarEntry,
  getTaskForSession,
  buildSavedState,
  reconstructFromSaved,
  handleDrop,
} from './app-state-logic';

function createState(overrides?: Partial<AppState>): AppState {
  return {
    tasks: overrides?.tasks ?? new Map(),
    sidebarOrder: overrides?.sidebarOrder ?? [],
    taskCounter: overrides?.taskCounter ?? 0,
  };
}

function makeTask(id: string, sessionIds: string[], title?: string): Task {
  return {
    id,
    title: title ?? id,
    status: 'doing',
    sessionIds,
    collapsed: false,
    createdAt: 0,
  };
}
```

Then rename every usage in the existing tests: `makeGroup` → `makeTask`, `groups:` → `tasks:`, `groupCounter:` → `taskCounter:`, `type: 'group'` → `type: 'task'`, `enforceGroupIntegrity` → `pruneDeadSessions`, `getGroupForSession` → `getTaskForSession`, and `saved.groups` → `saved.tasks`. Rename the `describe` blocks to match the new function names. Do not change any assertion's meaning.

- [ ] **Step 4: Run the build and the tests**

Run: `npm run build && npm test`
Expected: build clean, all 152 tests pass. If any assertion changed meaning, revert it — this task is a rename only.

- [ ] **Step 5: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "refactor: rename SessionGroup to Task with task fields"
```

---

### Task 2: Invert the lifetime — delete both disband rules

The architectural change. A task with zero sessions becomes legal, which is what turns it from a window decoration into a todo item.

**Files:**
- Modify: `src/app-state-logic.ts` — `pruneDeadSessions`, `reconstructFromSaved`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced
- Produces: no signature changes; `pruneDeadSessions` and `reconstructFromSaved` now preserve tasks of any size

- [ ] **Step 1: Write the failing tests**

Add to the `pruneDeadSessions` describe block:

```typescript
it('keeps a task whose sessions have all died', () => {
  const task = makeTask('t1', ['s1', 's2']);
  const state = createState({
    tasks: new Map([['t1', task]]),
    sidebarOrder: [{ type: 'task', id: 't1' }],
  });

  pruneDeadSessions(state, new Set());

  expect(state.tasks.get('t1')).toBeDefined();
  expect(state.tasks.get('t1')!.sessionIds).toEqual([]);
  expect(state.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
});

it('keeps a task down to a single session without unwrapping it', () => {
  const task = makeTask('t1', ['s1', 's2']);
  const state = createState({
    tasks: new Map([['t1', task]]),
    sidebarOrder: [{ type: 'task', id: 't1' }],
  });

  pruneDeadSessions(state, new Set(['s1']));

  expect(state.tasks.get('t1')!.sessionIds).toEqual(['s1']);
  expect(state.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
});
```

Add to the `reconstructFromSaved` describe block:

```typescript
it('restores a task whose sessions are all gone', () => {
  const saved: SavedState = {
    sessions: [],
    tasks: [makeTask('t1', ['old1', 'old2'])],
    sidebarOrder: [{ type: 'task', id: 't1' }],
    taskCounter: 1,
  };

  const result = reconstructFromSaved(saved, new Map());

  expect(result.tasks.get('t1')).toBeDefined();
  expect(result.tasks.get('t1')!.sessionIds).toEqual([]);
  expect(result.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
});

it('restores a task with a single surviving session as a task, not a loose session', () => {
  const saved: SavedState = {
    sessions: [],
    tasks: [makeTask('t1', ['old1', 'old2'])],
    sidebarOrder: [{ type: 'task', id: 't1' }],
    taskCounter: 1,
  };

  const result = reconstructFromSaved(saved, new Map([['old1', 'new1']]));

  expect(result.tasks.get('t1')!.sessionIds).toEqual(['new1']);
  expect(result.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
});
```

Add a new describe block covering Review Focus item 1 — the states that were previously unreachable:

```typescript
describe('zero- and single-session tasks (previously impossible)', () => {
  it('getVisibleSessionOrder skips an empty task without error', () => {
    const state = createState({
      tasks: new Map([['t1', makeTask('t1', [])]]),
      sidebarOrder: [{ type: 'task', id: 't1' }, { type: 'session', id: 's9' }],
    });

    expect(getVisibleSessionOrder(state, new Set(['s9']))).toEqual(['s9']);
  });

  it('removeSidebarEntry empties a single-session task without removing the task', () => {
    const state = createState({
      tasks: new Map([['t1', makeTask('t1', ['s1'])]]),
      sidebarOrder: [{ type: 'task', id: 't1' }],
    });

    removeSidebarEntry(state, 's1');

    expect(state.tasks.get('t1')!.sessionIds).toEqual([]);
    expect(state.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
  });

  it('handleDrop can merge a session into an empty task', () => {
    const state = createState({
      tasks: new Map([['t1', makeTask('t1', [])]]),
      sidebarOrder: [{ type: 'task', id: 't1' }, { type: 'session', id: 's1' }],
    });

    handleDrop(state, new Set(['s1']), 's1', 't1', 'merge', true);

    expect(state.tasks.get('t1')!.sessionIds).toEqual(['s1']);
    expect(state.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the new tests fail — tasks are deleted or unwrapped because the disband rules still run.

- [ ] **Step 3: Delete the disband rule in `pruneDeadSessions`**

The function keeps only the pruning:

```typescript
/**
 * Remove dead sessions from tasks. Tasks survive at any size, including zero —
 * a task is durable and exists independently of its sessions.
 */
export function pruneDeadSessions(state: AppState, sessionIds: Set<string>): void {
  for (const task of state.tasks.values()) {
    task.sessionIds = task.sessionIds.filter(id => sessionIds.has(id));
  }
}
```

- [ ] **Step 4: Delete the disband rule in `reconstructFromSaved`**

Drop the `remappedIds.length >= 2` guard so every saved task is restored:

```typescript
for (const savedTask of saved.tasks) {
  const remappedIds = savedTask.sessionIds
    .map(id => idMap.get(id))
    .filter((id): id is string => id !== undefined);
  tasks.set(savedTask.id, { ...savedTask, sessionIds: remappedIds });
}
```

Then simplify the sidebar rebuild — the disband-fallback branch that scattered surviving members as loose sessions is now dead code, because a task entry always resolves:

```typescript
for (const entry of saved.sidebarOrder) {
  if (entry.type === 'session') {
    const newId = idMap.get(entry.id);
    if (newId) sidebarOrder.push({ type: 'session', id: newId });
  } else if (tasks.has(entry.id)) {
    sidebarOrder.push({ type: 'task', id: entry.id });
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && npm test`
Expected: all pass, including the new ones.

- [ ] **Step 6: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "feat: make tasks durable independently of their sessions"
```

---

### Task 3: Status transitions and the 24h visibility rule

**Files:**
- Modify: `src/app-state-logic.ts` — add two functions and a constant; add `now` to `handleDrop`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskStatus` from Task 1
- Produces: `DONE_VISIBILITY_MS: number`, `setTaskStatus(task: Task, status: TaskStatus, now: number): void`, `isTaskVisible(task: Task, now: number): boolean`, and `handleDrop(..., targetIsTask: boolean, now: number)`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('setTaskStatus', () => {
  it('stamps completedAt when a task becomes done', () => {
    const task = makeTask('t1', ['s1']);
    setTaskStatus(task, 'done', 1000);
    expect(task.status).toBe('done');
    expect(task.completedAt).toBe(1000);
  });

  it('clears completedAt when a done task is reopened', () => {
    const task = makeTask('t1', ['s1']);
    setTaskStatus(task, 'done', 1000);
    setTaskStatus(task, 'doing', 2000);
    expect(task.status).toBe('doing');
    expect(task.completedAt).toBeUndefined();
  });

  it('does not re-stamp completedAt when already done', () => {
    const task = makeTask('t1', ['s1']);
    setTaskStatus(task, 'done', 1000);
    setTaskStatus(task, 'done', 5000);
    expect(task.completedAt).toBe(1000);
  });
});

describe('isTaskVisible', () => {
  it('always shows backlog and doing tasks', () => {
    const backlog = { ...makeTask('t1', []), status: 'backlog' as const };
    const doing = makeTask('t2', []);
    expect(isTaskVisible(backlog, 10 ** 12)).toBe(true);
    expect(isTaskVisible(doing, 10 ** 12)).toBe(true);
  });

  it('shows a done task just inside 24h and hides it just outside', () => {
    const task = makeTask('t1', []);
    setTaskStatus(task, 'done', 0);
    expect(isTaskVisible(task, DONE_VISIBILITY_MS - 1)).toBe(true);
    expect(isTaskVisible(task, DONE_VISIBILITY_MS)).toBe(true);
    expect(isTaskVisible(task, DONE_VISIBILITY_MS + 1)).toBe(false);
  });

  it('shows a done task that has no completedAt rather than vanishing it', () => {
    const task = { ...makeTask('t1', []), status: 'done' as const };
    expect(isTaskVisible(task, 10 ** 12)).toBe(true);
  });

  it('shows a done task whose completedAt is in the future', () => {
    const task = makeTask('t1', []);
    setTaskStatus(task, 'done', 10 ** 12);
    expect(isTaskVisible(task, 1000)).toBe(true);
  });
});
```

Add `setTaskStatus`, `isTaskVisible` and `DONE_VISIBILITY_MS` to the test file's import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the functions are not exported yet.

- [ ] **Step 3: Implement**

Add to `src/app-state-logic.ts`:

```typescript
/** How long a completed task stays visible before it drops out of the default view. */
export const DONE_VISIBILITY_MS = 24 * 60 * 60 * 1000;

/**
 * Move a task to a new status, maintaining completedAt as the single source of
 * truth for the visibility window. Re-marking an already-done task does not
 * extend its window.
 */
export function setTaskStatus(task: Task, status: TaskStatus, now: number): void {
  if (status === 'done') {
    if (task.status !== 'done') task.completedAt = now;
  } else {
    delete task.completedAt;
  }
  task.status = status;
}

/**
 * Derived visibility — no timers, no mutation. Correct across restarts and sleep.
 * A done task with no completedAt, or one stamped in the future, stays visible
 * rather than silently disappearing.
 */
export function isTaskVisible(task: Task, now: number): boolean {
  if (task.status !== 'done') return true;
  if (task.completedAt === undefined) return true;
  return now - task.completedAt <= DONE_VISIBILITY_MS;
}
```

- [ ] **Step 4: Thread `now` into `handleDrop`**

Add `now: number` as the final parameter of `handleDrop` and use it for the task it creates, replacing the `createdAt: 0` placeholder from Task 1:

```typescript
const newTask: Task = {
  id: `task-${state.taskCounter}`,
  title: 'New task',
  status: 'doing',
  sessionIds: [targetId, draggedId],
  collapsed: false,
  createdAt: now,
};
```

Update every `handleDrop` call in the test file to pass a final `0` argument, and add:

```typescript
it('stamps createdAt on a task created by merging two sessions', () => {
  const state = createState({
    sidebarOrder: [{ type: 'session', id: 's1' }, { type: 'session', id: 's2' }],
  });

  handleDrop(state, new Set(['s1', 's2']), 's2', 's1', 'merge', false, 4242);

  const created = state.tasks.get('task-1')!;
  expect(created.createdAt).toBe(4242);
  expect(created.title).toBe('New task');
  expect(created.status).toBe('doing');
});
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "feat: add task status transitions and 24h done visibility"
```

---

### Task 4: Versioned saved state and v1→v2 migration

**Files:**
- Modify: `src/app-state-logic.ts` — add `version` to `SavedState`, add `migrateSavedState`
- Test: `src/app-state-logic.test.ts`

**Interfaces:**
- Consumes: `SavedState`, `Task`, `SidebarEntry` from Tasks 1–3
- Produces: `SAVED_STATE_VERSION: number`, `migrateSavedState(raw: unknown, now: number): SavedState`; `SavedState` gains a required `version: number`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('migrateSavedState', () => {
  const v1 = {
    sessions: [{ id: 's1', name: 'one', cwd: '/a' }],
    groups: [{ id: 'g1', name: 'My group', sessionIds: ['s1'], collapsed: true }],
    sidebarOrder: [{ type: 'group', id: 'g1' }],
    groupCounter: 3,
  };

  it('converts v1 groups into doing tasks, preserving title and collapse', () => {
    const result = migrateSavedState(v1, 9000);

    expect(result.version).toBe(SAVED_STATE_VERSION);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toEqual({
      id: 'g1',
      title: 'My group',
      status: 'doing',
      sessionIds: ['s1'],
      collapsed: true,
      createdAt: 9000,
    });
    expect(result.taskCounter).toBe(3);
    expect(result.sessions).toEqual(v1.sessions);
  });

  it('rewrites v1 group sidebar entries as task entries', () => {
    const result = migrateSavedState(v1, 9000);
    expect(result.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }]);
  });

  it('is idempotent — migrating v2 state returns it unchanged', () => {
    const once = migrateSavedState(v1, 9000);
    const twice = migrateSavedState(once, 50000);
    expect(twice).toEqual(once);
  });

  it('returns usable empty state for malformed input instead of throwing', () => {
    for (const bad of [null, undefined, 42, 'nonsense', {}, { groups: 'not an array' }]) {
      const result = migrateSavedState(bad, 9000);
      expect(result.version).toBe(SAVED_STATE_VERSION);
      expect(result.sessions).toEqual([]);
      expect(result.tasks).toEqual([]);
      expect(result.sidebarOrder).toEqual([]);
      expect(result.taskCounter).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `migrateSavedState` is not exported.

- [ ] **Step 3: Add the version field**

Add `version: number;` as the first field of `SavedState`, and set it in `buildSavedState`:

```typescript
export const SAVED_STATE_VERSION = 2;

export function buildSavedState(sessions: Map<string, SessionData>, state: AppState): SavedState {
  const savedSessions = Array.from(sessions.entries()).map(([id, s]) => ({
    id, name: s.name, cwd: s.cwd,
  }));
  return {
    version: SAVED_STATE_VERSION,
    sessions: savedSessions,
    tasks: Array.from(state.tasks.values()),
    sidebarOrder: state.sidebarOrder,
    taskCounter: state.taskCounter,
  };
}
```

Add `version: SAVED_STATE_VERSION` to every `SavedState` literal in the test file.

- [ ] **Step 4: Implement the migration**

```typescript
type SavedSession = { id: string; name: string; cwd: string };

interface SavedGroupV1 {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed: boolean;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Bring a saved state file up to the current version. Tolerates malformed and
 * hand-edited files by falling back to empty collections rather than throwing —
 * a corrupt state file should cost the sidebar layout, not the app's startup.
 */
export function migrateSavedState(raw: unknown, now: number): SavedState {
  if (typeof raw !== 'object' || raw === null) {
    return { version: SAVED_STATE_VERSION, sessions: [], tasks: [], sidebarOrder: [], taskCounter: 0 };
  }

  const state = raw as Record<string, unknown>;

  if (state.version === SAVED_STATE_VERSION) {
    return {
      version: SAVED_STATE_VERSION,
      sessions: asArray<SavedSession>(state.sessions),
      tasks: asArray<Task>(state.tasks),
      sidebarOrder: asArray<SidebarEntry>(state.sidebarOrder),
      taskCounter: typeof state.taskCounter === 'number' ? state.taskCounter : 0,
    };
  }

  const tasks: Task[] = asArray<SavedGroupV1>(state.groups).map(group => ({
    id: group.id,
    title: group.name,
    status: 'doing' as const,
    sessionIds: asArray<string>(group.sessionIds),
    collapsed: group.collapsed === true,
    createdAt: now,
  }));

  const sidebarOrder: SidebarEntry[] = asArray<{ type: string; id: string }>(state.sidebarOrder)
    .map(entry => entry.type === 'group'
      ? { type: 'task' as const, id: entry.id }
      : { type: 'session' as const, id: entry.id });

  return {
    version: SAVED_STATE_VERSION,
    sessions: asArray<SavedSession>(state.sessions),
    tasks,
    sidebarOrder,
    taskCounter: typeof state.groupCounter === 'number' ? state.groupCounter : 0,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app-state-logic.ts src/app-state-logic.test.ts
git commit -m "feat: version saved state and migrate v1 groups to tasks"
```

---

## Done when

- `npm run build` is clean and `npm test` is green
- `src/app-state-logic.ts` exports `Task` and no longer mentions groups
- A task with zero sessions survives both `pruneDeadSessions` and `reconstructFromSaved`
- `git status` shows exactly two modified files
- Launching the app still behaves exactly as before — it loads `src/renderer/appState.ts`, which this plan never touched

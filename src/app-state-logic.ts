/**
 * Pure logic for sidebar state, task management, and state persistence.
 * No DOM, no window.api, no globals — fully testable.
 */

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

export const SAVED_STATE_VERSION = 2;

export interface SavedState {
  version: number;
  sessions: Array<{ id: string; name: string; cwd: string }>;
  tasks: Task[];
  taskCounter: number;
  /**
   * The renderer's serialized pane layout, carried opaquely. This module has no
   * business knowing what a layout is, but it must not drop the field on the
   * floor during migration — doing so loses the user's split-pane arrangement
   * on every load.
   */
  layout?: unknown;
}

export interface AppState {
  tasks: Map<string, Task>;
  taskCounter: number;
}

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

/**
 * Create a task and register it. Tasks are created empty — sessions are
 * attached afterwards, which is what makes a task a todo item rather than a
 * container for sessions that already exist.
 */
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
 * Delete a task. Its sessions are orphaned, not killed: "loose" means belonging
 * to no task, so dropping the task is all that is required. Killing a session
 * stays an explicit, separate act.
 */
export function deleteTask(state: AppState, taskId: string): void {
  state.tasks.delete(taskId);
}

export function getTaskForSession(tasks: Map<string, Task>, sessionId: string): Task | undefined {
  for (const task of tasks.values()) {
    if (task.sessionIds.includes(sessionId)) return task;
  }
  return undefined;
}

/**
 * Remove dead sessions from tasks. Tasks survive at any size, including zero —
 * a task is durable and exists independently of its sessions.
 */
export function pruneDeadSessions(state: AppState, sessionIds: Set<string>): void {
  for (const task of state.tasks.values()) {
    task.sessionIds = task.sessionIds.filter(id => sessionIds.has(id));
  }
}

/**
 * Session order for Cmd+Arrow navigation, derived from the sections. Collapse
 * is presentation only, so a collapsed task's sessions stay reachable.
 */
export function getVisibleSessionOrder(state: AppState, sessionIds: Set<string>): string[] {
  // MAX_SAFE_INTEGER is deliberate: navigation must reach every task's
  // sessions, including a done task whose display window has lapsed.
  const sections = partitionSidebar(state, sessionIds, Number.MAX_SAFE_INTEGER);
  const result: string[] = [];
  for (const task of [...sections.doing, ...sections.backlog, ...sections.done]) {
    for (const sid of task.sessionIds) {
      if (sessionIds.has(sid)) result.push(sid);
    }
  }
  return [...result, ...sections.loose];
}

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
 * Build a serializable saved state from live data.
 */
export function buildSavedState(sessions: Map<string, SessionData>, state: AppState): SavedState {
  const savedSessions = Array.from(sessions.entries()).map(([id, s]) => ({
    id, name: s.name, cwd: s.cwd,
  }));
  return {
    version: SAVED_STATE_VERSION,
    sessions: savedSessions,
    tasks: Array.from(state.tasks.values()),
    taskCounter: state.taskCounter,
  };
}

/**
 * Reconstruct tasks from saved state using an old→new session ID mapping.
 * Sidebar position is derived from status, so there is no order to rebuild.
 */
export function reconstructFromSaved(
  saved: SavedState,
  idMap: Map<string, string>,
): AppState {
  const tasks = new Map<string, Task>();

  for (const savedTask of saved.tasks) {
    const remappedIds = savedTask.sessionIds
      .map(id => idMap.get(id))
      .filter((id): id is string => id !== undefined);
    tasks.set(savedTask.id, { ...savedTask, sessionIds: remappedIds });
  }

  return { tasks, taskCounter: saved.taskCounter };
}

type SavedSession = { id: string; name: string; cwd: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toSession(raw: Record<string, unknown>): SavedSession | null {
  const { id, name, cwd } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof cwd !== 'string') return null;
  return { id, name, cwd };
}

/**
 * Build a well-formed Task from whatever the state file actually contained.
 * Every field is defaulted, because the only thing a saved file guarantees is
 * that it parsed as JSON — and reconstructFromSaved dereferences sessionIds.
 */
function toTask(raw: Record<string, unknown>, title: unknown, now: number): Task | null {
  const id = raw.id;
  if (typeof id !== 'string' || id === '') return null;

  const status = raw.status;
  const task: Task = {
    id,
    title: typeof title === 'string' ? title : id,
    status: status === 'backlog' || status === 'doing' || status === 'done' ? status : 'doing',
    sessionIds: Array.isArray(raw.sessionIds)
      ? raw.sessionIds.filter((sid): sid is string => typeof sid === 'string')
      : [],
    collapsed: raw.collapsed === true,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
  };
  if (typeof raw.completedAt === 'number') task.completedAt = raw.completedAt;
  return task;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Bring a saved state file up to the current version. Tolerates malformed and
 * hand-edited files by dropping what it cannot understand rather than throwing —
 * a corrupt state file should cost the sidebar layout, not the app's startup.
 *
 * v1 is detected positively (it has `groups` and no `tasks`) rather than by
 * `version !== 2`. Deciding by the version number would treat a hand-edited file
 * whose `version` key was dropped or mistyped as v1 and silently discard every
 * task in it — the exact data loss the durable-task model exists to prevent.
 */
export function migrateSavedState(raw: unknown, now: number): SavedState {
  if (!isRecord(raw)) {
    return { version: SAVED_STATE_VERSION, sessions: [], tasks: [], taskCounter: 0 };
  }

  const isV1 = Array.isArray(raw.groups) && !Array.isArray(raw.tasks);

  const tasks = isV1
    ? asRecords(raw.groups).map(group => toTask(group, group.name, now)).filter(notNull)
    : asRecords(raw.tasks).map(task => toTask(task, task.title, now)).filter(notNull);

  const counter = isV1 ? raw.groupCounter : raw.taskCounter;

  const migrated: SavedState = {
    version: SAVED_STATE_VERSION,
    sessions: asRecords(raw.sessions).map(toSession).filter(notNull),
    tasks,
    taskCounter: typeof counter === 'number' ? counter : 0,
  };
  if (raw.layout !== undefined) migrated.layout = raw.layout;
  return migrated;
}

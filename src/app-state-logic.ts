/**
 * Pure logic for sidebar state, task management, and state persistence.
 * No DOM, no window.api, no globals — fully testable.
 */

export type TaskStatus = 'backlog' | 'doing' | 'done';

export type TaskType = 'feature' | 'bug' | 'chore' | 'review' | 'spike';

/** The optional metadata a task can carry. Absent means absent, never empty. */
export interface TaskFields {
  description?: string;
  type?: TaskType;
  repos?: string[];
  links?: string[];
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
  completedAt?: number;
  description?: string;
  type?: TaskType;
  repos?: string[];
  links?: string[];
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

/** Every task, split by status and ordered, with no visibility filtering. */
function orderedTasks(state: AppState): { doing: Task[]; backlog: Task[]; done: Task[] } {
  const doing: Task[] = [];
  const backlog: Task[] = [];
  const done: Task[] = [];

  for (const task of state.tasks.values()) {
    if (task.status === 'doing') doing.push(task);
    else if (task.status === 'backlog') backlog.push(task);
    else done.push(task);
  }

  return {
    doing: doing.sort(byCreatedAsc),
    backlog: backlog.sort(byCreatedAsc),
    done: done.sort(byCompletedDesc),
  };
}

function ownedSessionIds(state: AppState): Set<string> {
  const owned = new Set<string>();
  for (const task of state.tasks.values()) {
    for (const sid of task.sessionIds) owned.add(sid);
  }
  return owned;
}

/**
 * Split state into the four sidebar sections, already ordered. The ordering
 * rules live here rather than in render code so they are testable.
 *
 * `knownSessionIds` is every session the UI holds, including ones whose process
 * has exited — those still need a row so they can be closed. `runningSessionIds`
 * is the subset still alive, and only those exempt a done task from ageing out:
 * an exited session is neither running nor at risk of being stranded, so letting
 * it pin a task in Done would mean completed work never disappears.
 */
export function partitionSidebar(
  state: AppState,
  knownSessionIds: Set<string>,
  runningSessionIds: Set<string>,
  now: number,
): SidebarSections {
  const { doing, backlog, done } = orderedTasks(state);
  const owned = ownedSessionIds(state);

  return {
    doing,
    backlog,
    done: done.filter(task =>
      isTaskVisible(task, now) || task.sessionIds.some(sid => runningSessionIds.has(sid))),
    loose: Array.from(knownSessionIds).filter(sid => !owned.has(sid)),
  };
}

/**
 * Create a task and register it. Tasks are created empty — sessions are
 * attached afterwards, which is what makes a task a todo item rather than a
 * container for sessions that already exist.
 */
export function createTask(
  state: AppState,
  title: string,
  status: TaskStatus,
  now: number,
  fields: TaskFields = {},
): Task {
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
  // Assigned only when supplied, so a bare task carries no empty keys.
  if (fields.description !== undefined) task.description = fields.description;
  if (fields.type !== undefined) task.type = fields.type;
  if (fields.repos !== undefined) task.repos = fields.repos;
  if (fields.links !== undefined) task.links = fields.links;

  state.tasks.set(task.id, task);
  return task;
}

/** Set when present, delete when cleared — an emptied field leaves no key. */
function applyOptionalField<K extends keyof TaskFields>(
  task: Task,
  key: K,
  value: TaskFields[K],
): void {
  // Task carries every TaskFields member, so the narrowing is safe; TS cannot
  // see through the generic key.
  if (value === undefined) delete task[key];
  else (task as TaskFields)[key] = value;
}

/**
 * Apply an edit to a task in place. Only the title and the optional fields
 * move: status, collapsed, createdAt, completedAt and sessionIds belong to the
 * task's lifecycle, not to the form that edits it.
 */
export function updateTask(task: Task, title: string, fields: TaskFields): void {
  task.title = title;
  applyOptionalField(task, 'description', fields.description);
  applyOptionalField(task, 'type', fields.type);
  applyOptionalField(task, 'repos', fields.repos);
  applyOptionalField(task, 'links', fields.links);
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
 * Session order for Cmd+Arrow navigation: Doing, then Backlog, then Done, then
 * loose. Built from every task rather than from the visible sections — collapse
 * is presentation only, and a done task past its display window still holds
 * sessions that must stay reachable.
 */
export function getVisibleSessionOrder(state: AppState, sessionIds: Set<string>): string[] {
  const { doing, backlog, done } = orderedTasks(state);
  const result: string[] = [];

  for (const task of [...doing, ...backlog, ...done]) {
    for (const sid of task.sessionIds) {
      if (sessionIds.has(sid)) result.push(sid);
    }
  }

  const owned = ownedSessionIds(state);
  for (const sid of sessionIds) {
    if (!owned.has(sid)) result.push(sid);
  }

  return result;
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
const TASK_TYPES: readonly string[] = ['feature', 'bug', 'chore', 'review', 'spike'];

function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && TASK_TYPES.includes(value);
}

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
  if (typeof raw.description === 'string') task.description = raw.description;
  if (isTaskType(raw.type)) task.type = raw.type;
  if (Array.isArray(raw.repos)) task.repos = raw.repos.filter((r): r is string => typeof r === 'string');
  if (Array.isArray(raw.links)) task.links = raw.links.filter((l): l is string => typeof l === 'string');
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

  return {
    version: SAVED_STATE_VERSION,
    sessions: asRecords(raw.sessions).map(toSession).filter(notNull),
    tasks,
    taskCounter: typeof counter === 'number' ? counter : 0,
  };
}

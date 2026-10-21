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
 * Flatten sidebar entries into an ordered list of session IDs.
 */
export function getVisibleSessionOrder(state: AppState, sessionIds: Set<string>): string[] {
  const result: string[] = [];
  for (const entry of state.sidebarOrder) {
    if (entry.type === 'session') {
      if (sessionIds.has(entry.id)) result.push(entry.id);
    } else {
      const task = state.tasks.get(entry.id);
      if (task) {
        for (const sid of task.sessionIds) {
          if (sessionIds.has(sid)) result.push(sid);
        }
      }
    }
  }
  return result;
}

/**
 * Remove a session from the sidebar order and from any task it belongs to.
 */
export function removeSidebarEntry(state: AppState, sessionId: string): void {
  state.sidebarOrder = state.sidebarOrder.filter(e => !(e.type === 'session' && e.id === sessionId));
  const task = getTaskForSession(state.tasks, sessionId);
  if (task) {
    task.sessionIds = task.sessionIds.filter(id => id !== sessionId);
  }
}

/**
 * Build a serializable saved state from live data.
 */
export function buildSavedState(sessions: Map<string, SessionData>, state: AppState): SavedState {
  const savedSessions = Array.from(sessions.entries()).map(([id, s]) => ({
    id, name: s.name, cwd: s.cwd,
  }));
  return {
    sessions: savedSessions,
    tasks: Array.from(state.tasks.values()),
    sidebarOrder: state.sidebarOrder,
    taskCounter: state.taskCounter,
  };
}

/**
 * Reconstruct tasks and sidebar order from saved state using an old→new ID mapping.
 * Returns the reconstructed AppState fields and any session IDs not placed in the sidebar.
 */
export function reconstructFromSaved(
  saved: SavedState,
  idMap: Map<string, string>,
): AppState {
  const tasks = new Map<string, Task>();
  const sidebarOrder: SidebarEntry[] = [];

  // Rebuild tasks with remapped IDs. Every saved task is restored, whatever
  // its surviving session count — a task outlives its sessions.
  for (const savedTask of saved.tasks) {
    const remappedIds = savedTask.sessionIds
      .map(id => idMap.get(id))
      .filter((id): id is string => id !== undefined);
    tasks.set(savedTask.id, { ...savedTask, sessionIds: remappedIds });
  }

  // Rebuild sidebar order. A task entry always resolves now, so the old
  // disband-fallback that scattered survivors as loose sessions is gone.
  for (const entry of saved.sidebarOrder) {
    if (entry.type === 'session') {
      const newId = idMap.get(entry.id);
      if (newId) sidebarOrder.push({ type: 'session', id: newId });
    } else if (tasks.has(entry.id)) {
      sidebarOrder.push({ type: 'task', id: entry.id });
    }
  }

  // Find sessions not yet in sidebar (edge case)
  const allNewIds = new Set(idMap.values());
  const inOrder = new Set(getVisibleSessionOrder({ tasks, sidebarOrder, taskCounter: saved.taskCounter }, allNewIds));
  for (const newId of allNewIds) {
    if (!inOrder.has(newId)) {
      sidebarOrder.push({ type: 'session', id: newId });
    }
  }

  return {
    tasks,
    sidebarOrder,
    taskCounter: saved.taskCounter,
  };
}

/**
 * Handle a drag-and-drop operation between sessions/tasks.
 */
export function handleDrop(
  state: AppState,
  sessionIds: Set<string>,
  draggedId: string,
  targetId: string,
  zone: 'above' | 'below' | 'merge',
  targetIsTask: boolean,
  now: number,
): void {
  if (draggedId === targetId) return;

  if (zone === 'merge') {
    if (targetIsTask) {
      const task = state.tasks.get(targetId);
      if (!task) return;
      if (task.sessionIds.includes(draggedId)) return;
      removeSidebarEntry(state, draggedId);
      pruneDeadSessions(state, sessionIds);
      task.sessionIds.push(draggedId);
    } else {
      const targetTask = getTaskForSession(state.tasks, targetId);
      if (targetTask) {
        if (targetTask.sessionIds.includes(draggedId)) return;
        removeSidebarEntry(state, draggedId);
        pruneDeadSessions(state, sessionIds);
        targetTask.sessionIds.push(draggedId);
      } else {
        removeSidebarEntry(state, draggedId);
        pruneDeadSessions(state, sessionIds);

        state.taskCounter++;
        const newTask: Task = {
          id: `task-${state.taskCounter}`,
          title: 'New task',
          status: 'doing',
          sessionIds: [targetId, draggedId],
          collapsed: false,
          createdAt: now,
        };
        state.tasks.set(newTask.id, newTask);

        const targetIdx = state.sidebarOrder.findIndex(e => e.type === 'session' && e.id === targetId);
        if (targetIdx !== -1) {
          state.sidebarOrder[targetIdx] = { type: 'task', id: newTask.id };
        }
      }
    }
  } else {
    removeSidebarEntry(state, draggedId);
    pruneDeadSessions(state, sessionIds);

    if (targetIsTask) {
      const idx = state.sidebarOrder.findIndex(e => e.type === 'task' && e.id === targetId);
      if (idx !== -1) {
        const insertIdx = zone === 'above' ? idx : idx + 1;
        state.sidebarOrder.splice(insertIdx, 0, { type: 'session', id: draggedId });
      }
    } else {
      const targetTask = getTaskForSession(state.tasks, targetId);
      if (targetTask) {
        const tIdx = targetTask.sessionIds.indexOf(targetId);
        const insertIdx = zone === 'above' ? tIdx : tIdx + 1;
        targetTask.sessionIds.splice(insertIdx, 0, draggedId);
      } else {
        const idx = state.sidebarOrder.findIndex(e => e.type === 'session' && e.id === targetId);
        if (idx !== -1) {
          const insertIdx = zone === 'above' ? idx : idx + 1;
          state.sidebarOrder.splice(insertIdx, 0, { type: 'session', id: draggedId });
        }
      }
    }
  }

  pruneDeadSessions(state, sessionIds);
}

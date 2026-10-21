// Task & sidebar state shared across renderer scripts.
//
// The algorithms live in src/app-state-logic.ts, bundled to app-state-logic.js
// and loaded as the `TaskLogic` global (see index.html). This file holds only
// the renderer's single state object and the impure parts that module cannot
// own: the pane layout and async session re-creation over IPC.
const appState: AppState = {
  tasks: new Map(),
  taskCounter: 0,
};
let dragInProgress = false;

/** Session ids currently alive, as the pure logic expects them. */
function liveSessionIds(): Set<string> {
  return new Set(sessions.keys());
}

function getTaskForSession(sessionId: string): Task | undefined {
  return TaskLogic.getTaskForSession(appState.tasks, sessionId);
}

function pruneDeadSessions(): void {
  TaskLogic.pruneDeadSessions(appState, liveSessionIds());
}

function getVisibleSessionOrder(): string[] {
  return TaskLogic.getVisibleSessionOrder(appState, liveSessionIds());
}

function detachSession(sessionId: string): void {
  TaskLogic.detachSession(appState, sessionId);
}

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

function addTask(status: TaskStatus): Task {
  return TaskLogic.createTask(appState, '', status, Date.now());
}

function removeTask(taskId: string): void {
  TaskLogic.deleteTask(appState, taskId);
}

/** Attach a session to a task, moving it off any task it already belongs to. */
function attachSessionToTask(sessionId: string, taskId: string): void {
  TaskLogic.attachSessionToTask(appState, sessionId, taskId);
}

// --- State persistence ---

function buildSavedState(pm: PaneManager): string {
  const core = TaskLogic.buildSavedState(sessions, appState);
  return JSON.stringify({ ...core, layout: pm.serializeLayout() });
}

let saveTimeout: number | undefined;
let scheduleSaveImpl: (() => void) | null = null;

function scheduleSave(): void {
  scheduleSaveImpl?.();
}

function initScheduleSave(impl: () => void): void {
  scheduleSaveImpl = impl;
}

async function restoreState(pm: PaneManager): Promise<boolean> {
  const raw = await window.api.loadState();
  if (!raw) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  // Normalises v1 (groups) into v2 (tasks) and tolerates a hand-edited file.
  const saved = TaskLogic.migrateSavedState(parsed, Date.now());

  const idMap = new Map<string, string>();
  await Promise.all(saved.sessions.map(async (savedSession) => {
    const session = await window.api.createSessionAt(savedSession.cwd, { continue: true });
    if (session) {
      session.name = savedSession.name;
      sessions.set(session.id, session);
      idMap.set(savedSession.id, session.id);
    }
  }));

  const restored = TaskLogic.reconstructFromSaved(saved, idMap);
  appState.tasks = restored.tasks;
  appState.taskCounter = restored.taskCounter;

  if (saved.layout) {
    pm.restoreLayout(saved.layout as SerializedLayout, idMap);
  }

  return sessions.size > 0;
}

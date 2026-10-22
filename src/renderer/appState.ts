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
/**
 * True while an inline rename/create input is open. renderSidebar wipes the
 * list with innerHTML = '', and detaching a focused element does not fire
 * blur in Chromium — so a background re-render (a session changing state, say)
 * would silently discard whatever was being typed.
 */
let renameInProgress = false;

function setRenameInProgress(value: boolean): void {
  renameInProgress = value;
}

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

function expandBacklog(): void {
  backlogCollapsed = false;
}

/**
 * Sessions whose process is still alive. onExit keeps an exited session in the
 * map so its row can still be closed, so "known" and "running" differ — and
 * only a running session should keep a done task pinned in the Done section.
 */
function runningSessionIds(): Set<string> {
  const running = new Set<string>();
  for (const [id, session] of sessions) {
    if (session.status !== 'done') running.add(id);
  }
  return running;
}

/**
 * Tasks outlive their sessions, so a backlog with nothing running is still
 * state worth writing. Gating the save on sessions alone silently discarded
 * every task that had no session attached.
 */
function hasPersistableState(): boolean {
  return sessions.size > 0 || appState.tasks.size > 0;
}

function sidebarSections(): SidebarSections {
  return TaskLogic.partitionSidebar(appState, liveSessionIds(), runningSessionIds(), Date.now());
}

/** The contextual status button: backlog → doing → done → doing. */
function advanceTaskStatus(task: Task): void {
  const next: TaskStatus = task.status === 'backlog' ? 'doing'
    : task.status === 'doing' ? 'done'
    : 'doing';
  TaskLogic.setTaskStatus(task, next, Date.now());
}

function createTaskFromModal(title: string, status: TaskStatus, fields: TaskFields): Task {
  return TaskLogic.createTask(appState, title, status, Date.now(), fields);
}

function updateTaskFromModal(task: Task, title: string, fields: TaskFields): void {
  TaskLogic.updateTask(task, title, fields);
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

// --- Sidebar width ---

const SIDEBAR_WIDTH_KEY = 'sidebarWidth';
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 520;

function applySidebarWidth(px: number): void {
  const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
}

function initSidebarResizer(): void {
  // localStorage can throw in some contexts; a failed read just means the
  // default width from styles.css stands.
  try {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (saved) applySidebarWidth(parseInt(saved, 10));
  } catch { /* keep the stylesheet default */ }

  const resizer = document.getElementById('sidebar-resizer');
  if (!resizer) return;

  resizer.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    document.body.classList.add('resizing-sidebar');

    const onMove = (ev: MouseEvent) => applySidebarWidth(ev.clientX);

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-sidebar');
      try {
        const width = getComputedStyle(document.documentElement)
          .getPropertyValue('--sidebar-width').trim();
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(parseInt(width, 10)));
      } catch { /* width still applies for this session */ }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

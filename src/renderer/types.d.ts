// xterm.js globals loaded via script tags
declare class Terminal {
  cols: number;
  rows: number;
  constructor(options?: Record<string, unknown>);
  loadAddon(addon: unknown): void;
  open(container: HTMLElement): void;
  write(data: string): void;
  clear(): void;
  reset(): void;
  focus(): void;
  dispose(): void;
  onData(callback: (data: string) => void): void;
}

declare namespace FitAddon {
  class FitAddon {
    fit(): void;
  }
}

declare namespace WebLinksAddon {
  class WebLinksAddon {
    constructor(handler?: (event: MouseEvent, url: string) => void);
  }
}

// Preload API exposed via contextBridge
interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
}

type SessionStatus = 'working' | 'needs-input' | 'idle' | 'done';

interface ElectronAPI {
  createSession(): Promise<SessionInfo | null>;
  killSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  getBuffer(id: string): Promise<string>;
  setActiveSession(id: string): void;
  sendInput(id: string, data: string): void;
  resizeSession(id: string, cols: number, rows: number): void;
  onOutput(callback: (id: string, data: string) => void): void;
  onStateChange(callback: (id: string, state: SessionStatus) => void): void;
  onExit(callback: (id: string, code: number) => void): void;
  onNewSession(callback: () => void): void;
  onSwitchSession(callback: (id: string) => void): void;
  onNavSession(callback: (direction: 'next' | 'prev') => void): void;
  onSplitSession(callback: (direction: 'vertical' | 'horizontal') => void): void;
  openUrl(url: string): Promise<void>;
  correctState(id: string, correctState: string): Promise<void>;
  getLogPath(): Promise<string>;
  createSessionAt(cwd: string, options?: { continue?: boolean }): Promise<SessionInfo | null>;
  saveState(state: string): Promise<void>;
  loadState(): Promise<string | null>;
  getPathForFile(file: File): string;
  onSaveAndQuit(callback: () => Promise<void>): void;
}

interface Window {
  api: ElectronAPI;
}

// --- Task model -----------------------------------------------------------
// These mirror src/app-state-logic.ts, which is bundled to app-state-logic.js
// and loaded as the `TaskLogic` global. The renderer cannot import it (scripts
// load as classic <script> tags), so the shapes are declared here. They are
// types only — the algorithms have exactly one implementation, in that module.

type TaskStatus = 'backlog' | 'doing' | 'done';

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
  completedAt?: number;
}

interface AppState {
  tasks: Map<string, Task>;
  taskCounter: number;
}

interface SavedState {
  version: number;
  sessions: Array<{ id: string; name: string; cwd: string }>;
  tasks: Task[];
  taskCounter: number;
  layout?: unknown;
}

interface SidebarSections {
  doing: Task[];
  backlog: Task[];
  done: Task[];
  loose: string[];
}

declare const TaskLogic: {
  createTask(state: AppState, title: string, status: TaskStatus, now: number): Task;
  deleteTask(state: AppState, taskId: string): void;
  partitionSidebar(state: AppState, liveSessionIds: Set<string>, now: number): SidebarSections;
  DONE_VISIBILITY_MS: number;
  SAVED_STATE_VERSION: number;
  getTaskForSession(tasks: Map<string, Task>, sessionId: string): Task | undefined;
  pruneDeadSessions(state: AppState, sessionIds: Set<string>): void;
  getVisibleSessionOrder(state: AppState, sessionIds: Set<string>): string[];
  detachSession(state: AppState, sessionId: string): void;
  attachSessionToTask(state: AppState, sessionId: string, taskId: string): void;
  buildSavedState(
    sessions: Map<string, { id: string; name: string; cwd: string }>,
    state: AppState,
  ): SavedState;
  reconstructFromSaved(saved: SavedState, idMap: Map<string, string>): AppState;
  setTaskStatus(task: Task, status: TaskStatus, now: number): void;
  isTaskVisible(task: Task, now: number): boolean;
  migrateSavedState(raw: unknown, now: number): SavedState;
};

// TerminalWrapper is declared in terminal.ts and loaded via script tag before app.ts

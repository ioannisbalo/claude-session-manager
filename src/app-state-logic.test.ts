import { describe, it, expect } from 'vitest';
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
  setTaskStatus,
  isTaskVisible,
  DONE_VISIBILITY_MS,
  migrateSavedState,
  SAVED_STATE_VERSION,
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

describe('app-state-logic', () => {
  describe('getTaskForSession', () => {
    it('returns the task containing the session', () => {
      const task = makeTask('g1', ['s1', 's2']);
      const tasks = new Map([['g1', task]]);
      expect(getTaskForSession(tasks, 's2')).toBe(task);
    });

    it('returns undefined if session is not in any task', () => {
      const tasks = new Map([['g1', makeTask('g1', ['s1', 's2'])]]);
      expect(getTaskForSession(tasks, 's3')).toBeUndefined();
    });
  });

  describe('pruneDeadSessions', () => {
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

    it('removes dead sessions from tasks', () => {
      const task = makeTask('g1', ['s1', 's2', 's3']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'task', id: 'g1' }],
      });
      // s3 no longer exists
      pruneDeadSessions(state, new Set(['s1', 's2']));
      expect(task.sessionIds).toEqual(['s1', 's2']);
    });

    it('keeps a task with 1 remaining session, leaving its sidebar entry', () => {
      const task = makeTask('g1', ['s1', 's2']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'task', id: 'g1' }],
      });
      // s2 no longer exists — task has only s1, and survives as a task
      pruneDeadSessions(state, new Set(['s1']));
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get('g1')!.sessionIds).toEqual(['s1']);
      expect(state.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }]);
    });

    it('keeps the sidebar entry when a task has 0 remaining sessions', () => {
      const task = makeTask('g1', ['s1', 's2']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'session', id: 's3' }, { type: 'task', id: 'g1' }],
      });
      // Both s1 and s2 gone — the task empties but stays put
      pruneDeadSessions(state, new Set(['s3']));
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get('g1')!.sessionIds).toEqual([]);
      expect(state.sidebarOrder).toEqual([
        { type: 'session', id: 's3' },
        { type: 'task', id: 'g1' },
      ]);
    });

    it('keeps tasks with 2+ members intact', () => {
      const task = makeTask('g1', ['s1', 's2', 's3']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'task', id: 'g1' }],
      });
      pruneDeadSessions(state, new Set(['s1', 's2', 's3']));
      expect(state.tasks.size).toBe(1);
      expect(task.sessionIds).toEqual(['s1', 's2', 's3']);
    });
  });

  describe('getVisibleSessionOrder', () => {
    it('returns standalone sessions in sidebar order', () => {
      const state = createState({
        sidebarOrder: [
          { type: 'session', id: 's2' },
          { type: 'session', id: 's1' },
        ],
      });
      expect(getVisibleSessionOrder(state, new Set(['s1', 's2']))).toEqual(['s2', 's1']);
    });

    it('expands tasks into their session order', () => {
      const task = makeTask('g1', ['s2', 's3']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [
          { type: 'session', id: 's1' },
          { type: 'task', id: 'g1' },
        ],
      });
      expect(getVisibleSessionOrder(state, new Set(['s1', 's2', 's3']))).toEqual(['s1', 's2', 's3']);
    });

    it('skips sessions that no longer exist', () => {
      const state = createState({
        sidebarOrder: [
          { type: 'session', id: 's1' },
          { type: 'session', id: 's2' },
        ],
      });
      expect(getVisibleSessionOrder(state, new Set(['s1']))).toEqual(['s1']);
    });

    it('skips dead sessions inside tasks', () => {
      const task = makeTask('g1', ['s1', 's2']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'task', id: 'g1' }],
      });
      expect(getVisibleSessionOrder(state, new Set(['s1']))).toEqual(['s1']);
    });
  });

  describe('removeSidebarEntry', () => {
    it('removes standalone session from sidebar order', () => {
      const state = createState({
        sidebarOrder: [
          { type: 'session', id: 's1' },
          { type: 'session', id: 's2' },
        ],
      });
      removeSidebarEntry(state, 's1');
      expect(state.sidebarOrder).toEqual([{ type: 'session', id: 's2' }]);
    });

    it('removes session from its task', () => {
      const task = makeTask('g1', ['s1', 's2', 's3']);
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'task', id: 'g1' }],
      });
      removeSidebarEntry(state, 's2');
      expect(task.sessionIds).toEqual(['s1', 's3']);
      // Group entry stays (pruneDeadSessions handles cleanup separately)
      expect(state.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }]);
    });

    it('does not remove task entries from sidebar', () => {
      const state = createState({
        sidebarOrder: [
          { type: 'task', id: 'g1' },
          { type: 'session', id: 's1' },
        ],
      });
      removeSidebarEntry(state, 'g1');
      // task entries are not filtered by removeSidebarEntry (only type 'session')
      expect(state.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }, { type: 'session', id: 's1' }]);
    });
  });

  describe('buildSavedState', () => {
    it('serializes sessions, tasks, sidebar order, and taskCounter', () => {
      const sessions = new Map<string, SessionData>([
        ['s1', { id: 's1', name: 'Project A', cwd: '/a' }],
        ['s2', { id: 's2', name: 'Project B', cwd: '/b' }],
      ]);
      const task = makeTask('g1', ['s1', 's2'], 'My Group');
      const state = createState({
        tasks: new Map([['g1', task]]),
        sidebarOrder: [{ type: 'task', id: 'g1' }],
        taskCounter: 3,
      });

      const saved = buildSavedState(sessions, state);
      expect(saved.sessions).toHaveLength(2);
      expect(saved.sessions[0]).toEqual({ id: 's1', name: 'Project A', cwd: '/a' });
      expect(saved.tasks).toHaveLength(1);
      expect(saved.tasks[0].title).toBe('My Group');
      expect(saved.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }]);
      expect(saved.taskCounter).toBe(3);
    });

    it('returns empty arrays when no sessions exist', () => {
      const saved = buildSavedState(new Map(), createState());
      expect(saved.sessions).toEqual([]);
      expect(saved.tasks).toEqual([]);
      expect(saved.sidebarOrder).toEqual([]);
    });
  });

  describe('reconstructFromSaved', () => {
    it('restores a task whose sessions are all gone', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
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
        version: SAVED_STATE_VERSION,
        sessions: [],
        tasks: [makeTask('t1', ['old1', 'old2'])],
        sidebarOrder: [{ type: 'task', id: 't1' }],
        taskCounter: 1,
      };

      const result = reconstructFromSaved(saved, new Map([['old1', 'new1']]));

      expect(result.tasks.get('t1')!.sessionIds).toEqual(['new1']);
      expect(result.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
    });

    it('remaps session IDs in tasks and sidebar', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [],
        sidebarOrder: [
          { type: 'session', id: 'old1' },
          { type: 'session', id: 'old2' },
        ],
        taskCounter: 0,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([
        { type: 'session', id: 'new1' },
        { type: 'session', id: 'new2' },
      ]);
    });

    it('remaps IDs inside tasks', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [{ id: 'g1', title: 'Group', status: 'doing', sessionIds: ['old1', 'old2'], collapsed: true, createdAt: 0 }],
        sidebarOrder: [{ type: 'task', id: 'g1' }],
        taskCounter: 1,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.tasks.size).toBe(1);
      const task = result.tasks.get('g1')!;
      expect(task.sessionIds).toEqual(['new1', 'new2']);
      expect(task.collapsed).toBe(true);
      expect(result.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }]);
      expect(result.taskCounter).toBe(1);
    });

    it('keeps a task when fewer than 2 sessions survive', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [{ id: 'g1', title: 'Group', status: 'doing', sessionIds: ['old1', 'old2'], collapsed: false, createdAt: 0 }],
        sidebarOrder: [{ type: 'task', id: 'g1' }],
        taskCounter: 1,
      };
      // Only old1 survived
      const idMap = new Map([['old1', 'new1']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.tasks.size).toBe(1);
      // The task survives with its one remaining session, still a task
      expect(result.tasks.get('g1')!.sessionIds).toEqual(['new1']);
      expect(result.sidebarOrder).toEqual([{ type: 'task', id: 'g1' }]);
    });

    it('skips sessions that failed to restore', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [],
        sidebarOrder: [
          { type: 'session', id: 'old1' },
          { type: 'session', id: 'old2' },
        ],
        taskCounter: 0,
      };
      // old2 failed to restore
      const idMap = new Map([['old1', 'new1']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([{ type: 'session', id: 'new1' }]);
    });

    it('appends sessions not in sidebar order', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [],
        sidebarOrder: [{ type: 'session', id: 'old1' }],
        taskCounter: 0,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([
        { type: 'session', id: 'new1' },
        { type: 'session', id: 'new2' },
      ]);
    });

    it('preserves sidebar order across mixed sessions and tasks', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
          { id: 'old3', name: 'C', cwd: '/c' },
          { id: 'old4', name: 'D', cwd: '/d' },
        ],
        tasks: [{ id: 'g1', title: 'Group', status: 'doing', sessionIds: ['old2', 'old3'], collapsed: false, createdAt: 0 }],
        sidebarOrder: [
          { type: 'session', id: 'old1' },
          { type: 'task', id: 'g1' },
          { type: 'session', id: 'old4' },
        ],
        taskCounter: 1,
      };
      const idMap = new Map([['old1', 'n1'], ['old2', 'n2'], ['old3', 'n3'], ['old4', 'n4']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([
        { type: 'session', id: 'n1' },
        { type: 'task', id: 'g1' },
        { type: 'session', id: 'n4' },
      ]);
      expect(result.tasks.get('g1')!.sessionIds).toEqual(['n2', 'n3']);
    });
  });

  describe('handleDrop', () => {
    describe('merge zone', () => {
      it('creates a new task when merging two standalone sessions', () => {
        const state = createState({
          sidebarOrder: [
            { type: 'session', id: 's1' },
            { type: 'session', id: 's2' },
          ],
          taskCounter: 0,
        });
        const sessionIds = new Set(['s1', 's2']);

        handleDrop(state, sessionIds, 's1', 's2', 'merge', false, 0);

        expect(state.tasks.size).toBe(1);
        const task = state.tasks.get('task-1')!;
        expect(task.sessionIds).toEqual(['s2', 's1']);
        expect(state.sidebarOrder).toEqual([{ type: 'task', id: 'task-1' }]);
      });

      it('adds session to existing task when merging onto grouped session', () => {
        const task = makeTask('g1', ['s1', 's2']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [
            { type: 'task', id: 'g1' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 's1', 'merge', false, 0);
        expect(task.sessionIds).toEqual(['s1', 's2', 's3']);
      });

      it('adds session to task when dropping on task header', () => {
        const task = makeTask('g1', ['s1', 's2']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [
            { type: 'task', id: 'g1' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 'g1', 'merge', true, 0);
        expect(task.sessionIds).toEqual(['s1', 's2', 's3']);
      });

      it('is a no-op when dragging onto self', () => {
        const state = createState({
          sidebarOrder: [{ type: 'session', id: 's1' }],
        });
        handleDrop(state, new Set(['s1']), 's1', 's1', 'merge', false, 0);
        expect(state.sidebarOrder).toEqual([{ type: 'session', id: 's1' }]);
      });

      it('is a no-op when dragging already-grouped session onto its own task', () => {
        const task = makeTask('g1', ['s1', 's2']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [{ type: 'task', id: 'g1' }],
        });
        handleDrop(state, new Set(['s1', 's2']), 's1', 'g1', 'merge', true, 0);
        expect(task.sessionIds).toEqual(['s1', 's2']);
      });
    });

    describe('above/below zone', () => {
      it('reorders standalone sessions — above', () => {
        const state = createState({
          sidebarOrder: [
            { type: 'session', id: 's1' },
            { type: 'session', id: 's2' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 's1', 'above', false, 0);
        expect(state.sidebarOrder).toEqual([
          { type: 'session', id: 's3' },
          { type: 'session', id: 's1' },
          { type: 'session', id: 's2' },
        ]);
      });

      it('reorders standalone sessions — below', () => {
        const state = createState({
          sidebarOrder: [
            { type: 'session', id: 's1' },
            { type: 'session', id: 's2' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's1', 's2', 'below', false, 0);
        expect(state.sidebarOrder).toEqual([
          { type: 'session', id: 's2' },
          { type: 'session', id: 's1' },
          { type: 'session', id: 's3' },
        ]);
      });

      it('inserts session above a task header', () => {
        const task = makeTask('g1', ['s2', 's3']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [
            { type: 'session', id: 's1' },
            { type: 'task', id: 'g1' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's1', 'g1', 'above', true, 0);
        expect(state.sidebarOrder).toEqual([
          { type: 'session', id: 's1' },
          { type: 'task', id: 'g1' },
        ]);
      });

      it('inserts into task at target position — above', () => {
        const task = makeTask('g1', ['s1', 's2']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [
            { type: 'task', id: 'g1' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 's1', 'above', false, 0);
        expect(task.sessionIds).toEqual(['s3', 's1', 's2']);
      });

      it('ungroups session when dragged out and dropped below a task', () => {
        const task = makeTask('g1', ['s1', 's2', 's3']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [{ type: 'task', id: 'g1' }],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 'g1', 'below', true, 0);
        expect(task.sessionIds).toEqual(['s1', 's2']);
        expect(state.sidebarOrder).toEqual([
          { type: 'task', id: 'g1' },
          { type: 'session', id: 's3' },
        ]);
      });

      it('keeps a task when dragging out leaves only 1 member', () => {
        const task = makeTask('g1', ['s1', 's2']);
        const state = createState({
          tasks: new Map([['g1', task]]),
          sidebarOrder: [{ type: 'task', id: 'g1' }, { type: 'session', id: 's3' }],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's2', 's3', 'below', false, 0);
        // g1 had [s1, s2], s2 was dragged out → g1 keeps s1 and stays a task
        expect(state.tasks.size).toBe(1);
        expect(state.tasks.get('g1')!.sessionIds).toEqual(['s1']);
        expect(state.sidebarOrder).toEqual([
          { type: 'task', id: 'g1' },
          { type: 'session', id: 's3' },
          { type: 'session', id: 's2' },
        ]);
      });
    });
  });

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

      handleDrop(state, new Set(['s1']), 's1', 't1', 'merge', true, 0);

      expect(state.tasks.get('t1')!.sessionIds).toEqual(['s1']);
      expect(state.sidebarOrder).toEqual([{ type: 'task', id: 't1' }]);
    });
  });

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

  describe('handleDrop task creation', () => {
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
  });

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
});

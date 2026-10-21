import { describe, it, expect } from 'vitest';
import {
  AppState,
  Task,
  SavedState,
  SessionData,
  pruneDeadSessions,
  getVisibleSessionOrder,
  detachSession,
  attachSessionToTask,
  getTaskForSession,
  buildSavedState,
  reconstructFromSaved,
  setTaskStatus,
  isTaskVisible,
  DONE_VISIBILITY_MS,
  migrateSavedState,
  SAVED_STATE_VERSION,
  createTask,
  deleteTask,
  partitionSidebar,
  TaskStatus,
} from './app-state-logic';

function createState(overrides?: Partial<AppState>): AppState {
  return {
    tasks: overrides?.tasks ?? new Map(),
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
      });

      pruneDeadSessions(state, new Set());

      expect(state.tasks.get('t1')).toBeDefined();
      expect(state.tasks.get('t1')!.sessionIds).toEqual([]);
    });

    it('keeps a task down to a single session without unwrapping it', () => {
      const task = makeTask('t1', ['s1', 's2']);
      const state = createState({
        tasks: new Map([['t1', task]]),
      });

      pruneDeadSessions(state, new Set(['s1']));

      expect(state.tasks.get('t1')!.sessionIds).toEqual(['s1']);
    });

    it('removes dead sessions from tasks', () => {
      const task = makeTask('g1', ['s1', 's2', 's3']);
      const state = createState({
        tasks: new Map([['g1', task]]),
      });
      // s3 no longer exists
      pruneDeadSessions(state, new Set(['s1', 's2']));
      expect(task.sessionIds).toEqual(['s1', 's2']);
    });

    it('keeps a task with 1 remaining session, leaving its sidebar entry', () => {
      const task = makeTask('g1', ['s1', 's2']);
      const state = createState({
        tasks: new Map([['g1', task]]),
      });
      // s2 no longer exists — task has only s1, and survives as a task
      pruneDeadSessions(state, new Set(['s1']));
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get('g1')!.sessionIds).toEqual(['s1']);
    });

    it('keeps the sidebar entry when a task has 0 remaining sessions', () => {
      const task = makeTask('g1', ['s1', 's2']);
      const state = createState({
        tasks: new Map([['g1', task]]),
      });
      // Both s1 and s2 gone — the task empties but stays put
      pruneDeadSessions(state, new Set(['s3']));
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get('g1')!.sessionIds).toEqual([]);
    });

    it('keeps tasks with 2+ members intact', () => {
      const task = makeTask('g1', ['s1', 's2', 's3']);
      const state = createState({
        tasks: new Map([['g1', task]]),
      });
      pruneDeadSessions(state, new Set(['s1', 's2', 's3']));
      expect(state.tasks.size).toBe(1);
      expect(task.sessionIds).toEqual(['s1', 's2', 's3']);
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
        taskCounter: 3,
      });

      const saved = buildSavedState(sessions, state);
      expect(saved.sessions).toHaveLength(2);
      expect(saved.sessions[0]).toEqual({ id: 's1', name: 'Project A', cwd: '/a' });
      expect(saved.tasks).toHaveLength(1);
      expect(saved.tasks[0].title).toBe('My Group');
      expect(saved.taskCounter).toBe(3);
    });

    it('returns empty arrays when no sessions exist', () => {
      const saved = buildSavedState(new Map(), createState());
      expect(saved.sessions).toEqual([]);
      expect(saved.tasks).toEqual([]);
    });
  });

  describe('reconstructFromSaved', () => {
    it('restores a task whose sessions are all gone', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [],
        tasks: [makeTask('t1', ['old1', 'old2'])],
        taskCounter: 1,
      };

      const result = reconstructFromSaved(saved, new Map());

      expect(result.tasks.get('t1')).toBeDefined();
      expect(result.tasks.get('t1')!.sessionIds).toEqual([]);
    });

    it('restores a task with a single surviving session as a task, not a loose session', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [],
        tasks: [makeTask('t1', ['old1', 'old2'])],
        taskCounter: 1,
      };

      const result = reconstructFromSaved(saved, new Map([['old1', 'new1']]));

      expect(result.tasks.get('t1')!.sessionIds).toEqual(['new1']);
    });

    it('remaps session IDs in tasks and sidebar', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [],
        taskCounter: 0,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
    });

    it('remaps IDs inside tasks', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [{ id: 'g1', title: 'Group', status: 'doing', sessionIds: ['old1', 'old2'], collapsed: true, createdAt: 0 }],
        taskCounter: 1,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.tasks.size).toBe(1);
      const task = result.tasks.get('g1')!;
      expect(task.sessionIds).toEqual(['new1', 'new2']);
      expect(task.collapsed).toBe(true);
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
        taskCounter: 1,
      };
      // Only old1 survived
      const idMap = new Map([['old1', 'new1']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.tasks.size).toBe(1);
      // The task survives with its one remaining session, still a task
      expect(result.tasks.get('g1')!.sessionIds).toEqual(['new1']);
    });

    it('skips sessions that failed to restore', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [],
        taskCounter: 0,
      };
      // old2 failed to restore
      const idMap = new Map([['old1', 'new1']]);

      const result = reconstructFromSaved(saved, idMap);
    });

    it('appends sessions not in sidebar order', () => {
      const saved: SavedState = {
        version: SAVED_STATE_VERSION,
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        tasks: [],
        taskCounter: 0,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
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
        taskCounter: 1,
      };
      const idMap = new Map([['old1', 'n1'], ['old2', 'n2'], ['old3', 'n3'], ['old4', 'n4']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.tasks.get('g1')!.sessionIds).toEqual(['n2', 'n3']);
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

  describe('migrateSavedState', () => {
    const v1 = {
      sessions: [{ id: 's1', name: 'one', cwd: '/a' }],
      groups: [{ id: 'g1', name: 'My group', sessionIds: ['s1'], collapsed: true }],
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
    });

    it('is idempotent — migrating v2 state returns it unchanged', () => {
      const once = migrateSavedState(v1, 9000);
      const twice = migrateSavedState(once, 50000);
      expect(twice).toEqual(once);
    });

    it('carries an opaque layout field through migration', () => {
      const layout = { type: 'split', ratio: 0.5, a: { paneId: 'p1' }, b: { paneId: 'p2' } };
      expect(migrateSavedState({ ...v1, layout }, 9000).layout).toEqual(layout);

      // and on an already-v2 file
      const v2 = { version: 2, sessions: [], tasks: [], sidebarOrder: [], taskCounter: 0, layout };
      expect(migrateSavedState(v2, 9000).layout).toEqual(layout);
    });

    it('omits layout entirely when the saved file has none', () => {
      expect('layout' in migrateSavedState(v1, 9000)).toBe(false);
    });

    it('drops malformed array elements instead of throwing', () => {
      expect(() => migrateSavedState({ groups: [null] }, 9000)).not.toThrow();
      expect(migrateSavedState({ groups: [null, 5, 'x'] }, 9000).tasks).toEqual([]);

      // Real v1 files carry a sidebarOrder. Ordering is derived now, so it is
      // ignored rather than migrated — but it must not break the load.
      expect(() => migrateSavedState({ sidebarOrder: [null] }, 9000)).not.toThrow();
      const withOrder = migrateSavedState({ ...v1, sidebarOrder: [{ type: 'group', id: 'g1' }] }, 9000);
      expect(withOrder.tasks).toHaveLength(1);
      expect('sidebarOrder' in withOrder).toBe(false);
    });

    it('keeps v2 tasks when the version field is missing or unrecognised', () => {
      const v2shape = {
        sessions: [],
        tasks: [{ id: 't1', title: 'Keep me', status: 'doing', sessionIds: ['s1'], collapsed: false, createdAt: 5 }],
        taskCounter: 5,
      };

      for (const variant of [v2shape, { ...v2shape, version: 3 }, { ...v2shape, version: '2' }]) {
        const result = migrateSavedState(variant, 9000);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].id).toBe('t1');
        expect(result.taskCounter).toBe(5);
      }
    });

    it('normalises an incomplete v2 task so the load pipeline cannot crash on it', () => {
      const migrated = migrateSavedState(
        { version: 2, sessions: [], tasks: [{ id: 't1' }], sidebarOrder: [{ type: 'task', id: 't1' }], taskCounter: 0 },
        9000,
      );

      expect(migrated.tasks[0]).toEqual({
        id: 't1',
        title: 't1',
        status: 'doing',
        sessionIds: [],
        collapsed: false,
        createdAt: 9000,
      });
      expect(() => reconstructFromSaved(migrated, new Map())).not.toThrow();
    });

    it('returns usable empty state for malformed input instead of throwing', () => {
      for (const bad of [null, undefined, 42, 'nonsense', {}, { groups: 'not an array' }]) {
        const result = migrateSavedState(bad, 9000);
        expect(result.version).toBe(SAVED_STATE_VERSION);
        expect(result.sessions).toEqual([]);
        expect(result.tasks).toEqual([]);
        expect(result.taskCounter).toBe(0);
      }
    });
  });

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

  describe('createTask title normalisation', () => {
    it('strips markdown todo prefixes pasted from a notes app', () => {
      const state = createState();
      expect(createTask(state, '- [ ] Improve LiFi integration', 'backlog', 0).title)
        .toBe('Improve LiFi integration');
      expect(createTask(state, '- [x] Already done', 'backlog', 0).title).toBe('Already done');
      expect(createTask(state, '* Bullet item', 'backlog', 0).title).toBe('Bullet item');
      expect(createTask(state, '- Dashed item', 'backlog', 0).title).toBe('Dashed item');
      expect(createTask(state, '\u2022 Bulleted', 'backlog', 0).title).toBe('Bulleted');
    });

    it('leaves ordinary titles alone, including ones that merely contain brackets', () => {
      const state = createState();
      expect(createTask(state, 'Fix [BLOC-123] retry', 'backlog', 0).title).toBe('Fix [BLOC-123] retry');
      expect(createTask(state, 'a - b', 'backlog', 0).title).toBe('a - b');
      expect(createTask(state, '-', 'backlog', 0).title).toBe('New task');
    });
  });

  describe('deleteTask', () => {
    it('removes the task and orphans its sessions rather than killing them', () => {
      const state = createState();
      const task = createTask(state, 'Doomed', 'doing', 0);
      task.sessionIds = ['s1', 's2'];

      deleteTask(state, task.id);

      expect(state.tasks.has(task.id)).toBe(false);
      expect(getTaskForSession(state.tasks, 's1')).toBeUndefined();
      expect(getTaskForSession(state.tasks, 's2')).toBeUndefined();
    });

    it('is a no-op for an unknown id', () => {
      const state = createState();
      expect(() => deleteTask(state, 'nope')).not.toThrow();
    });
  });

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

      const result = partitionSidebar(state, new Set(), new Set(), 1000);

      expect(result.doing.map(t => t.title)).toEqual(['older doing', 'newer doing']);
      expect(result.backlog.map(t => t.title)).toEqual(['backlog a', 'backlog b']);
    });

    it('orders done by completedAt, most recently closed first', () => {
      const state = createState();
      const first = createTask(state, 'closed first', 'doing', 0);
      const second = createTask(state, 'closed second', 'doing', 0);
      setTaskStatus(first, 'done', 100);
      setTaskStatus(second, 'done', 200);

      const result = partitionSidebar(state, new Set(), new Set(), 300);

      expect(result.done.map(t => t.title)).toEqual(['closed second', 'closed first']);
    });

    it('drops a done task once its 24h window lapses', () => {
      const state = createState();
      const task = createTask(state, 'old news', 'doing', 0);
      setTaskStatus(task, 'done', 0);

      expect(partitionSidebar(state, new Set(), new Set(), DONE_VISIBILITY_MS).done).toHaveLength(1);
      expect(partitionSidebar(state, new Set(), new Set(), DONE_VISIBILITY_MS + 1).done).toHaveLength(0);
    });

    it('keeps a lapsed done task visible while it still has live sessions', () => {
      const state = createState();
      const task = createTask(state, 'done but busy', 'doing', 0);
      task.sessionIds = ['s1'];
      setTaskStatus(task, 'done', 0);

      const result = partitionSidebar(state, new Set(['s1']), new Set(['s1']), DONE_VISIBILITY_MS + 1);

      // Hiding it would strand s1: it is in a task, so it is not loose either.
      expect(result.done.map(t => t.title)).toEqual(['done but busy']);
      expect(result.loose).toEqual([]);
    });

    it('reports sessions belonging to no task as loose', () => {
      const state = stateWith([['owns s1', 'doing', 0, ['s1']]]);

      const result = partitionSidebar(state, new Set(['s1', 's2', 's3']), new Set(['s1', 's2', 's3']), 100);

      expect(result.loose).toEqual(['s2', 's3']);
    });

    it('orders tasks created in the same millisecond deterministically', () => {
      const state = stateWith([
        ['a', 'backlog', 500, []],
        ['b', 'backlog', 500, []],
        ['c', 'backlog', 500, []],
      ]);

      const once = partitionSidebar(state, new Set(), new Set(), 1000).backlog.map(t => t.id);
      const twice = partitionSidebar(state, new Set(), new Set(), 1000).backlog.map(t => t.id);

      expect(once).toEqual(twice);
      expect(once).toEqual(['task-1', 'task-2', 'task-3']);
    });
  });

  describe('done-window exemption (running vs merely known sessions)', () => {
    it('ages out a done task whose sessions have exited', () => {
      const state = createState();
      const task = createTask(state, 'finished', 'doing', 0);
      task.sessionIds = ['s1'];
      setTaskStatus(task, 'done', 0);

      // s1 is still in the renderer's map (the row is kept so it can be closed)
      // but its process has exited, so it must not pin the task in Done.
      const known = new Set(['s1']);
      const running = new Set<string>();

      expect(partitionSidebar(state, known, running, DONE_VISIBILITY_MS + 1).done).toEqual([]);
    });

    it('keeps a lapsed done task while a session is actually running', () => {
      const state = createState();
      const task = createTask(state, 'done but busy', 'doing', 0);
      task.sessionIds = ['s1'];
      setTaskStatus(task, 'done', 0);

      const live = new Set(['s1']);

      expect(partitionSidebar(state, live, live, DONE_VISIBILITY_MS + 1).done).toHaveLength(1);
    });

    it('navigation still reaches a lapsed done task\'s sessions', () => {
      const state = createState();
      const task = createTask(state, 'long done', 'doing', 0);
      task.sessionIds = ['s1'];
      setTaskStatus(task, 'done', 0);

      // Not in any section, but Cmd+Arrow must still find it.
      expect(getVisibleSessionOrder(state, new Set(['s1']))).toEqual(['s1']);
    });
  });

  describe('detachSession', () => {
    // Restores coverage deleted with the removeSidebarEntry block.
    it('removes a session from the task holding it, leaving the task in place', () => {
      const state = createState();
      const task = createTask(state, 'holder', 'doing', 0);
      task.sessionIds = ['s1', 's2'];

      detachSession(state, 's1');

      expect(task.sessionIds).toEqual(['s2']);
      expect(state.tasks.has(task.id)).toBe(true);
    });

    it('is a no-op for a session belonging to no task', () => {
      const state = createState();
      expect(() => detachSession(state, 'loose')).not.toThrow();
    });
  });

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

    it('is a no-op for an unknown task', () => {
      const state = createState();
      expect(() => attachSessionToTask(state, 's1', 'nope')).not.toThrow();
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

    it('still reaches a collapsed task\'s sessions — collapse is presentation only', () => {
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
});

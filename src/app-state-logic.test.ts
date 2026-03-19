import { describe, it, expect } from 'vitest';
import {
  AppState,
  SessionGroup,
  SavedState,
  SessionData,
  enforceGroupIntegrity,
  getVisibleSessionOrder,
  removeSidebarEntry,
  getGroupForSession,
  buildSavedState,
  reconstructFromSaved,
  handleDrop,
} from './app-state-logic';

function createState(overrides?: Partial<AppState>): AppState {
  return {
    groups: overrides?.groups ?? new Map(),
    sidebarOrder: overrides?.sidebarOrder ?? [],
    groupCounter: overrides?.groupCounter ?? 0,
  };
}

function makeGroup(id: string, sessionIds: string[], name?: string): SessionGroup {
  return { id, name: name ?? id, sessionIds, collapsed: false };
}

describe('app-state-logic', () => {
  describe('getGroupForSession', () => {
    it('returns the group containing the session', () => {
      const group = makeGroup('g1', ['s1', 's2']);
      const groups = new Map([['g1', group]]);
      expect(getGroupForSession(groups, 's2')).toBe(group);
    });

    it('returns undefined if session is not in any group', () => {
      const groups = new Map([['g1', makeGroup('g1', ['s1', 's2'])]]);
      expect(getGroupForSession(groups, 's3')).toBeUndefined();
    });
  });

  describe('enforceGroupIntegrity', () => {
    it('removes dead sessions from groups', () => {
      const group = makeGroup('g1', ['s1', 's2', 's3']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'group', id: 'g1' }],
      });
      // s3 no longer exists
      enforceGroupIntegrity(state, new Set(['s1', 's2']));
      expect(group.sessionIds).toEqual(['s1', 's2']);
    });

    it('disbands group with 1 remaining session, replacing sidebar entry', () => {
      const group = makeGroup('g1', ['s1', 's2']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'group', id: 'g1' }],
      });
      // s2 no longer exists — group has only s1
      enforceGroupIntegrity(state, new Set(['s1']));
      expect(state.groups.size).toBe(0);
      expect(state.sidebarOrder).toEqual([{ type: 'session', id: 's1' }]);
    });

    it('removes sidebar entry when group has 0 remaining sessions', () => {
      const group = makeGroup('g1', ['s1', 's2']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'session', id: 's3' }, { type: 'group', id: 'g1' }],
      });
      // Both s1 and s2 gone
      enforceGroupIntegrity(state, new Set(['s3']));
      expect(state.groups.size).toBe(0);
      expect(state.sidebarOrder).toEqual([{ type: 'session', id: 's3' }]);
    });

    it('keeps groups with 2+ members intact', () => {
      const group = makeGroup('g1', ['s1', 's2', 's3']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'group', id: 'g1' }],
      });
      enforceGroupIntegrity(state, new Set(['s1', 's2', 's3']));
      expect(state.groups.size).toBe(1);
      expect(group.sessionIds).toEqual(['s1', 's2', 's3']);
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

    it('expands groups into their session order', () => {
      const group = makeGroup('g1', ['s2', 's3']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [
          { type: 'session', id: 's1' },
          { type: 'group', id: 'g1' },
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

    it('skips dead sessions inside groups', () => {
      const group = makeGroup('g1', ['s1', 's2']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'group', id: 'g1' }],
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

    it('removes session from its group', () => {
      const group = makeGroup('g1', ['s1', 's2', 's3']);
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'group', id: 'g1' }],
      });
      removeSidebarEntry(state, 's2');
      expect(group.sessionIds).toEqual(['s1', 's3']);
      // Group entry stays (enforceGroupIntegrity handles cleanup separately)
      expect(state.sidebarOrder).toEqual([{ type: 'group', id: 'g1' }]);
    });

    it('does not remove group entries from sidebar', () => {
      const state = createState({
        sidebarOrder: [
          { type: 'group', id: 'g1' },
          { type: 'session', id: 's1' },
        ],
      });
      removeSidebarEntry(state, 'g1');
      // group entries are not filtered by removeSidebarEntry (only type 'session')
      expect(state.sidebarOrder).toEqual([{ type: 'group', id: 'g1' }, { type: 'session', id: 's1' }]);
    });
  });

  describe('buildSavedState', () => {
    it('serializes sessions, groups, sidebar order, and groupCounter', () => {
      const sessions = new Map<string, SessionData>([
        ['s1', { id: 's1', name: 'Project A', cwd: '/a' }],
        ['s2', { id: 's2', name: 'Project B', cwd: '/b' }],
      ]);
      const group = makeGroup('g1', ['s1', 's2'], 'My Group');
      const state = createState({
        groups: new Map([['g1', group]]),
        sidebarOrder: [{ type: 'group', id: 'g1' }],
        groupCounter: 3,
      });

      const saved = buildSavedState(sessions, state);
      expect(saved.sessions).toHaveLength(2);
      expect(saved.sessions[0]).toEqual({ id: 's1', name: 'Project A', cwd: '/a' });
      expect(saved.groups).toHaveLength(1);
      expect(saved.groups[0].name).toBe('My Group');
      expect(saved.sidebarOrder).toEqual([{ type: 'group', id: 'g1' }]);
      expect(saved.groupCounter).toBe(3);
    });

    it('returns empty arrays when no sessions exist', () => {
      const saved = buildSavedState(new Map(), createState());
      expect(saved.sessions).toEqual([]);
      expect(saved.groups).toEqual([]);
      expect(saved.sidebarOrder).toEqual([]);
    });
  });

  describe('reconstructFromSaved', () => {
    it('remaps session IDs in groups and sidebar', () => {
      const saved: SavedState = {
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        groups: [],
        sidebarOrder: [
          { type: 'session', id: 'old1' },
          { type: 'session', id: 'old2' },
        ],
        groupCounter: 0,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([
        { type: 'session', id: 'new1' },
        { type: 'session', id: 'new2' },
      ]);
    });

    it('remaps IDs inside groups', () => {
      const saved: SavedState = {
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        groups: [{ id: 'g1', name: 'Group', sessionIds: ['old1', 'old2'], collapsed: true }],
        sidebarOrder: [{ type: 'group', id: 'g1' }],
        groupCounter: 1,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.groups.size).toBe(1);
      const group = result.groups.get('g1')!;
      expect(group.sessionIds).toEqual(['new1', 'new2']);
      expect(group.collapsed).toBe(true);
      expect(result.sidebarOrder).toEqual([{ type: 'group', id: 'g1' }]);
      expect(result.groupCounter).toBe(1);
    });

    it('disbands group when fewer than 2 sessions survive', () => {
      const saved: SavedState = {
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        groups: [{ id: 'g1', name: 'Group', sessionIds: ['old1', 'old2'], collapsed: false }],
        sidebarOrder: [{ type: 'group', id: 'g1' }],
        groupCounter: 1,
      };
      // Only old1 survived
      const idMap = new Map([['old1', 'new1']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.groups.size).toBe(0);
      // Surviving session should appear as standalone
      expect(result.sidebarOrder).toEqual([{ type: 'session', id: 'new1' }]);
    });

    it('skips sessions that failed to restore', () => {
      const saved: SavedState = {
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        groups: [],
        sidebarOrder: [
          { type: 'session', id: 'old1' },
          { type: 'session', id: 'old2' },
        ],
        groupCounter: 0,
      };
      // old2 failed to restore
      const idMap = new Map([['old1', 'new1']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([{ type: 'session', id: 'new1' }]);
    });

    it('appends sessions not in sidebar order', () => {
      const saved: SavedState = {
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
        ],
        groups: [],
        sidebarOrder: [{ type: 'session', id: 'old1' }],
        groupCounter: 0,
      };
      const idMap = new Map([['old1', 'new1'], ['old2', 'new2']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([
        { type: 'session', id: 'new1' },
        { type: 'session', id: 'new2' },
      ]);
    });

    it('preserves sidebar order across mixed sessions and groups', () => {
      const saved: SavedState = {
        sessions: [
          { id: 'old1', name: 'A', cwd: '/a' },
          { id: 'old2', name: 'B', cwd: '/b' },
          { id: 'old3', name: 'C', cwd: '/c' },
          { id: 'old4', name: 'D', cwd: '/d' },
        ],
        groups: [{ id: 'g1', name: 'Group', sessionIds: ['old2', 'old3'], collapsed: false }],
        sidebarOrder: [
          { type: 'session', id: 'old1' },
          { type: 'group', id: 'g1' },
          { type: 'session', id: 'old4' },
        ],
        groupCounter: 1,
      };
      const idMap = new Map([['old1', 'n1'], ['old2', 'n2'], ['old3', 'n3'], ['old4', 'n4']]);

      const result = reconstructFromSaved(saved, idMap);
      expect(result.sidebarOrder).toEqual([
        { type: 'session', id: 'n1' },
        { type: 'group', id: 'g1' },
        { type: 'session', id: 'n4' },
      ]);
      expect(result.groups.get('g1')!.sessionIds).toEqual(['n2', 'n3']);
    });
  });

  describe('handleDrop', () => {
    describe('merge zone', () => {
      it('creates a new group when merging two standalone sessions', () => {
        const state = createState({
          sidebarOrder: [
            { type: 'session', id: 's1' },
            { type: 'session', id: 's2' },
          ],
          groupCounter: 0,
        });
        const sessionIds = new Set(['s1', 's2']);

        handleDrop(state, sessionIds, 's1', 's2', 'merge', false);

        expect(state.groups.size).toBe(1);
        const group = state.groups.get('group-1')!;
        expect(group.sessionIds).toEqual(['s2', 's1']);
        expect(state.sidebarOrder).toEqual([{ type: 'group', id: 'group-1' }]);
      });

      it('adds session to existing group when merging onto grouped session', () => {
        const group = makeGroup('g1', ['s1', 's2']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [
            { type: 'group', id: 'g1' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 's1', 'merge', false);
        expect(group.sessionIds).toEqual(['s1', 's2', 's3']);
      });

      it('adds session to group when dropping on group header', () => {
        const group = makeGroup('g1', ['s1', 's2']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [
            { type: 'group', id: 'g1' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 'g1', 'merge', true);
        expect(group.sessionIds).toEqual(['s1', 's2', 's3']);
      });

      it('is a no-op when dragging onto self', () => {
        const state = createState({
          sidebarOrder: [{ type: 'session', id: 's1' }],
        });
        handleDrop(state, new Set(['s1']), 's1', 's1', 'merge', false);
        expect(state.sidebarOrder).toEqual([{ type: 'session', id: 's1' }]);
      });

      it('is a no-op when dragging already-grouped session onto its own group', () => {
        const group = makeGroup('g1', ['s1', 's2']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [{ type: 'group', id: 'g1' }],
        });
        handleDrop(state, new Set(['s1', 's2']), 's1', 'g1', 'merge', true);
        expect(group.sessionIds).toEqual(['s1', 's2']);
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

        handleDrop(state, sessionIds, 's3', 's1', 'above', false);
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

        handleDrop(state, sessionIds, 's1', 's2', 'below', false);
        expect(state.sidebarOrder).toEqual([
          { type: 'session', id: 's2' },
          { type: 'session', id: 's1' },
          { type: 'session', id: 's3' },
        ]);
      });

      it('inserts session above a group header', () => {
        const group = makeGroup('g1', ['s2', 's3']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [
            { type: 'session', id: 's1' },
            { type: 'group', id: 'g1' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's1', 'g1', 'above', true);
        expect(state.sidebarOrder).toEqual([
          { type: 'session', id: 's1' },
          { type: 'group', id: 'g1' },
        ]);
      });

      it('inserts into group at target position — above', () => {
        const group = makeGroup('g1', ['s1', 's2']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [
            { type: 'group', id: 'g1' },
            { type: 'session', id: 's3' },
          ],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 's1', 'above', false);
        expect(group.sessionIds).toEqual(['s3', 's1', 's2']);
      });

      it('ungroups session when dragged out and dropped below a group', () => {
        const group = makeGroup('g1', ['s1', 's2', 's3']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [{ type: 'group', id: 'g1' }],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's3', 'g1', 'below', true);
        expect(group.sessionIds).toEqual(['s1', 's2']);
        expect(state.sidebarOrder).toEqual([
          { type: 'group', id: 'g1' },
          { type: 'session', id: 's3' },
        ]);
      });

      it('disbands group when dragging out leaves only 1 member', () => {
        const group = makeGroup('g1', ['s1', 's2']);
        const state = createState({
          groups: new Map([['g1', group]]),
          sidebarOrder: [{ type: 'group', id: 'g1' }, { type: 'session', id: 's3' }],
        });
        const sessionIds = new Set(['s1', 's2', 's3']);

        handleDrop(state, sessionIds, 's2', 's3', 'below', false);
        // g1 had [s1, s2], s2 was removed → g1 disbanded, s1 becomes standalone
        expect(state.groups.size).toBe(0);
        expect(state.sidebarOrder).toEqual([
          { type: 'session', id: 's1' },
          { type: 'session', id: 's3' },
          { type: 'session', id: 's2' },
        ]);
      });
    });
  });
});

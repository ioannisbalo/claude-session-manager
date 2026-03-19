/**
 * Pure logic for sidebar state, group management, and state persistence.
 * No DOM, no window.api, no globals — fully testable.
 */

export interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed: boolean;
}

export interface SessionData {
  id: string;
  name: string;
  cwd: string;
}

export type SidebarEntry = { type: 'session'; id: string } | { type: 'group'; id: string };

export interface SavedState {
  sessions: Array<{ id: string; name: string; cwd: string }>;
  groups: SessionGroup[];
  sidebarOrder: SidebarEntry[];
  groupCounter: number;
}

export interface AppState {
  groups: Map<string, SessionGroup>;
  sidebarOrder: SidebarEntry[];
  groupCounter: number;
}

export function getGroupForSession(groups: Map<string, SessionGroup>, sessionId: string): SessionGroup | undefined {
  for (const group of groups.values()) {
    if (group.sessionIds.includes(sessionId)) return group;
  }
  return undefined;
}

/**
 * Remove dead sessions from groups. Disband groups with fewer than 2 members.
 */
export function enforceGroupIntegrity(state: AppState, sessionIds: Set<string>): void {
  for (const [groupId, group] of state.groups) {
    group.sessionIds = group.sessionIds.filter(id => sessionIds.has(id));

    if (group.sessionIds.length <= 1) {
      const remainingId = group.sessionIds[0];
      const idx = state.sidebarOrder.findIndex(e => e.type === 'group' && e.id === groupId);
      if (idx !== -1) {
        if (remainingId) {
          state.sidebarOrder[idx] = { type: 'session', id: remainingId };
        } else {
          state.sidebarOrder.splice(idx, 1);
        }
      }
      state.groups.delete(groupId);
    }
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
      const group = state.groups.get(entry.id);
      if (group) {
        for (const sid of group.sessionIds) {
          if (sessionIds.has(sid)) result.push(sid);
        }
      }
    }
  }
  return result;
}

/**
 * Remove a session from the sidebar order and from any group it belongs to.
 */
export function removeSidebarEntry(state: AppState, sessionId: string): void {
  state.sidebarOrder = state.sidebarOrder.filter(e => !(e.type === 'session' && e.id === sessionId));
  const group = getGroupForSession(state.groups, sessionId);
  if (group) {
    group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
  }
}

/**
 * Build a serializable saved state from live data.
 */
export function buildSavedState(sessions: Map<string, SessionData>, state: AppState): SavedState {
  const savedSessions = Array.from(sessions.entries()).map(([id, s]) => ({
    id, name: s.name, cwd: s.cwd,
  }));
  const savedGroups = Array.from(state.groups.values());
  return {
    sessions: savedSessions,
    groups: savedGroups,
    sidebarOrder: state.sidebarOrder,
    groupCounter: state.groupCounter,
  };
}

/**
 * Reconstruct groups and sidebar order from saved state using an old→new ID mapping.
 * Returns the reconstructed AppState fields and any session IDs not placed in the sidebar.
 */
export function reconstructFromSaved(
  saved: SavedState,
  idMap: Map<string, string>,
): AppState {
  const groups = new Map<string, SessionGroup>();
  const sidebarOrder: SidebarEntry[] = [];

  // Rebuild groups with remapped IDs
  for (const savedGroup of saved.groups) {
    const remappedIds = savedGroup.sessionIds
      .map(id => idMap.get(id))
      .filter((id): id is string => id !== undefined);
    if (remappedIds.length >= 2) {
      const group: SessionGroup = {
        id: savedGroup.id,
        name: savedGroup.name,
        sessionIds: remappedIds,
        collapsed: savedGroup.collapsed,
      };
      groups.set(group.id, group);
    }
  }

  // Rebuild sidebar order
  for (const entry of saved.sidebarOrder) {
    if (entry.type === 'session') {
      const newId = idMap.get(entry.id);
      if (newId) sidebarOrder.push({ type: 'session', id: newId });
    } else {
      if (groups.has(entry.id)) {
        sidebarOrder.push({ type: 'group', id: entry.id });
      } else {
        // Group was disbanded (< 2 members survived) — add surviving members as standalone
        const savedGroup = saved.groups.find(g => g.id === entry.id);
        if (savedGroup) {
          for (const oldId of savedGroup.sessionIds) {
            const newId = idMap.get(oldId);
            if (newId) sidebarOrder.push({ type: 'session', id: newId });
          }
        }
      }
    }
  }

  // Find sessions not yet in sidebar (edge case)
  const allNewIds = new Set(idMap.values());
  const inOrder = new Set(getVisibleSessionOrder({ groups, sidebarOrder, groupCounter: saved.groupCounter }, allNewIds));
  for (const newId of allNewIds) {
    if (!inOrder.has(newId)) {
      sidebarOrder.push({ type: 'session', id: newId });
    }
  }

  return {
    groups,
    sidebarOrder,
    groupCounter: saved.groupCounter,
  };
}

/**
 * Handle a drag-and-drop operation between sessions/groups.
 */
export function handleDrop(
  state: AppState,
  sessionIds: Set<string>,
  draggedId: string,
  targetId: string,
  zone: 'above' | 'below' | 'merge',
  targetIsGroup: boolean,
): void {
  if (draggedId === targetId) return;

  if (zone === 'merge') {
    if (targetIsGroup) {
      const group = state.groups.get(targetId);
      if (!group) return;
      if (group.sessionIds.includes(draggedId)) return;
      removeSidebarEntry(state, draggedId);
      enforceGroupIntegrity(state, sessionIds);
      group.sessionIds.push(draggedId);
    } else {
      const targetGroup = getGroupForSession(state.groups, targetId);
      if (targetGroup) {
        if (targetGroup.sessionIds.includes(draggedId)) return;
        removeSidebarEntry(state, draggedId);
        enforceGroupIntegrity(state, sessionIds);
        targetGroup.sessionIds.push(draggedId);
      } else {
        removeSidebarEntry(state, draggedId);
        enforceGroupIntegrity(state, sessionIds);

        state.groupCounter++;
        const newGroup: SessionGroup = {
          id: `group-${state.groupCounter}`,
          name: `Group ${state.groupCounter}`,
          sessionIds: [targetId, draggedId],
          collapsed: false,
        };
        state.groups.set(newGroup.id, newGroup);

        const targetIdx = state.sidebarOrder.findIndex(e => e.type === 'session' && e.id === targetId);
        if (targetIdx !== -1) {
          state.sidebarOrder[targetIdx] = { type: 'group', id: newGroup.id };
        }
      }
    }
  } else {
    removeSidebarEntry(state, draggedId);
    enforceGroupIntegrity(state, sessionIds);

    if (targetIsGroup) {
      const idx = state.sidebarOrder.findIndex(e => e.type === 'group' && e.id === targetId);
      if (idx !== -1) {
        const insertIdx = zone === 'above' ? idx : idx + 1;
        state.sidebarOrder.splice(insertIdx, 0, { type: 'session', id: draggedId });
      }
    } else {
      const targetGroup = getGroupForSession(state.groups, targetId);
      if (targetGroup) {
        const tIdx = targetGroup.sessionIds.indexOf(targetId);
        const insertIdx = zone === 'above' ? tIdx : tIdx + 1;
        targetGroup.sessionIds.splice(insertIdx, 0, draggedId);
      } else {
        const idx = state.sidebarOrder.findIndex(e => e.type === 'session' && e.id === targetId);
        if (idx !== -1) {
          const insertIdx = zone === 'above' ? idx : idx + 1;
          state.sidebarOrder.splice(insertIdx, 0, { type: 'session', id: draggedId });
        }
      }
    }
  }

  enforceGroupIntegrity(state, sessionIds);
}

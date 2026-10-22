# Task Sidebar (Phase 2c) — Design

**Date:** 2026-10-21
**Status:** Approved, pending plan
**Parent spec:** `2026-10-21-task-centric-architecture-design.md`

## Context

Phases 1, 2a and 2b landed the durable `Task` model, carried the pane layout
through migration, and collapsed three copies of the state algorithms into one
bundled module. None of it is reachable from the UI: the sidebar still renders
tasks as if they were the groups they replaced, nothing calls `isTaskVisible`,
and there is no way to create or delete a task.

This phase makes the task list the thing you actually look at.

## The three structural decisions

### 1. The sidebar is sectioned by status

Four sections in fixed order. Doing and Backlog are always shown, each owning a
`+`. Done and Loose sessions are hidden when empty. Backlog is collapsed by
default — it is a backlog, not a work surface.

```
Doing            +     ← status 'doing'
  ▾ Fix webhook retry  ✓ ✎ ×
      ● bloc-api            ×
      ● bloc-worker         ×
Backlog       12 +     ← status 'backlog', collapsed by default
Done                   ← status 'done' AND isTaskVisible(task, now)
  ✓ Patch CVE      ↺ ×
Loose sessions         ← sessions belonging to no task
  ● scratch             ×
```

Rejected: a single flat task list, which keeps `sidebarOrder` untouched but lets
a long backlog bury the two or three things actually in flight. Also rejected:
sessions-first with a backlog drawer, which is closest to today's code but makes
the todo list second-class — the opposite of the point.

Sections give `isTaskVisible` its first consumer: the Done strip shows a task
only while it is inside the 24h window, so completed work ages out on its own —
**except while it still holds live sessions**. A done task whose window lapsed
with a session still running would vanish from every section, and because
"loose" means *belongs to no task*, its sessions would not be loose either:
they would keep running, unreachable from the sidebar and from Cmd+Arrow. So
the rule is `status === 'done' && (isTaskVisible(task, now) || hasLiveSessions)`.
Ageing out is **hiding, not deleting** — the task stays in the store, which is
what keeps a derived standup view possible later.

### 2. Row order is derived, not dragged

`sidebarOrder` is deleted. Ordering comes from the data:

- **Doing** and **Backlog**: `createdAt` ascending, oldest first
- **Done**: `completedAt` descending, most recently closed first

Oldest-first keeps positions stable — new tasks append at the bottom and nothing
jumps while you work. Newest-first was rejected for a specific bad interaction:
picking up a long-standing backlog item would drop it to the *bottom* of Doing,
hiding the thing you just chose to work on. This is the cheapest decision to
revisit, being one comparator.

Manual ordering was rejected because position and section would come from two
different sources that can disagree, and because hand-ordering a Doing list of
two to four items is ceremony. Dropping it deletes `sidebarOrder` (13 references
in `app.ts`), the above/below drop zones, and `handleDrop`'s reorder branch.

**Acknowledged cost:** Phases 1 and 2b carefully preserved `sidebarOrder`, and
this phase deletes it. Designing the model before the interface caused that
work. It was not wasted — it kept the app running throughout — but had the UI
been designed first, it would not have been done.

### 3. Status changes through a contextual button

One button per task row whose meaning follows its section:

| Section | Button | Effect |
|---|---|---|
| Doing | `✓` | → `done` |
| Backlog | `▶` | → `doing` |
| Done | `↺` | → `doing` |

Revealed on hover, along with the other row controls (2026-10-22). This
reverses the original decision to keep the status button always visible: with
four controls reserving width on every row, the title — the thing you actually
read — was squeezed into a fraction of a narrow sidebar. `display: none` rather
than `visibility: hidden`, so the space is genuinely returned. The cost is one
hover before the primary verb is clickable. All three call `setTaskStatus(task, status, Date.now())`, which
maintains `completedAt` and therefore drives the Done strip's window.

Drag-between-sections was rejected as slow for an action repeated all day, and
awkward when Backlog is collapsed, which is its default. Keyboard-only was
rejected as invisible, and it needs a notion of row selection the sidebar does
not have.

## Interaction details

**Row anatomy.** Task: `▾ title [▶|✓|↺] ✎ × (n)`. At rest only the collapse
icon, title and session count show; every control appears on hover, so a narrow
row is not drowned and the title gets the full width it is read at. Session
rows keep today's `● name ×`.

**Creating tasks.** `+` in the Doing or Backlog header opens an inline input in
that section; Enter commits, Esc cancels. Reuses the existing `startRenameInput`
helper, so capture is two keystrokes.

**Attaching sessions.** Either `+ session` on a task row, which opens today's
directory picker and attaches the result, or dragging a loose session onto a task
row — the one surviving branch of `handleDrop`. Phase 3 replaces the picker with
the task's configured repos.

**Deleting a task orphans its sessions to Loose; it never kills a Claude
session.** Killing stays the explicit `×` on a session row. Deleting a todo item
should not terminate running work, and orphaning is recoverable where killing is
not. This also resolves the "empty task is permanent" problem the Phase 1 review
raised: the disband rule used to clean up emptied containers and nothing had
replaced it.

## Model changes

Removed:

- `sidebarOrder` from `AppState` and `SavedState`
- The `SidebarEntry` type
- `migrateSavedState` stops emitting ordering (v1's `sidebarOrder` carried only
  order, which is now derived; group *membership* lives in `groups[].sessionIds`
  and is unaffected)
- `handleDrop`'s above/below and task-creating branches

Renamed / reshaped:

- `removeSidebarEntry(state, sessionId)` → `detachSession(state, sessionId)`
- `handleDrop(...)` → `attachSessionToTask(state, sessionId, taskId)`
- `getVisibleSessionOrder(state, sessionIds)` — still required for Cmd+Arrow
  navigation — becomes derived from `partitionSidebar`: walk Doing, then
  Backlog, then Done, then Loose, concatenating each task's live sessions in
  `sessionIds` order. Tasks with no live sessions contribute nothing, and a
  collapsed Backlog does not change the order — collapse is presentation only,
  so Cmd+Arrow still reaches a collapsed section's sessions

Added:

- `createTask(state, title, status, now): Task`
- `deleteTask(state, taskId): void` — detaches sessions, never kills them
- `partitionSidebar(state, liveSessionIds, now): { doing, backlog, done, loose }`
  — returns the four buckets already ordered, so the ordering rules are tested
  rather than buried in render code. `doing`/`backlog`/`done` hold `Task[]`,
  `loose` holds session ids

`taskCounter` survives, now used only by `createTask` for ids.

## Testing

The pure logic extends `app-state-logic.test.ts` as usual: `createTask`,
`deleteTask` orphaning sessions rather than dropping them, `detachSession`,
`attachSessionToTask`, section partitioning including the Done window boundary,
and derived navigation order. The renderer has no tests by design, so its gate
is `npm run build` plus a manual run.

Specific cases worth pinning, since they are the ones a vision document would
leave silent: deleting a task whose sessions are live, a Done task crossing the
24h boundary while the app is open, attaching a session that already belongs to
another task, and navigation order when Backlog is collapsed.

## What this unblocks

Phase 3 attaches repos to a task and creates worktrees. Its hook is the
`+ session` affordance defined here: today it opens a directory picker, and
Phase 3 replaces that with the task's configured repos without changing the
surrounding interaction.

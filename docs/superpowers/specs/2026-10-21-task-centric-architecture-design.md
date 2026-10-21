# Task-Centric Architecture — Design

**Date:** 2026-10-21
**Status:** Approved for Phase 1

## Context

The app began as a Claude Code session manager whose differentiator was heuristic
state detection plus notifications. iTerm now offers equivalent state detection,
and the author moved to it — the app lost its reason to exist in its original form.

The replacement premise: **the unit of work stops being the session and becomes the
task.** Nothing currently owns "this piece of work, its repos, its worktrees, its
agent sessions, its branches, its PRs" — iTerm owns terminals, Claude Code owns
conversations, Jira owns tickets. That gap is the target.

## Premise: personal daily driver

This is a single-user tool. It will not be generalized or commercialized; the
market is moving toward developers building flows that fit themselves.

Consequences that bind every decision below:

- Hardcoding is correct. No config layer, no plugin seams, no abstraction over
  editors, hosts or issue trackers. Hardcode BLOC, the branch naming, iTerm, macOS.
- Generalization is pure cost with no return. The usual counterargument — someone
  else has to maintain this — does not exist here.
- **Adoption is the only risk that matters.** A tool the author does not open is
  worth exactly zero, and there is no second user to justify the code. The author
  has already abandoned this app once.

## Goals

- A task list that is a first-class citizen, good enough to displace macOS Notes
- Tasks that own their repos, worktrees and agent sessions
- Task-level status, so "what needs me right now" is answerable without looking

## Non-goals

- Shipping to anyone else, in any form
- Beating iTerm at being a terminal. Manual terminal work gets escape hatches
  ("open this worktree in iTerm / editor") rather than a better pane
- A general-purpose todo app. No recurrence, no due dates, no sharing, no sync

## The core change: inverting the lifetime

`SessionGroup` (`src/app-state-logic.ts:6`) is already ~80% of a Task structurally:
`id`, `name`, `sessionIds[]`, `collapsed`, ordered in the sidebar. What differs is
lifetime. `enforceGroupIntegrity` disbands any group holding fewer than two
sessions, which makes groups *ephemeral decorations over live sessions*.

A task is the opposite: it exists **before** any session is opened and persists
**after** every one of them dies.

So this is not "add a Task entity alongside groups". It is inverting ownership —
the task becomes the durable root and sessions become disposable children. The
`sessionIds.length <= 1` branch *is* the ephemeral lifetime; deleting it is the
architectural change, and a zero-session task becoming legal is what turns it into
a todo item.

Tasks supersede manual groups entirely. Drag-and-drop grouping is replaced by task
membership, so pane grouping stops being arbitrary and becomes **derived from the
data model**.

## Data model

```ts
export type TaskStatus = 'backlog' | 'doing' | 'done';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
  completedAt?: number;   // set on → done, cleared on reopen
}
```

`repos[]` is deliberately absent until Phase 3.

- `SidebarEntry`'s `{ type: 'group' }` variant is **replaced by** `{ type: 'task' }`,
  not joined by it — groups cease to exist as a concept. Loose sessions stay legal,
  so a throwaway session does not have to be filed under a task.
- `groupCounter` is dropped. Tasks have user-supplied titles, not "Group 3".
- `SavedState` gains a `version` field.

## Done-task visibility: derived, not scheduled

Done tasks remain visible for 24 hours, expressed as a pure function:

```ts
isTaskVisible(task, now)  // done && now - completedAt > 24h → false; otherwise true
```

`backlog` and `doing` tasks are always visible. The rule applies only to `done`, and
a `done` task with no `completedAt` (which migration cannot produce, but a hand-edited
state file could) is treated as visible rather than silently vanishing.

No timer, no background sweep, no mutation. It is correct across app restarts and
laptop sleep for free, and is tested by passing `now`.

**Hidden is not deleted.** Done tasks stay in the store and only drop out of the
default view. This costs nothing now and preserves the ability to derive a standup
view later from tasks plus their commits and branches — purging on a timer would
destroy that option permanently.

## Migration

`SavedState` v1 (no version field) → v2. Each existing group becomes a task:
`name` → `title`, `collapsed` and `sessionIds` carried over verbatim, `status` set
to `doing`, `createdAt` set to the migration timestamp, `completedAt` left unset.
Un-grouped sessions stay loose. Cheap either way at this data volume, but it avoids
losing the current session organisation on upgrade.

## Known constraint: the duplicated state logic

`src/renderer/appState.ts` is a near-twin of `src/app-state-logic.ts`, using
module-level globals rather than a passed-in state object. The renderer cannot
import the tested module: renderer scripts load as plain `<script>` tags, and
adding an import would emit untransformed ESM into a classic script.

`src/renderer/app.ts` references groups **59 times**.

Consequence for sequencing: Phase 1 changes the tested copy only and leaves the
running app working on groups. Porting the renderer is its own phase, so the model
is proven in tests before 500-line UI files are edited. If this duplication becomes
painful as tasks grow, introducing a renderer bundler is the escape hatch — out of
scope here.

## Phasing

1. **Inversion in the tested copy** — specified below
2. **Renderer port + task sidebar UI** — makes it real; dogfood against Notes
3. **Repos on a task + worktree creation**
4. **Worktree lifecycle** — branch, PR, prune. The unglamorous part that decides
   usability; creation without pruning is a mess generator
5. **State detection via JSONL transcripts / hooks** — see prior work below
6. **Jira linkage** — store the ticket key on the task; link, never duplicate

Phases 2–6 are intent, not specification. Each gets its own design pass.

## Phase 1 — specification

**Scope:** `src/app-state-logic.ts` and `src/app-state-logic.test.ts` only. The
running app is untouched.

**Changes:**

- `SessionGroup` → `Task` with the fields above
- Delete the `sessionIds.length <= 1` disband branch (`:44`)
- Keep dead-session pruning from that function; rename to `pruneDeadSessions`
- `SidebarEntry`: replace the `{ type: 'group' }` variant with `{ type: 'task' }`;
  loose sessions remain legal
- Add `isTaskVisible(task, now)`
- `SavedState` gains `version`; add v1 → v2 migration
- Drop `groupCounter`

**Tests** (extending the existing harness):

- A task survives with zero sessions — the inversion itself
- `isTaskVisible` at boundary offsets either side of 24h
- Reopening a done task clears `completedAt`
- v1 → v2 migration preserves existing groups as tasks
- Dead session IDs are still pruned from tasks

**Acceptance:** `npm run build` and `npm test` pass; the app still launches and
behaves exactly as before, since nothing it loads has changed.

## Prior work: `jsonl-reading-for-state-transition`

Branch `94e657a` (2026-03-23, unmerged) adds `jsonl-session-resolver.ts` and
`jsonl-watcher.ts` with tests, and substantially guts `state-detector.ts` and its
tests — replacing heuristic screen parsing with reads of Claude Code's own
structured transcripts at `~/.claude/projects/<slug>/<sessionId>.jsonl`.

This is the Phase 5 direction, already half-built. It does not overlap Phase 1
(different files entirely). However, `master` has since advanced past it with
542a5b6, which further evolved the heuristic detector the draft deletes, so the
branch likely conflicts with current `master`.

**Open decision, before Phase 5:** land it, rebase it, or discard and redo. Not
blocking.

## Rejected alternatives

- **Orchestrate iTerm instead of hosting sessions ("From").** Would delete ~2,770
  of 4,680 lines and reduce the repo to a donor for its Electron shell. Rejected
  because it loses mid-session prompt and skill injection into a live session, and
  the single-window view of a task beside its work. Note that most *other*
  advantages of owning the PTY do have cleaner equivalents — hooks for state,
  JSONL transcripts for history, `claude -p` for unattended runs, argv for the
  first prompt.
- **Removing multi-pane.** Rejected: a task spanning several repos means several
  worktrees and several sessions, which is exactly the side-by-side case. Under the
  task model panes are better justified than before, because grouping becomes
  principled rather than hand-dragged. Per-task layout memory falls out for free.
- **Jira, Apple Reminders or an iCloud file as the task store.** Deferred, not
  refused. A local store ships fastest and the metadata that matters here — repos,
  worktrees, session links, branch state — is not modelled by any of them. Revisit
  only if the absence of capture away from the laptop actually bites.
- **Purging done tasks on a timer.** Rejected; see above.

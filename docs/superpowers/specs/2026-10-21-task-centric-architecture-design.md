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
a todo item. The rule is encoded **twice**: `enforceGroupIntegrity` applies it at
runtime and `reconstructFromSaved` re-applies it on load via `remappedIds.length >= 2`.
Both must go, or state reloads would silently undo the inversion.

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
- `groupCounter` survives as `taskCounter`, but only to generate ids (`task-1`,
  `task-2`) so they stay deterministic and testable. It no longer feeds titles:
  a task created by merging two sessions is titled "New task".
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
2. **Renderer port + task sidebar UI** — makes it real; dogfood against Notes.
   Split in execution: **2a** carry the pane layout through migration *(done)*,
   **2b** bundle the module and delete the duplicate implementations *(done)*,
   **2c** the task sidebar itself — see
   `2026-10-21-task-sidebar-design.md`
2d. **Task detail modal** — one creation/edit surface carrying description,
   type, repos and links. Comes before Phase 3 because it is the surface that
   phase's metadata is entered through. See
   `2026-10-22-task-detail-modal-design.md`
3. **Repos on a task + worktree creation** — see
   `2026-10-26-worktrees-and-repos-design.md`
4. **Worktree lifecycle** — branch, PR, prune. The unglamorous part that decides
   usability; creation without pruning is a mess generator
5. **State detection** — *deferred, not sequenced.* The current heuristic works;
   findings are recorded below so the decision is not re-litigated. Independent of
   every other phase
6. **Issue-tracker linkage** — the task carries a vendor-neutral `ticketKey` (added in Phase 3) and links out; the app never talks to a tracker itself

### Captured, not yet designed

Raised 2026-10-21 after the first day of use. Recorded so they are not lost;
neither has had a design pass.

- **Task types**, drawn from the groups of work that actually recur: MR review,
  research, implementation, bugfix. The point is not a label but that each type
  is *treated differently* — what gets created, what the agent is told, and
  whether a repo is even involved. MR review is the clearest case that it is not
  simply "a task with a tag": it does not create a worktree so much as fetch
  someone else's branch, and research may want no repo at all. The design
  question is which axes vary by type: worktree strategy, the starting prompt or
  skill, whether a session is needed, the default status flow.
- **How a task jumpstarts its session** — answered 2026-10-22, by testing the
  CLI rather than reasoning about it. Three mechanisms exist, and they are not
  interchangeable:

  1. **argv initial prompt.** `claude "<prompt>"` takes a prompt positionally,
     and a slash command there **is** resolved as a skill. Verified with
     `claude -p "/zzz-definitely-not-a-real-skill"`, which answered "isn't
     installed in this session, so nothing ran" and suggested the real ones —
     "nothing ran" being the tell that a real skill would have. `SessionManager`
     already builds an args array (it passes `--continue`), so this is a small
     change.
  2. **PTY injection after spawn.** Writing `/skill-name\n` to the terminal.
     Already wired end to end (`SessionManager.write`, the `session:input`
     channel) and, unlike argv, works mid-session. The catch is timing: injected
     before Claude Code's TUI is ready, the keystrokes are swallowed. The signal
     for "ready" already exists — `StateDetector` reports the session reaching
     `idle` — so the sequence is spawn → await first idle → inject.
  3. **`--agent <agent>`**, which configures the session rather than issuing a
     command, with `--append-system-prompt` available to carry standing context.
     For a Review task "this session *is* a reviewer" may beat "this session
     opens by running the review skill", since the framing persists across the
     whole conversation instead of being one opening move.

  Skills are slash commands — `--disable-slash-commands` is documented as
  "Disable all skills and commands" — so anything typeable is reachable by all
  three routes.

  **What this makes concrete:** per-type behaviour collapses to roughly
  `{ worktree: boolean, initialPrompt: template, agent?: string }` —

  | Type | Worktree | Opening move |
  |---|---|---|
  | Review | no — fetch someone else's branch | a review skill |
  | Feature | yes | the task description |
  | Bug | yes | description, plus "reproduce first" |
  | Chore | yes | none |
  | Spike | possibly no repo at all | the description |

  **The choice still open:** argv means the opening move happens before you see
  the session; injection means you watch it arrive in the pane. For a
  description-as-prompt, argv is cleaner. For a skill on a Review task,
  injection may be better — seeing `/pre-push-review` land makes it obvious what
  the session was told to do, rather than it appearing to start mid-thought.

- **A fuller task creation surface** — a modal rather than the inline title
  input, carrying a description and links. Worth noting this is not cosmetic:
  the description is the natural source of the *starting prompt* for a task's
  session, which is the one capability the embedded terminal was kept for (see
  "Rejected alternatives"). The inline input stays the fast path for capture;
  the modal is for a task you are about to work on.

Phases 2–4 and 6 are intent, not specification; each gets its own design pass.
Phase 5 is parked rather than queued — it carries no dependency in either direction.

## Phase 1 — specification

**Scope:** `src/app-state-logic.ts` and `src/app-state-logic.test.ts` only. The
running app is untouched.

**Changes:**

- `SessionGroup` → `Task` with the fields above
- Delete the disband rule in **both** places it lives: the `sessionIds.length <= 1`
  branch in `enforceGroupIntegrity` (`:44`), and the `remappedIds.length >= 2` guard
  plus its disband-fallback branch in `reconstructFromSaved`
- Keep dead-session pruning from that function; rename to `pruneDeadSessions`
- `SidebarEntry`: replace the `{ type: 'group' }` variant with `{ type: 'task' }`;
  loose sessions remain legal
- Add `isTaskVisible(task, now)`
- `SavedState` gains `version`; add v1 → v2 migration
- Rename `groupCounter` → `taskCounter`; it generates ids only, never titles

**Tests** (extending the existing harness):

- A task survives with zero sessions — the inversion itself
- `isTaskVisible` at boundary offsets either side of 24h
- Reopening a done task clears `completedAt`
- v1 → v2 migration preserves existing groups as tasks
- Dead session IDs are still pruned from tasks

**Acceptance:** `npm run build` and `npm test` pass; the app still launches and
behaves exactly as before, since nothing it loads has changed.

## Deferred: state detection

**Status: parked.** The heuristic detector on `master` works, and is the chosen
solution until something forces a change. This is **independent of Phases 1–4** —
they touch the task model, sidebar, worktrees and lifecycle, while state detection
lives in `state-detector.ts` and `session-manager.ts`. Revisit only when the
heuristic actually breaks.

The findings below are recorded so this ground is not covered a third time.

### Rejected: reading JSONL transcripts

Branch `jsonl-reading-for-state-transition` (`94e657a`, 2026-03-23, one commit,
unmerged). Adds `jsonl-session-resolver.ts` and `jsonl-watcher.ts` with tests, and
cuts `state-detector.ts` from 366 to 135 lines.

*How it worked:* the resolver maps cwd → `~/.claude/projects/<cwd with / and . as ->`,
snapshots `*.jsonl` before spawn, then either polls for a newly-appeared file (fresh
session; 1s interval, 30s timeout) or takes the most-recently-modified file from the
snapshot (`--continue`). The watcher tails that file with `fs.watchFile` at 500ms,
tracking a byte offset and buffering partial lines, and emits `turn-end` on
`{ type: 'system', subtype: 'turn_duration' }`. `session-manager` calls
`classifyNow()` on that edge.

*Why rejected:*

- **It is a hybrid, not a replacement.** Every screen pattern survives; the JSONL
  supplies only the *timing* of a turn edge. It adds machinery instead of removing it.
- Depends on `turn_duration`, an undocumented internal record type. If that is ever
  renamed, detection does not degrade — it silently never fires again.
- The `--continue` resolver picks "most recently modified file", which misattributes
  whenever two sessions share a repo.
- A fresh session whose transcript does not appear within 30s gets no detection at
  all, permanently.
- **Superseded.** `8d0d7c7` (2026-04-16, "update state transition to a wait → fire
  model") solved the timing problem inside the screen-polling approach three weeks
  later, removing the only thing the branch bought; `542a5b6` (2026-07-19) improved
  it further.
- Observed in practice to make detection worse.

**Delete the branch; do not rebase it.** Every pre-existing file it touches except
`README.md` has since moved on `master`, so a rebase would be a rewrite.

### Most promising route when revisited: the managed-hook shim

Hooks were the original instinct and were blocked by `"allowManagedHooksOnly": true`
in the enterprise managed settings — user- and project-level hooks are ignored.

However, the managed config already defines the two hooks that matter, and they are
an extension point:

| Hook | Command | Means |
|---|---|---|
| `Stop` | `cmux notify --body "Done — needs input"` | turn finished → `idle` |
| `Notification`, matcher `idle_prompt\|permission_prompt\|agent_needs_input` | `cmux notify --body "Waiting for your input"` | blocked on the user → `needs-input` |

Both are gated on `$CMUX_NOTIFY_ENABLED` and both invoke an **unqualified binary
resolved from `PATH`**. `cmux` is not installed and the gate is unset, so they are
currently inert.

The app controls the environment of every session it spawns (`session-manager.ts:46`
builds the env, `:62` passes it to `pty.spawn`). For its own sessions it can set
`CMUX_NOTIFY_ENABLED=true` and prepend a directory containing its own `cmux` shim.
Nothing outside those sessions is affected.

*The payoff:* the two hooks carry different bodies, yielding `idle` versus
`needs-input` as **fact reported by Claude Code**, at the moment it is true, rather
than inference from screen text. That is exactly the distinction the pattern tables
exist to guess at — and it is what JSONL tailing could never provide, since that
reported only *that* a turn ended, never *why* Claude stopped.

*Session attribution:* inject a per-session env var the shim reads back, or use the
hook's stdin JSON if it carries `session_id` — verify before relying on it.

*Open question before adopting:* `allowManagedHooksOnly` exists to control which
commands run, and supplying the binary a managed hook invokes changes what one of
them is. Nothing legitimate is displaced and the purpose matches the hook's stated
intent, but confirm with the owner of the managed config first.

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

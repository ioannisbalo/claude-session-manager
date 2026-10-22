# Task Detail Modal (Phase 2d) — Design

**Date:** 2026-10-22
**Status:** Approved, pending plan
**Parent spec:** `2026-10-21-task-centric-architecture-design.md`

## Context

Phase 2c made the task list usable: four status sections, one-click status
changes, create/delete. Tasks carry a title and nothing else.

Everything that comes next — types that are treated differently, repos that
become worktrees, a description that becomes an agent's starting prompt — needs
somewhere to be entered. Without a shared surface each one would arrive as its
own cramped affordance on a row that already clips four buttons. The modal is
that surface, which is why it comes before Phase 3 rather than alongside it.

## Decisions

### The modal replaces the inline `+`

There is one creation path. `+` on a section header opens the modal in create
mode, carrying the status to create in.

Rejected: keeping the inline input for fast capture and using the modal only for
detail. That preserves two-keystroke capture, which matters for a Notes-style
bulk paste, at the cost of two affordances and a rule for which opens when. The
single path was chosen deliberately, with that cost understood.

To keep capture viable anyway, the modal is keyboard-first (below).

### Only the title is required

Title, description, type, repos and links. Everything except the title is
optional, and a task captured in a hurry is just a title — the same thing the
inline input produced.

### Type values

`Feature`, `Bug`, `Chore`, `Review`, `Spike`, plus untyped as the default, since
most captures will not have one yet.

### Editing uses the same modal

The row's `✎` opens the modal in edit mode. The inline rename is retired **for
tasks** — the modal owns the title now, and two editing paths that can disagree
is the kind of duplication Phase 2b existed to remove. Session rename keeps its
inline input and its `renameInProgress` guard.

## The modal

**Modes.** Create (from a section `+`, pre-set to that section's status) and edit
(from a row's `✎`). Same form; create writes a new task on save, edit mutates the
existing one in place, leaving `status`, `collapsed`, `createdAt`, `completedAt`
and `sessionIds` untouched.

Create is reachable only from Doing and Backlog, since Phase 2c removed the Done
section's `+` — a task created directly as done never gets a `completedAt` and
would never age out. Edit is reachable from a row in any section.

**Fields.**

| Field | Control | Required |
|---|---|---|
| Title | text input | yes — blank disables save |
| Description | textarea | no |
| Type | select, default untyped | no |
| Repos | list with "Add…" opening a directory picker | no |
| Links | list with "Add…" revealing an inline input; `Enter` adds | no |

Both lists render their entries with a `×` to remove, and store order of
addition. Neither deduplicates — adding the same repo twice is the user's
business, and silently dropping an entry is worse than a duplicate row.

**Keyboard**, which is what keeps bulk capture workable now that `+` is a modal:

- Opens with the title focused
- `Enter` **in the title field only**, and **only in create mode**, saves and
  keeps the modal open, cleared, in the same section — a run of captures is
  type-Enter-type-Enter. In edit mode it saves and closes, since there is no
  next task to capture. Everywhere else `Enter` behaves natively: a newline in
  the description, nothing in a select.
- `Cmd+Enter` saves and closes, from any field, in both modes
- `Esc` discards and closes. In edit mode that means discarding the edits, not
  the task.

**Validation.** A blank or whitespace-only title disables save. Nothing else is
validated: this is a single-user tool and a wrong link is the user's to fix.

**Side effect.** Because the task is only created on save, the Phase 2c defect
where `Esc` after `+` left a stray "New task" row disappears rather than needing
its own fix.

## Data model

`Task` gains four optional fields:

```ts
export type TaskType = 'feature' | 'bug' | 'chore' | 'review' | 'spike';

export interface Task {
  // … existing fields …
  description?: string;
  type?: TaskType;
  repos?: string[];
  links?: string[];
}
```

All optional, so **no `SAVED_STATE_VERSION` bump**: existing v2 files load
unchanged, and `toTask` already defaults fields it does not find. A task written
before this phase simply has none of them.

`createTask` grows to accept the optional fields rather than title alone.

## Plumbing beyond the modal

- **A directory picker that does not create a session.** Today's picker is wired
  into `session:create`, which spawns a process with the chosen path. Repos need
  a new `dialog:pick-directory` IPC channel that only returns a path.
- **Clickable links** reuse the existing `openUrl` bridge, which is already
  restricted to `http://` and `https://`.

## Deliberately inert

`type` and `repos` are stored and displayed but **change nothing** until Phase 3.
The modal must not imply otherwise — no copy promising worktrees. This was chosen
with the cost understood: the alternative was adding them later alongside their
behaviour, at the price of reopening every existing task to fill them in.

## Testing

The pure layer extends `app-state-logic.test.ts`: `createTask` accepting and
defaulting the new fields, a pre-2d task loading without them, and title
validation. The modal is renderer code and has no tests by design — its gate is
`npm run build` plus using it.

Worth pinning specifically, since a vision document stays silent on them: a task
saved with an empty repos/links array versus none at all, editing a task whose
type was removed, and a title that is whitespace only.

## What this unblocks

Phase 3 attaches behaviour to the fields this phase captures: `repos` drives
worktree creation, `type` decides what that creation means (a Review fetches
someone else's branch; a Spike may want no repo at all), and `description`
becomes the starting prompt injected into a task's first session — the capability
the embedded terminal was kept for.

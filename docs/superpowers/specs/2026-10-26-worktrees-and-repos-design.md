# Repos and Worktrees (Phase 3) — Design

**Date:** 2026-10-26
**Status:** Approved, pending plan
**Parent spec:** `2026-10-21-task-centric-architecture-design.md`

## Context

Phase 2d gave a task a `repos` list, captured but inert — nothing reads it. This
phase makes it mean something: picking up a task creates a worktree in each of
its repos, on one shared branch, and opens a session in each.

This is the part the whole task-centric shift was for. It is also the part where
the tedium scales: one repo is a `git checkout -b` you do without thinking;
three repos is the thing you put off.

## Decisions

### The app creates worktrees, not an agent

The main process is Node and can run `git` directly. Doing it there is
deterministic, instant, costs no tokens, and — decisively — the worktree exists
*before* the session spawns, so the session's cwd is already inside it. An agent
creating its own worktree would have to start somewhere else and relocate, which
a PTY's cwd does not really allow.

Rejected: delegating to a skill. The `using-git-worktrees` skill solves a
different problem — Claude isolating its own work — and brings model variance to
a mechanical operation.

### `ticketKey`, deliberately vendor-neutral

Tasks gain `ticketKey?: string`. The app never talks to an issue tracker; it
consumes the string when naming branches. The user fills it — from a ticket that
already exists, or from a session where they ran their own ticket-creating skill.

Named `ticketKey` rather than anything vendor-specific so the field still reads
correctly if the tracker changes, and so a personal task with no ticket is not
carrying a field named after a product it will never use.

Rejected: the app spawning the ticket-creating session itself, and the app
scraping a key back out of a transcript. The first makes the app depend on a
specific skill's name; the second breaks whenever output formatting moves.

### Base is `origin/HEAD` after a fetch — never current HEAD, never "master"

Measured across the eight repos under `~/Documents/projects`:

- **Three were sitting on feature branches.** Branching from current HEAD would
  stack a task's work on unrelated in-progress changes.
- **Default branches differ** — mostly `master`, but one uses `staging`. A
  hardcoded `master`/`main` is wrong for it.
- `origin/HEAD` resolved correctly in seven of eight.

The fetch matters: without it, `origin/HEAD` points at whatever was last pulled.

The eighth repo has `origin/HEAD` unset. The app **stops and says so**, naming
`git remote set-head origin -a` as the fix, rather than guessing a default. One
repair is better than a permanent fallback that silently picks wrong.

### Worktrees are grouped by task, not by repo

```
~/.claude-session-manager/worktrees/<task-id>-<branch>/<repo-name>/
```

The task id keeps it unique — two tasks can slugify identically — and the branch
makes it legible to someone browsing the directory, where `task-7/api` alone
would not be.

A multi-repo task's trees live together, so the task cleans up as one directory
and is obvious on disk. Rejected: inside the repo (`<repo>/.worktrees/…`), which
pollutes a directory that tooling globs, and a sibling directory, which scatters
one task's work across the projects tree.

### The trigger is the existing `+ session` button

On a task **with** repos, `+ session` creates the worktrees and opens a session
in each. On a task **without** repos it keeps today's behaviour, the directory
picker. One affordance; behaviour follows the data.

Rejected: overloading the `▶` status button, because picking something up should
not silently spawn three agents, and a dedicated fourth control, because the row
was just decluttered on purpose.

### Scope: Feature, Bug and Chore

Review needs "which branch am I reviewing?" — an input of its own — and Spike may
want no repo at all. Both get their own pass once the worktree path is real. A
Review or Spike task with repos behaves like the others for now rather than
being blocked.

## The flow

```
for each repo on the task:
  verify it is a git repo and still exists
  git fetch
  resolve origin/HEAD            → stop if unset
  git worktree add <root>/<task-id>-<branch>/<repo-name> -b <branch> origin/HEAD

then, only if every repo succeeded:
  spawn ONE session with cwd = <root>/<task-id>-<branch>/
```

### One session at the task root, not one per repo

The task's worktree directory is already a parent containing every repo's tree,
so a single session there sees all of them as subdirectories. This matches how
multi-repo work is actually done here — one session at the parent, working
across repos from it — and it is the only arrangement that lets a change
spanning repos be reasoned about at all: an API contract and its consumer need
one context that can see both, where per-repo sessions each see half.

It also means a task has one session in the common case, which is why the split
view had so little to tile.

`+ session` on a task that already has worktrees adds a further session at the
same root, for when a second line of work genuinely wants its own context.

**Known cost:** every task is a new directory, so Claude Code resolves it as a
new project and per-project `settings.local.json` allowances do not carry over —
permission prompts recur per task. Enterprise managed settings cover the bulk,
so this is the thin local layer on top. Seeding the task root from a template is
the fix if it becomes annoying; not worth doing before it does.

Per-repo `CLAUDE.md` is still picked up when the session works inside that
repo's subdirectory; it is simply not loaded at startup.

Sessions spawn with **no initial prompt** in this phase. Feeding the task's
description in as the opening message is the natural next step and is recorded
in the parent spec, but it is a separate decision — argv versus injection, and
what a description written as a note rather than an instruction does to a
session — and bundling it here would hide that behind a worktree feature.

**Branch name:** `<ticketKey>-<slug>` when the key is set, `<slug>` when not. The
same name in every repo, so the resulting MRs read as one change.

**Slug:** the title lowercased, every run of non-alphanumeric characters replaced
by a single `-`, leading and trailing `-` trimmed, truncated to 40 characters at
a `-` boundary. This is also what keeps the name a legal git ref — no spaces,
no `..`, no `~^:?*[`, no trailing `.lock`.

**All-or-nothing, and loud.** Worktrees are created for every repo before the
session spawns. If one fails, the trees created in that attempt are removed, no
session is started, and the failure is reported plainly — naming the repo and
the reason. A half-created task is worse than a clear failure, because the half
is invisible until it confuses you later.

**`git fetch` runs every time.** It is a network round-trip per repo before
anything opens, which is a visible wait on a slow connection, but branching from
a stale `origin/HEAD` is the kind of error you only notice days later in a
diff.

## Data model

```ts
export interface TaskWorktree {
  repo: string;      // absolute path to the source repo
  path: string;      // absolute path to the worktree
  branch: string;
}
```

`Task` gains `ticketKey?: string` and `worktrees?: TaskWorktree[]`.

`worktrees` is recorded rather than derived, because `repos` can change after the
trees exist and cleanup must still find what was actually created. Both are
optional, so **no `SAVED_STATE_VERSION` bump**: a task written before this phase
simply has neither.

## Failure modes

These are the spec's substance; a worktree feature is mostly its failure modes.

| Condition | Behaviour |
|---|---|
| Repo path no longer exists, or is not a git repo | Stop before touching anything; name the repo |
| `origin/HEAD` unset | Stop; name the repo and the `set-head` fix |
| `git fetch` fails (offline) | Report, and offer to proceed from the stale ref — the ref is usually fine and being offline should not block work |
| Branch already exists **and is recorded in this task's `worktrees`** | Reuse it: `git worktree add` without `-b`. Re-entering a task you already started is normal |
| Branch already exists and is **not** this task's | Stop; this is a collision — two titles slugified the same, or someone else made the branch. Report it and suggest setting `ticketKey`, which makes the name unique |
| Worktree path already exists and is registered to this task | Reuse it; this is a restart, not an error |
| Worktree path exists but is not a registered worktree | Stop; refuse to write into a directory the app does not own |
| One repo of several fails | Remove the trees created in this attempt; report which repo and why |

## Cleanup

On a task moving to `done`, the app attempts `git worktree remove` for each
recorded worktree and clears `worktrees`.

**The branch is never deleted.** Removing a tree is recoverable; deleting a
branch with unpushed commits is not.

A worktree with uncommitted changes makes `git worktree remove` refuse, and the
app surfaces that rather than passing `--force`. Git's own guard is the right
one: it is exactly the case where the user has work they have not saved.

## Testing

The pure parts — slug generation, branch naming, worktree path building — extend
`app-state-logic.test.ts` as usual.

The git operations get their own tests against **real temporary repositories**
created in the test (`git init`, one commit, a remote). Mocking git here would
test the mock: the risky behaviour is git's, and its edge cases — an existing
branch, a dirty tree refusing removal, an unset `origin/HEAD` — are precisely
what needs covering.

Worth pinning specifically: a title that slugifies to nothing (punctuation only),
a title long enough to truncate, two tasks whose titles slugify identically, and
removal refused by a dirty tree.

## What this unblocks

Per-type behaviour, now that one type's path is real: a Review task fetching
someone else's branch instead of creating one, and a Spike task opting out of
repos entirely. The `{ worktree, initialPrompt, agent? }` shape recorded in the
parent spec is what those become.

# pi-task-manager

A Pi extension that organizes the current project's existing sessions into a fast, virtual tree:

```text
Task
└─ Session
   └─ Fork / Clone / Continuation
```

Session JSONL files are never renamed, moved, deleted, or rewritten by organization. Handoff generates its checkpoint in an isolated model call, so the source Session is not polluted with checkpoint turns. Pi's built-in `/resume` behavior is unchanged.

## Commands

```text
/tasks                 Search, browse, correct, and switch through the indexed Task Tree
/task-organize         Incrementally scan and organize sessions in the background
/task-organize --all   Re-read and reorganize every current-project session
/task-organize status  Show the current phase, count, and elapsed time
/task-auto on|off      Persist automatic startup organization for the current project
/task-title <title>    Rename and lock the current Task
/handoff [focus]       Checkpoint and continue the current Task in a new Session
/handoff-auto on|off   Persist automatic handoff for the current project
```

`/tasks` opens a bordered selector matching Pi's `/resume` layout. Tasks show their latest activity time on the right and are ordered newest first. The newest Task starts expanded; all other Tasks start folded.

`/tasks` controls:

- Type to search; `↑`/`↓` selects and `←`/`→` folds or unfolds.
- `Enter` switches to a Session/Fork/Clone.
- `Ctrl+R` renames and locks the selected item.
- `Alt+M` moves a root Session to another Task.
- `Alt+G` merges the selected Task into another Task.
- `Alt+L` toggles the selected item's manual lock.

Manual names and assignments are marked as locked so later automatic organization does not overwrite them. Assignment priority is `manual > organized > provisional`; forks, clones, and continuations deterministically inherit the root Session's Task.

Every live root Session immediately receives `task:<rootSessionId>` as a stable provisional Task. The organizer is not part of the handoff path: it may later merge or rename provisional Tasks, while low-confidence Sessions retain separate provisional identities instead of sharing an `Unclassified` bucket.

## Long-running Task continuation

`/handoff` reads the current effective context and calls the active model in isolation to produce a structured Continuation Checkpoint. It validates model-returned user entry IDs, then copies the corresponding user messages verbatim into the checkpoint. Model-generated titles and objectives are descriptive only; they are never treated as authorization.

The checkpoint separates objective, completed facts, in-progress work, authorized next actions, questions waiting for the user, files, verification, constraints, processes, and active monitor snapshots. Invalid JSON/schema/evidence output is retried once. If the source leaf changes during generation, the engine waits for Pi to settle and regenerates against the new leaf under the same handoff operation.

Handoff uses a durable journal with `PREPARING → PREPARED → SWITCHING → COMMITTED`. The target Session is seeded and verified on disk before the Task index and source handoff marker are committed. A failed switch reuses the same operation ID and checkpoint; startup recovery commits an already-persisted target and resumes a continuation prompt only when its operation marker is absent.

A manual handoff always switches. Automatic handoff is off by default and stored per normalized project path. When enabled, it checks only after a settled run with no pending messages or active handoff, currently at 35% context usage. Executable unfinished work continues automatically; a user-blocked Task asks only its recorded question; an empty automatic checkpoint marks that leaf as checked and stays in the source Session.

Active `pi-task-monitor` records are copied into the checkpoint. Current task-monitor releases transfer monitors during Session replacement; handoff also warns in the target Session so the transfer can be verified. Task-scoped monitor routing remains a future infrastructure step.

## Organization and cost

Organization sends compact Session Cards to the active Pi model in batches of at most 25. A card contains only the original name, first and recent user messages, latest compaction summary, frequently referenced files, timestamps, parent path, and session/entry IDs. Low-confidence results keep their own provisional Task rather than being merged into a shared bucket.

Session file metadata and changed JSONL files are read with bounded concurrency (12 workers), so large first-time scans do not wait for 200 serial file reads or create unbounded I/O. AI batches remain sequential: each later batch can reuse Tasks created by earlier batches, which preserves grouping consistency and avoids provider rate-limit bursts.

Automatic organization is off by default and stored per normalized project path. When enabled, Pi starts an incremental background pass at session startup. `/task-organize` also returns immediately while work continues in-process. During a pass, the footer reports `scanning → parsing → organizing AI batches → saving`, including counts and elapsed time; `/task-organize status` reports the same state on demand. Completion or failure is shown as a notification.

The index is stored at:

```text
~/.pi/agent/task-manager/index.json
~/.pi/agent/task-manager/handoffs/<handoffId>.json
```

`/tasks` reads only this index and does not scan session JSONL files.

## Install

```bash
pi install /absolute/path/to/pi-task-manager
```

For development, symlink this directory to `~/.pi/agent/extensions/pi-task-manager` and run `/reload` after edits.

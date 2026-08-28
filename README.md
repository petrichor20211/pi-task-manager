# pi-task-manager

A Pi extension that organizes the current project's existing sessions into a fast, virtual tree:

```text
Task
└─ Session
   └─ Fork / Clone / Continuation
```

Session JSONL files are never renamed, moved, deleted, or rewritten. Task handoff may append its marked checkpoint request and response to the current Session. Pi's built-in `/resume` behavior is unchanged.

## Commands

```text
/tasks                 Search, browse, correct, and switch through the indexed Task Tree
/task-organize         Incrementally scan and organize sessions in the background
/task-organize --all   Re-read and reorganize every current-project session
/task-organize status  Show the current phase, count, and elapsed time
/task-auto on|off      Persist automatic startup organization for the current project
/task-title <title>    Rename and lock the current Task
/task-handoff [focus]  Checkpoint and continue the current Task in a new Session
/task-handoff-auto on|off
                       Persist automatic handoff for the current project
```

`/tasks` opens a bordered selector matching Pi's `/resume` layout. Tasks show their latest activity time on the right and are ordered newest first. The newest Task starts expanded; all other Tasks start folded.

`/tasks` controls:

- Type to search; `↑`/`↓` selects and `←`/`→` folds or unfolds.
- `Enter` switches to a Session/Fork/Clone.
- `Ctrl+R` renames and locks the selected item.
- `Alt+M` moves a root Session to another Task.
- `Alt+G` merges the selected Task into another Task.
- `Alt+L` toggles the selected item's manual lock.

Manual names and assignments are marked as locked so later automatic organization does not overwrite them. Forks, clones, and continuations deterministically inherit the root Session's Task.

## Long-running Task continuation

`/task-handoff` asks the active agent, inside the current Session, to produce a structured Continuation Checkpoint and then creates a new Session under the same Task. The request uses the normal agent path so the current provider prompt cache remains reusable. It appends only the checkpoint request and response to the source Session; existing entries are never rewritten or removed.

The checkpoint separates verified completed facts, explicitly requested unfinished work, questions waiting for the user, and non-binding assistant notes. Automatic continuation executes only unfinished work traceable to a real user request. Generated checkpoint and continuation prompts are ignored when later Session Cards determine user intent.

Automatic handoff is off by default and stored per normalized project path. When enabled, it checks after a settled agent run at 35% context usage, leaving room for the checkpoint response before switching. A continuation with executable unfinished work starts automatically; one that requires user input asks only the recorded question and waits without inventing work.

## Organization and cost

Organization sends compact Session Cards to the active Pi model in batches of at most 25. A card contains only the original name, first and recent user messages, latest compaction summary, frequently referenced files, timestamps, parent path, and session/entry IDs. Low-confidence results go to **Unclassified**.

Session file metadata and changed JSONL files are read with bounded concurrency (12 workers), so large first-time scans do not wait for 200 serial file reads or create unbounded I/O. AI batches remain sequential: each later batch can reuse Tasks created by earlier batches, which preserves grouping consistency and avoids provider rate-limit bursts.

Automatic organization is off by default and stored per normalized project path. When enabled, Pi starts an incremental background pass at session startup. `/task-organize` also returns immediately while work continues in-process. During a pass, the footer reports `scanning → parsing → organizing AI batches → saving`, including counts and elapsed time; `/task-organize status` reports the same state on demand. Completion or failure is shown as a notification.

The index is stored at:

```text
~/.pi/agent/task-manager/index.json
```

`/tasks` reads only this index and does not scan session JSONL files.

## Install

```bash
pi install /absolute/path/to/pi-task-manager
```

For development, symlink this directory to `~/.pi/agent/extensions/pi-task-manager` and run `/reload` after edits.

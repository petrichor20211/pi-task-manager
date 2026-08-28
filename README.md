# pi-task-manager

A Pi extension that organizes the current project's existing sessions into a fast, virtual tree:

```text
Task
└─ Session
   └─ Fork / Clone
```

Original session JSONL files are never renamed, moved, modified, or deleted. Pi's built-in `/resume` behavior is unchanged.

## Commands

```text
/tasks                 Search, browse, correct, and switch through the indexed Task Tree
/task-organize         Incrementally scan and organize sessions in the background
/task-organize --all   Re-read and reorganize every current-project session
/task-organize status  Show the current phase, count, and elapsed time
/task-auto on|off      Persist automatic startup organization for the current project
/task-title <title>    Rename and lock the current Task
```

`/tasks` controls:

- Type to search; `↑`/`↓` selects and `←`/`→` folds or unfolds.
- `Enter` switches to a Session/Fork/Clone.
- `Ctrl+R` renames and locks the selected item.
- `Alt+M` moves a root Session to another Task.
- `Alt+G` merges the selected Task into another Task.
- `Alt+L` toggles the selected item's manual lock.

Manual names and assignments are marked as locked so later automatic organization does not overwrite them. Forks and clones deterministically inherit the root Session's Task.

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

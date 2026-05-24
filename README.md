# pi-navigator

Navigation extension for [Pi](https://pi.dev): task tool, branch management, and session checkpointing.

## What it provides

| Resource | Type | Description |
|----------|------|-------------|
| `task` | Tool | Store a task prompt for a user-started navigation branch |
| `/start-branch` | Command | Start the active task from the current branch |
| `/start-fresh` | Command | Start the active task in a fresh context |
| `/return` | Command | Return to the checkpoint for the current task branch |
| `/cancel` | Command | Return without summarizing the current task branch |
| `/clear-task` | Command | Discard the active task without executing it |
| `/undo` | Command | Jump to the previous user message to re-prompt |

## Install

```bash
pi install npm:pi-navigator
```

If Pi is already running, restart it or run `/reload`.

## License

MIT. See [LICENSE](./LICENSE).

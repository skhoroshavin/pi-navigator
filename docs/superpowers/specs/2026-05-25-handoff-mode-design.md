# Handoff Mode Design

## Problem

`/return` always summarizes the branch. This works for exploratory branches (spikes, investigations) but not for focused task branches where the last assistant response is the answer. Users want subagent-style behavior: run a task, get the raw result back.

## Design

### Checkpoint data

Checkpoints store a `handoff` field that determines how `/return` delivers the branch result to the parent.

```typescript
interface CheckpointData {
  returnTo: string;
  handoff: "summary" | "last-response";
}
```

- `"summary"` — summarize the branch (existing behavior)
- `"last-response"` — inject the last assistant message verbatim

### `push-task` parameters

Add optional `context` parameter to control whether the task runs in a fresh context or on the current branch.

```typescript
{
  prompt: string;                // required
  context?: "fresh" | "branch"; // default: "fresh"
}
```

`push-task` only stores the prompt and context. It does not influence handoff mode — that's determined by the `/start-*` command.

### `/start-*` commands

Each command sets its own default handoff mode. Tasks are ignored by `/start-branch` and `/start-fresh`.

| Command | Context | Handoff | Task requirement |
|---------|---------|---------|------------------|
| `/start-branch` | branch | summary | ignores tasks |
| `/start-fresh` | fresh | summary | ignores tasks |
| `/start-task` (task context: fresh) | fresh | last-response | requires task |
| `/start-task` (task context: branch) | branch | last-response | requires task |

`/start-task` fails with a warning if no task is pending.

### `/return` override

`/return` reads the checkpoint's handoff mode. The user can override with a parameter:

| Command | Behavior |
|---------|----------|
| `/return` | use checkpoint's handoff mode |
| `/return last` | force last-response (shorthand) |
| `/return summary` | force summary |

## Implementation changes

### Checkpoint entry

Extend `CheckpointData` with `handoff` field. Update all checkpoint creation sites:

- `createStartBranchCommand` — `handoff: "summary"`
- `createStartFreshCommand` — `handoff: "summary"`
- `createStartTaskCommand` (new) — `handoff: "last-response"`

## Implementation notes

### `last-response` handoff

`navigateTree` with `{ summarize: false }` navigates without injecting anything. To inject the last assistant message:

1. Before navigating, walk the branch from the leaf to find the last assistant message
2. Navigate to the checkpoint target (`navigateTree` with `{ summarize: false }`)
3. After navigation, inject the captured message as a `custom_message` entry

This requires checking pi's API for `appendCustomMessage` or similar. If unavailable, an alternative is to store the message content in the checkpoint and inject it via `sendUserMessage` with framing (e.g., "Branch result: ..."), but this pollutes the user message history.

### `/return last` shorthand

Accept `last` as shorthand for `last-response`. Shorter to type, unambiguous in context.

### Shared fresh-context logic

Extract the fresh-context navigation logic (finding pre-conversation entry, navigating, creating checkpoint) into a shared helper used by both `/start-fresh` and `/start-task`.

### Updated `/return`

```typescript
export function createReturnCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Return to the checkpoint for the current task branch',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const checkpoint = findCheckpoint(ctx.sessionManager);
      if (!checkpoint) {
        ctx.ui.notify('No return point.', 'warning');
        return;
      }

      // Parse override from args
      let handoff = checkpoint.data.handoff;
      const trimmed = args.trim();
      if (trimmed === 'last' || trimmed === 'last-response') {
        handoff = 'last-response';
      } else if (trimmed === 'summary') {
        handoff = 'summary';
      }

      const result = await ctx.navigateTree(checkpoint.data.returnTo, {
        summarize: handoff === 'summary',
      });
      if (result.cancelled) return;

      if (findActiveTask(ctx.sessionManager)) {
        pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
      }

      const label = handoff === 'last-response' ? 'Last response attached.' : 'Branch summary attached.';
      ctx.ui.notify(`Returned. ${label}`, 'info');
    },
  };
}
```

### Updated `push-task` parameters

```typescript
const pushTaskParameters = Type.Object({
  prompt: Type.String({ description: 'Full prompt for the task, including all context and instructions.' }),
  context: Type.Optional(Type.Union([
    Type.Literal('fresh'),
    Type.Literal('branch'),
  ], { description: 'Context mode: "fresh" (clean slate, default) or "branch" (current branch).' })),
});
```

### Updated `push-task` storage

```typescript
pi.appendEntry(TASK_ENTRY_TYPE, { prompt: params.prompt, context: params.context ?? 'fresh' });
```

### Updated `TaskData`

```typescript
export interface TaskData {
  prompt: string;
  context: "fresh" | "branch";
}
```



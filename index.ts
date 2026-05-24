import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
  type SessionEntry,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { Type } from 'typebox';

export default function registerNavigationCommands(pi: ExtensionAPI): void {
  pi.registerTool(createTaskTool(pi));
  pi.registerCommand('start-branch', createStartBranchCommand(pi));
  pi.registerCommand('start-fresh', createStartFreshCommand(pi));
  pi.registerCommand('return', createReturnCommand(pi));
  pi.registerCommand('cancel', createCancelCommand(pi));
  pi.registerCommand('discard-task', createDiscardTaskCommand(pi));
  pi.registerCommand('undo', createUndoCommand());
}

export function createTaskTool(pi: ExtensionAPI): ToolDefinition {
  return defineTool({
    name: 'task',
    label: 'Task',
    description: 'Store a task prompt for a user-started navigation branch.',
    promptSnippet: 'Store a focused task prompt for a user-started navigation branch.',
    promptGuidelines: [
      'Use task when a skill needs the user to start a focused branch workflow with /start-branch.',
    ],
    parameters: taskParameters,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        throw new Error('Task storage aborted.');
      }

      pi.appendEntry(TASK_ENTRY_TYPE, { prompt: params.prompt });

      return {
        content: [{ type: 'text', text: 'Task stored. Run `/start-branch` to begin from here.' }],
        details: {},
      };
    },
  });
}

export function createStartBranchCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Start the active task from the current branch',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const activeTask = findActiveTask(ctx.sessionManager);

      // Store the current leaf as the return point
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: ctx.sessionManager.getLeafId() });

      if (activeTask) {
        pi.sendUserMessage(activeTask.data.prompt);
      } else {
        ctx.ui.notify('Ready to work on this branch. Use /return or /cancel when done.', 'info');
      }
    },
  };
}

export function createStartFreshCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Start the active task in a fresh context',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const activeTask = findActiveTask(ctx.sessionManager);

      // Record departure leaf before navigation
      const departureLeafId = ctx.sessionManager.getLeafId()!;

      // Find the first model-visible entry on the current branch.
      // If none exist, the branch has no LLM context — use the branch root as fallback.
      const firstVisible = findPreConversationEntry(ctx.sessionManager);
      let freshTargetId: string;
      if (firstVisible) {
        freshTargetId = firstVisible.parentId ?? firstVisible.id;
      } else {
        const branch = ctx.sessionManager.getBranch();
        if (branch.length === 0) {
          ctx.ui.notify('No starting point found on current branch.', 'warning');
          return;
        }
        freshTargetId = branch[0].parentId ?? branch[0].id;
      }

      const result = await ctx.navigateTree(freshTargetId, { summarize: false });
      if (result.cancelled) return;

      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: departureLeafId });

      if (activeTask) {
        pi.sendUserMessage(activeTask.data.prompt);
      } else {
        ctx.ui.notify('Ready to work on this branch. Use /return or /cancel when done.', 'info');
      }
    },
  };
}

/**
 * Find the first model-visible entry on the current branch (closest to root).
 *
 * "Model-visible" means the entry participates in LLM context via buildSessionContext:
 * messages (user/assistant), compaction summaries, branch summaries, and custom messages.
 * Entries like thinking_level_change, model_change, custom (data-only), label, and
 * session_info are NOT visible — Pi may insert them before the conversation begins.
 *
 * Returns null if the branch has no model-visible entries (e.g., only non-visible setup
 * entries) or if there is no leaf.
 */
function findPreConversationEntry(
  session: ReadonlySessionLike,
): SessionEntry | null {
  const leafId = session.getLeafId();
  if (!leafId) return null;

  const branch = session.getBranch();
  for (const entry of branch) {
    if (
      entry.type === 'message' ||
      entry.type === 'compaction' ||
      entry.type === 'branch_summary' ||
      entry.type === 'custom_message'
    ) {
      return entry;
    }
  }

  return null;
}

export function createCancelCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Return without summarizing the current task branch',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const checkpoint = findCheckpoint(ctx.sessionManager);

      if (!checkpoint) {
        ctx.ui.notify('No return point.', 'warning');
        return;
      }

      const result = await ctx.navigateTree(checkpoint.data.returnTo, { summarize: false });
      if (result.cancelled) return;

      if (findActiveTask(ctx.sessionManager)) {
        pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
      }

      ctx.ui.notify('Cancelled. Branch abandoned without summary.', 'info');
    },
  };
}

export function createDiscardTaskCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Discard the active task without executing it',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const activeTask = findActiveTask(ctx.sessionManager);
      if (!activeTask) {
        ctx.ui.notify('No pending task.', 'warning');
        return;
      }

      pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});

      ctx.ui.notify('Task discarded.', 'info');
    },
  };
}

export function createUndoCommand(): CommandOptions {
  return {
    description: 'Jump to the previous user message to re-prompt',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify('No user message to undo to.', 'warning');
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const byId = new Map(entries.map((e) => [e.id, e]));

      // Walk parent chain from current leaf to find the most recent user message
      let current = byId.get(leafId);
      let mostRecentUser: typeof current;

      while (current) {
        if (current.type === 'message' && current.message.role === 'user') {
          mostRecentUser = current;
          break;
        }
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }

      if (!mostRecentUser) {
        ctx.ui.notify('No user message to undo to.', 'warning');
        return;
      }

      // When the leaf is already a user message, jump to the previous one instead
      let target = mostRecentUser;
      if (leafId === mostRecentUser.id) {
        // Walk up from the most recent user to find the previous user message
        let prev = mostRecentUser.parentId ? byId.get(mostRecentUser.parentId) : undefined;
        while (prev) {
          if (prev.type === 'message' && prev.message.role === 'user') {
            target = prev;
            break;
          }
          prev = prev.parentId ? byId.get(prev.parentId) : undefined;
        }

        if (target === mostRecentUser) {
          ctx.ui.notify('Already at the start.', 'info');
          return;
        }
      }

      await ctx.navigateTree(target.id, { summarize: false });
    },
  };
}

export function createReturnCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Return to the checkpoint for the current task branch',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const checkpoint = findCheckpoint(ctx.sessionManager);

      if (!checkpoint) {
        ctx.ui.notify('No return point.', 'warning');
        return;
      }

      const result = await ctx.navigateTree(checkpoint.data.returnTo, { summarize: true });
      if (result.cancelled) {
        return;
      }

      if (findActiveTask(ctx.sessionManager)) {
        pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
      }

      ctx.ui.notify('Returned. Branch summary attached.', 'info');
    },
  };
}

// ── Lookup utilities ──────────────────────────────────────────────

function findActiveTask(
  session: ReadonlySessionLike,
): (SessionEntry & { data: TaskData }) | null {
  const entries = session.getEntries();
  const byId = new Map<string, SessionEntry>(entries.map((e) => [e.id, e]));
  let skip = 0;
  const leafId = session.getLeafId();
  let current = leafId ? byId.get(leafId) : undefined;

  while (current) {
    if (current.type === 'custom' && current.customType === TASK_DONE_ENTRY_TYPE) {
      skip++;
    } else if (current.type === 'custom' && current.customType === TASK_ENTRY_TYPE) {
      if (skip === 0) return current as SessionEntry & { data: TaskData };
      skip--;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return null;
}

export const TASK_ENTRY_TYPE = 'task';

export const TASK_DONE_ENTRY_TYPE = 'task-done';

export interface TaskData {
  prompt: string;
}

function findCheckpoint(
  session: ReadonlySessionLike,
): (SessionEntry & { data: CheckpointData }) | null {
  const entries = session.getEntries();
  const byId = new Map<string, SessionEntry>(entries.map((e) => [e.id, e]));
  const leafId = session.getLeafId();
  let current = leafId ? byId.get(leafId) : undefined;

  while (current) {
    if (current.type === 'custom' && current.customType === CHECKPOINT_ENTRY_TYPE) {
      return current as SessionEntry & { data: CheckpointData };
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return null;
}

export const CHECKPOINT_ENTRY_TYPE = 'checkpoint';

export interface CheckpointData {
  returnTo: string;
}

/**
 * Minimal read-only session interface needed by lookup functions.
 * Compatible with both ReadonlySessionManager (from ExtensionCommandContext)
 * and SessionManager (full mutable version).
 */
export interface ReadonlySessionLike {
  getEntries(): SessionEntry[];
  getLeafId(): string | null;
  getBranch(): SessionEntry[];
}

type CommandOptions = Omit<RegisteredCommand, 'name' | 'sourceInfo'>;

const taskParameters = Type.Object({
  prompt: Type.String({ description: 'Full prompt for the task, including all context and instructions.' }),
});
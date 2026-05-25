import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
  type SessionEntry,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';

export default function registerNavigationCommands(pi: ExtensionAPI): void {
  pi.registerCommand('start-branch', createStartBranchCommand(pi));
  pi.registerCommand('start-fresh', createStartFreshCommand(pi));
  pi.registerCommand('return', createReturnCommand(pi));
  pi.registerCommand('cancel', createCancelCommand());
  pi.registerCommand('undo', createUndoCommand());
}



export function createStartBranchCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Start a focused branch from the current position',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      // Store the current leaf as the return point
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: ctx.sessionManager.getLeafId(), handoff: 'summary' });

      ctx.ui.notify('Ready to work on this branch. Use /return or /cancel when done.', 'info');
    },
  };
}

export function createStartFreshCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Start a focused branch in a fresh context',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      // Record departure leaf before navigation
      const departureLeafId = ctx.sessionManager.getLeafId()!;

      const freshTargetId = findFreshTargetId(ctx.sessionManager);
      if (!freshTargetId) {
        ctx.ui.notify('No starting point found on current branch.', 'warning');
        return;
      }

      const result = await ctx.navigateTree(freshTargetId, { summarize: false });
      if (result.cancelled) return;

      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: departureLeafId, handoff: 'summary' });

      ctx.ui.notify('Ready to work on this branch. Use /return or /cancel when done.', 'info');
    },
  };
}

/**
 * Find the target ID for navigating to a fresh context.
 * Returns the parent of the first model-visible entry, or the branch root as fallback.
 * Returns null if no valid target is found.
 */
function findFreshTargetId(session: ReadonlySessionLike): string | null {
  const branch = session.getBranch();
  if (branch.length === 0) return null;

  const firstVisible = findPreConversationEntry(session);
  if (firstVisible) {
    return firstVisible.parentId ?? firstVisible.id;
  }

  // Fallback: use branch root's parent (or the root itself if no parent)
  return branch[0].parentId ?? branch[0].id;
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



export function createCancelCommand(): CommandOptions {
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

      ctx.ui.notify('Cancelled. Branch abandoned without summary.', 'info');
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
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const checkpoint = findCheckpoint(ctx.sessionManager);
      if (!checkpoint) {
        ctx.ui.notify('No return point.', 'warning');
        return;
      }

      // Parse override from args
      let handoff = checkpoint.data.handoff ?? 'summary';
      const trimmed = args.trim();
      if (trimmed === 'last' || trimmed === 'last-response') {
        handoff = 'last-response';
      } else if (trimmed === 'summary') {
        handoff = 'summary';
      }

      // Capture last assistant message content before navigation (for last-response mode)
      let lastAssistantContent: unknown;
      let lastAssistantId: string | undefined;
      if (handoff === 'last-response') {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (isAssistantMessageEntry(entry)) {
            const rawContent = entry.message.content;
            // Filter to only text blocks — thinking and toolCall blocks are not
            // valid for custom_message content and cause provider errors (e.g.,
            // DeepSeek rejects unrecognized content block variants).
            if (Array.isArray(rawContent)) {
              lastAssistantContent = rawContent.filter(
                (block): block is { type: 'text'; text: string } =>
                  typeof block === 'object' && block !== null && 'type' in block && block.type === 'text',
              );
            } else {
              lastAssistantContent = rawContent;
            }
            lastAssistantId = entry.id;
            break;
          }
        }
      }

      const result = await ctx.navigateTree(checkpoint.data.returnTo, {
        summarize: handoff === 'summary',
      });
      if (result.cancelled) return;

      // Inject last assistant message after navigation
      if (handoff === 'last-response' && lastAssistantId) {
        pi.sendMessage({
          customType: 'branch-result',
          // Content is filtered to only TextContent blocks (or original string)
          content: lastAssistantContent as unknown as string,
          display: true,
          details: { sourceEntryId: lastAssistantId },
        }, { triggerTurn: true });
      }

      const injected = handoff === 'last-response' && !!lastAssistantId;
      const label = injected ? 'Last response attached.' : handoff === 'last-response' ? 'No last response to attach.' : 'Branch summary attached.';
      ctx.ui.notify(`Returned. ${label}`, 'info');
    },
  };
}

/** Type guard: is the entry an assistant message with content? */
function isAssistantMessageEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: { role: 'assistant' } } {
  return entry.type === 'message' && entry.message.role === 'assistant';
}

// ── Lookup utilities ──────────────────────────────────────────────



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
  handoff?: 'summary' | 'last-response';
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


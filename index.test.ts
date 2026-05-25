import assert from 'node:assert';

import { describe, it } from 'node:test';

import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import registerNavigationCommands, {
  createStartBranchCommand,
  createReturnCommand,
  createStartFreshCommand,
  createCancelCommand,
  createUndoCommand,
} from './index.js';

import {
  CHECKPOINT_ENTRY_TYPE,
  type CheckpointData,
} from './index.js';



describe('createStartBranchCommand', () => {
  it('creates a checkpoint without injecting a prompt when there is no pending task', async () => {
    const { pi, ctx, sm, sentMessages, notifications } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    const leafBefore = ctx.sessionManager.getLeafId();

    const cmd = createStartBranchCommand(pi);
    await cmd.handler('', ctx);

    // No prompt injected — nothing to work on
    assert.deepStrictEqual(sentMessages, []);

    // Checkpoint was still created (user-driven branching)
    const n = assertLastNotification(notifications, 'info');
    assert.ok(n.message.includes('Ready to work'));

    const checkpoint = assertCheckpoint(ctx.sessionManager, 'summary');
    assert.strictEqual(checkpoint.returnTo, leafBefore);
  });


});

describe('createStartFreshCommand', () => {
  it('navigates and creates checkpoint without injecting a prompt when there is no pending task', async () => {
    const { pi, ctx, sentMessages, navigations, notifications } = makeHarness();
    const firstMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    const leafBefore = ctx.sessionManager.getLeafId();

    const cmd = createStartFreshCommand(pi);
    await cmd.handler('', ctx);

    // No prompt injected — nothing to work on
    assert.deepStrictEqual(sentMessages, []);

    // Should still navigate to fresh context
    const n = assertLastNotification(notifications, 'info');
    assert.ok(n.message.includes('Ready to work'));

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, firstMsgId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, false);

    // Checkpoint was still created
    const checkpoint = assertCheckpoint(ctx.sessionManager, 'summary');
    assert.strictEqual(checkpoint.returnTo, leafBefore);
  });






});



describe('createCancelCommand', () => {
  it('notifies without navigating when no checkpoint exists', async () => {
    const { ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    const cmd = createCancelCommand();
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
    assertNoCheckpoint(ctx.sessionManager);
  });




});

function assertNoCheckpoint(sm: SessionManager): void {
  const cp = getCheckpoint(sm);
  assert.strictEqual(cp, null, `Expected no checkpoint, but found one: ${JSON.stringify(cp)}`);
}



describe('createUndoCommand', () => {
  it('notifies when at the first user message (no earlier user message)', async () => {
    const { ctx, notifications } = makeHarness();
    const firstMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'first message', timestamp: 0 });

    // Leaf is at first user message
    ctx.sessionManager.branch(firstMsgId);

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'info', 'Already at the start.');
  });

  it('navigates to the most recent user message on the current branch', async () => {
    const { ctx, navigations } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'first message', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('reply'));
    const secondUserMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'second message', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('another reply'));

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, secondUserMsgId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, false);
  });

  it('skips custom entries and finds the most recent user message', async () => {
    const { ctx, navigations } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'first message', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('reply'));
    const secondUserMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'second message', timestamp: 0 });
    // Custom entries between user messages should be skipped
    ctx.sessionManager.appendCustomEntry('other', { some: 'data' });
    ctx.sessionManager.appendMessage(assistantMessage('reply to second'));

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assert.strictEqual(navigations[0].targetId, secondUserMsgId);
  });

  it('notifies when there are no user messages on the branch', async () => {
    const { ctx, notifications } = makeHarness();
    // Only assistant messages
    ctx.sessionManager.appendMessage(assistantMessage('auto output'));

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No user message to undo to.');
  });

  it('navigates to the previous user message when leaf is already a user message', async () => {
    const { ctx, navigations } = makeHarness();
    const firstUserMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'first message', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('reply'));
    ctx.sessionManager.appendMessage({ role: 'user', content: 'second message', timestamp: 0 });
    // Leaf IS the second user message (no assistant response yet)

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, firstUserMsgId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, false);
  });
});

describe('createReturnCommand', () => {
  it('notifies without navigating when there is no checkpoint on the current branch', async () => {
    const { pi, ctx, sm, notifications } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
  });

  it('navigates to the checkpoint return target', async () => {
    const { pi, ctx, sm, navigations } = makeHarness();

    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    sm.appendMessage(assistantMessage('Ready.'));

    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId });
    sm.appendMessage({ role: 'user', content: 'work', timestamp: 0 });
    sm.appendMessage(assistantMessage('Done.'));

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, leafId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, true);
  });





  it('injects last assistant message when checkpoint has handoff "last-response"', async () => {
    const { pi, ctx, sm, sentCustomMessages, notifications } = makeHarness();

    // Set up: user msg → assistant msg → checkpoint with last-response
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    sm.appendMessage(assistantMessage('Here is my analysis...'));

    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId, handoff: 'last-response' });
    sm.appendMessage({ role: 'user', content: 'work', timestamp: 0 });
    sm.appendMessage(assistantMessage('Working on it...'));

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    // Should have injected the last assistant message
    assert.strictEqual(sentCustomMessages.length, 1);
    assert.strictEqual(sentCustomMessages[0].customType, 'branch-result');
    assert.strictEqual((sentCustomMessages[0].options as { triggerTurn?: boolean } | undefined)?.triggerTurn, true);

    assertLastNotification(notifications, 'info', 'Returned. Last response attached.');
  });

  it('overrides checkpoint handoff with "/return last"', async () => {
    const { pi, ctx, sm, sentCustomMessages } = makeHarness();

    // Checkpoint with summary handoff
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    sm.appendMessage(assistantMessage('Summary of work...'));
    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId, handoff: 'summary' });
    sm.appendMessage({ role: 'user', content: 'work', timestamp: 0 });
    sm.appendMessage(assistantMessage('Final answer.'));

    const cmd = createReturnCommand(pi);
    await cmd.handler('last', ctx);

    // Should inject last response despite summary checkpoint
    assert.strictEqual(sentCustomMessages.length, 1);
    assert.strictEqual(sentCustomMessages[0].customType, 'branch-result');
  });

  it('overrides checkpoint handoff with "/return summary"', async () => {
    const { pi, ctx, sm, sentCustomMessages, navigations } = makeHarness();

    // Checkpoint with last-response handoff
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId, handoff: 'last-response' });
    sm.appendMessage({ role: 'user', content: 'work', timestamp: 0 });
    sm.appendMessage(assistantMessage('Final answer.'));

    const cmd = createReturnCommand(pi);
    await cmd.handler('summary', ctx);

    // Should use summarize: true despite last-response checkpoint
    assert.strictEqual(navigations.length, 1);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, true);

    // No injection should occur
    assert.strictEqual(sentCustomMessages.length, 0);
  });

  it('filters out thinking blocks from injected last-response content', async () => {
    const { pi, ctx, sm, sentCustomMessages } = makeHarness();

    // Assistant message with thinking + text blocks (as happens with thinking mode on)
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    sm.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Internal reasoning...' },
        { type: 'text', text: 'Public response.' },
      ],
      timestamp: 0,
      model: 'test',
      provider: 'test',
    } as Parameters<SessionManager['appendMessage']>[0]);

    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId, handoff: 'last-response' });
    sm.appendMessage({ role: 'user', content: 'task work', timestamp: 0 });
    sm.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Processing...' },
        { type: 'text', text: 'Task result here.' },
      ],
      timestamp: 0,
      model: 'test',
      provider: 'test',
    } as Parameters<SessionManager['appendMessage']>[0]);

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    // Should inject only text blocks, not thinking blocks
    assert.strictEqual(sentCustomMessages.length, 1);
    const content = sentCustomMessages[0].content as Array<{ type: string; text: string }>;
    assert.strictEqual(content.length, 1);
    assert.strictEqual(content[0].type, 'text');
    assert.strictEqual(content[0].text, 'Task result here.');
  });

  it('navigates without injecting when no assistant message exists on branch', async () => {
    const { pi, ctx, sm, sentCustomMessages, notifications } = makeHarness();

    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId, handoff: 'last-response' });
    // No assistant message on branch

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    // No injection — no assistant message to inject
    assert.strictEqual(sentCustomMessages.length, 0);
    assertLastNotification(notifications, 'info', 'Returned. No last response to attach.');
  });
});

describe('registration', () => {
  it('registers all navigation commands', () => {
    const registered: Array<{ type: string; name: string; description?: string }> = [];
    const pi = {
      registerTool: (tool: { name: string; label: string; description: string }) =>
        registered.push({ type: 'tool', name: tool.name, description: tool.description }),
      registerCommand: (name: string, opts: { description: string }) =>
        registered.push({ type: 'command', name, description: opts.description }),
      on: () => {},
    } as unknown as ExtensionAPI;

    registerNavigationCommands(pi);

    assert.deepStrictEqual(registered, [
      { type: 'command', name: 'start-branch', description: 'Start a focused branch from the current position' },
      { type: 'command', name: 'start-fresh', description: 'Start a focused branch in a fresh context' },
      { type: 'command', name: 'return', description: 'Return to the checkpoint for the current task branch' },
      { type: 'command', name: 'cancel', description: 'Return without summarizing the current task branch' },
      { type: 'command', name: 'undo', description: 'Jump to the previous user message to re-prompt' },
    ]);
  });
});

describe('integration: nested /start-fresh', () => {
  it('completes /start-fresh → /return roundtrip with checkpoint', async () => {
    const { pi, ctx, navigations, notifications } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working...'));

    // /start-fresh: navigates to pre-conversation point
    const startFreshCmd = createStartFreshCommand(pi);
    await startFreshCmd.handler('', ctx);

    // Simulate work on the fresh branch
    ctx.sessionManager.appendMessage({ role: 'user', content: 'do work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('task done'));

    navigations.length = 0;

    // /return — navigates back to checkpoint
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    assertLastNotification(notifications, 'info', 'Returned. Branch summary attached.');

    // No task involved — just a plain roundtrip
    assert.strictEqual(navigations.length, 1);
  });
});



describe('integration: edge cases from design spec', () => {
  it('/start-branch with no pending task creates checkpoint and does not inject', async () => {
    const { pi, ctx, sentMessages, notifications } = makeHarness();
    const leafId = ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createStartBranchCommand(pi);
    await cmd.handler('', ctx);

    assert.deepStrictEqual(sentMessages, []);

    const n = assertLastNotification(notifications, 'info');
    assert.ok(n.message.includes('Ready to work'));

    const checkpoint = assertCheckpoint(ctx.sessionManager);
    assert.strictEqual(checkpoint.returnTo, leafId);
  });



  it('/cancel with no checkpoint notifies without navigating', async () => {
    const { ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createCancelCommand();
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
  });

  it('/start-fresh with no pending task still navigates and creates checkpoint, just without injected prompt', async () => {
    const { pi, ctx, sentMessages, navigations, notifications } = makeHarness();
    const firstMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    const leafBefore = ctx.sessionManager.getLeafId();

    const cmd = createStartFreshCommand(pi);
    await cmd.handler('', ctx);

    // Navigates to fresh context regardless
    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, firstMsgId);

    // Checkpoint created
    const checkpoint = assertCheckpoint(ctx.sessionManager);
    assert.strictEqual(checkpoint.returnTo, leafBefore);

    // No prompt injected
    assert.deepStrictEqual(sentMessages, []);

    const n = assertLastNotification(notifications, 'info');
    assert.ok(n.message.includes('Ready to work'));
  });



  it('/undo on first user message notifies', async () => {
    const { ctx, notifications } = makeHarness();
    const firstMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'first', timestamp: 0 });

    ctx.sessionManager.branch(firstMsgId);

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'info', 'Already at the start.');
  });




});





/**
 * Thin harness: real SessionManager for entry tree operations,
 * spy objects for pi/ctx methods that interact with Pi's runtime.
 *
 * Uses SessionManager.inMemory() for proper tree structure
 * instead of hand-built mock entries.
 */
function makeHarness() {
  const sm = SessionManager.inMemory();
  const sentMessages: string[] = [];
  const sentCustomMessages: Array<{ customType: string; content: unknown; options?: unknown }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const navigations: Array<{ targetId: string; opts?: unknown }> = [];
  let cancelNextNav = false;

  const pi = {
    appendEntry(customType: string, data?: unknown) {
      sm.appendCustomEntry(customType, data);
    },
    sendUserMessage(content: string | Array<{ type: string; text: string }>) {
      const text = typeof content === 'string' ? content : content.map((b) => b.text).join('');
      sm.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
      sentMessages.push(text);
    },
    sendMessage(message: { customType: string; content: unknown; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) {
      sentCustomMessages.push({ customType: message.customType, content: message.content, options });
      sm.appendCustomMessageEntry(message.customType, message.content as string, message.display ?? true, message.details);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    waitForIdle: async () => {},
    sessionManager: sm,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    navigateTree: async (targetId: string, opts?: unknown) => {
      navigations.push({ targetId, opts });
      if (cancelNextNav) {
        return { cancelled: true };
      }
      sm.branch(targetId);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext & { sessionManager: SessionManager };

  return {
    sm,
    pi,
    ctx,
    sentMessages,
    sentCustomMessages,
    notifications,
    navigations,
    setCancelNextNav(v: boolean) {
      cancelNextNav = v;
    },
  };
}

function assistantMessage(text: string): AppendMessageInput {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 0,
    model: 'test',
    provider: 'test',
  } as AppendMessageInput;
}

type AppendMessageInput = Parameters<SessionManager['appendMessage']>[0];

function assertCheckpoint(sm: SessionManager, expectedHandoff?: CheckpointData['handoff']): CheckpointData {
  const cp = getCheckpoint(sm);
  assert.ok(cp, 'Expected checkpoint, found none.');
  if (expectedHandoff) {
    assert.strictEqual(cp.handoff, expectedHandoff);
  }
  return cp;
}

// ── Test utilities ───────────────────────────────────────────────

function getCheckpoint(sm: SessionManager): CheckpointData | null {
  const branch = sm.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === 'custom' && e.customType === CHECKPOINT_ENTRY_TYPE) {
      return e.data as CheckpointData;
    }
  }
  return null;
}

function assertLastNotification(
  notifications: Notification[],
  type?: string,
  expectedMessage?: string,
): Notification {
  const n = getLastNotification(notifications, type);
  assert.ok(n, `Expected notification${type ? ` of type '${type}'` : ''}, found none.`);
  if (expectedMessage !== undefined) {
    assert.strictEqual(n.message, expectedMessage);
  }
  return n;
}

function getLastNotification(
  notifications: Notification[],
  type?: string,
): Notification | null {
  for (let i = notifications.length - 1; i >= 0; i--) {
    if (type === undefined || notifications[i].type === type) {
      return notifications[i];
    }
  }
  return null;
}

interface Notification {
  message: string;
  type?: string;
}
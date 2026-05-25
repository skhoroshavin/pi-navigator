import assert from 'node:assert';

import { describe, it } from 'node:test';

import { SessionManager, type CustomEntry, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import registerNavigationCommands, {
  createStartBranchCommand,
  createReturnCommand,
  createPushTaskTool,
  createStartFreshCommand,
  createStartTaskCommand,
  createCancelCommand,
  createDiscardTaskCommand,
  createUndoCommand,
} from './index.js';

import {
  CHECKPOINT_ENTRY_TYPE,
  TASK_DONE_ENTRY_TYPE,
  TASK_ENTRY_TYPE,
  type CheckpointData,
  type TaskData,
} from './index.js';

describe('createPushTaskTool', () => {
  it('pushes a task entry, and returns instruction text', async () => {
    const { pi, ctx, sm } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    const tool = createPushTaskTool(pi);
    assert.strictEqual(tool.name, 'push-task');
    await tool.execute('call-1', { prompt: 'Review the spec.' }, undefined, undefined, ctx);

    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'Review the spec.');
    assert.strictEqual(task.context, 'fresh');
  });

  it('pushes a task entry with explicit context "branch"', async () => {
    const { pi, ctx, sm } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    const tool = createPushTaskTool(pi);
    await tool.execute('call-1', { prompt: 'Quick fix.', context: 'branch' }, undefined, undefined, ctx);

    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'Quick fix.');
    assert.strictEqual(task.context, 'branch');
  });
});

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

  it('creates a checkpoint without injecting the active task prompt (task ignored for /start-branch)', async () => {
    const { pi, ctx, sm, sentMessages, notifications } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'lets work', timestamp: 0 });
    sm.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });
    const taskLeafId = ctx.sessionManager.getLeafId();

    const cmd = createStartBranchCommand(pi);
    await cmd.handler('', ctx);

    // No prompt injected — task is ignored
    assert.deepStrictEqual(sentMessages, []);

    const n = assertLastNotification(notifications, 'info');
    assert.ok(n.message.includes('Ready to work'));

    const checkpoint = assertCheckpoint(ctx.sessionManager, 'summary');
    // returnTo is the leaf the checkpoint was created at (the task entry)
    assert.strictEqual(checkpoint.returnTo, taskLeafId);

    // The task is still findable — not consumed
    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'Implement phase 1.');
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

  it('navigates to pre-conversation point and creates checkpoint without injecting task prompt (task ignored for /start-fresh)', async () => {
    const { pi, ctx, sentMessages, navigations, notifications } = makeHarness();

    // Build a session with history before the task
    const rootUserMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'Let us design feature X.', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('Sure, let us start.'));
    ctx.sessionManager.appendMessage({ role: 'user', content: 'How about option A?', timestamp: 0 });
    // LLM stores a task
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Review spec at docs/specs/design.md for completeness.' });
    const departureLeafId = ctx.sessionManager.getLeafId()!;

    const cmd = createStartFreshCommand(pi);
    await cmd.handler('', ctx);

    // Should navigate to pre-conversation point (parent of first user message)
    assert.strictEqual(navigations.length, 1);
    // The first user message's parent is null (it's the root), so navigateTree targets the first user message id
    assert.strictEqual(navigations[0].targetId, rootUserMsgId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, false);

    // Checkpoint should have been created with returnTo = departureLeafId
    const checkpoint = assertCheckpoint(ctx.sessionManager, 'summary');
    assert.strictEqual(checkpoint.returnTo, departureLeafId);

    // No prompt injected — task is ignored
    assert.deepStrictEqual(sentMessages, []);

    const n = assertLastNotification(notifications, 'info');
    assert.ok(n.message.includes('Ready to work'));
  });

  it('does not navigate when navigateTree is cancelled', async () => {
    const { pi, ctx, setCancelNextNav } = makeHarness();
    setCancelNextNav(true);

    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Do the thing.' });

    const entriesBefore = ctx.sessionManager.getEntries().length;

    const cmd = createStartFreshCommand(pi);
    await cmd.handler('', ctx);

    // Nothing was appended after cancellation
    assert.strictEqual(ctx.sessionManager.getEntries().length, entriesBefore);
  });

  it('handles session where first user message parentId is null by targeting the user message itself', async () => {
    // This test verifies the branching: when parentId is null, navigateTree calls resetLeaf()
    // and subsequent appendEntry creates root-level siblings.
    const { pi, ctx, navigations } = makeHarness();

    const firstUserMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Task on fresh branch.' });

    const cmd = createStartFreshCommand(pi);
    await cmd.handler('', ctx);

    assert.strictEqual(navigations[0].targetId, firstUserMsgId);
    // Pi handles parentId === null by calling resetLeaf(); checkpoint will be a sibling
  });
});

describe('createStartTaskCommand', () => {
  it('notifies when there is no pending task', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createStartTaskCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No pending task. Use push-task first.');
  });

  it('navigates to fresh context and injects task prompt with handoff "last-response"', async () => {
    const { pi, ctx, sentMessages, navigations } = makeHarness();

    const rootUserMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working...'));
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Review spec for issues.' });
    const departureLeafId = ctx.sessionManager.getLeafId()!;

    const cmd = createStartTaskCommand(pi);
    await cmd.handler('', ctx);

    // Navigated to fresh context
    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, rootUserMsgId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, false);

    // Checkpoint with handoff: "last-response"
    const checkpoint = assertCheckpoint(ctx.sessionManager, 'last-response');
    assert.strictEqual(checkpoint.returnTo, departureLeafId);

    // Task prompt injected
    assert.deepStrictEqual(sentMessages, ['Review spec for issues.']);
  });

  it('stays on branch and creates checkpoint with handoff "last-response"', async () => {
    const { pi, ctx, sentMessages, navigations } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Quick fix.', context: 'branch' });
    const leafBefore = ctx.sessionManager.getLeafId()!;

    const cmd = createStartTaskCommand(pi);
    await cmd.handler('', ctx);

    // No navigation for branch context
    assert.strictEqual(navigations.length, 0);

    // Checkpoint with handoff: "last-response"
    const checkpoint = assertCheckpoint(ctx.sessionManager, 'last-response');
    assert.strictEqual(checkpoint.returnTo, leafBefore);

    // Task prompt injected
    assert.deepStrictEqual(sentMessages, ['Quick fix.']);
  });

  it('defaults to fresh context when task has no explicit context', async () => {
    const { pi, ctx, navigations } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    // Task without explicit context field
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Default context task.' });

    const cmd = createStartTaskCommand(pi);
    await cmd.handler('', ctx);

    // Should navigate (fresh context)
    assert.strictEqual(navigations.length, 1);
    const checkpoint = assertCheckpoint(ctx.sessionManager, 'last-response');
    assert.ok(checkpoint);
  });
});

describe('createCancelCommand', () => {
  it('notifies without navigating when no checkpoint exists', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    const cmd = createCancelCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
    assertNoCheckpoint(ctx.sessionManager);
  });

  it('navigates back without summary and appends task-done', async () => {
    const { pi, ctx, navigations } = makeHarness();

    // Set up the same scenario as the return test
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });
    ctx.sessionManager.appendMessage(assistantMessage('Ready.'));

    const leafId = ctx.sessionManager.getLeafId()!;
    ctx.sessionManager.branch(leafId);
    ctx.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId });
    ctx.sessionManager.appendMessage({ role: 'user', content: 'task work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('Working...'));

    const cmd = createCancelCommand(pi);
    await cmd.handler('', ctx);

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, leafId);
    // Key difference from /return: summarize is false
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, false);

    // Task-done should still be appended
    const entries = ctx.sessionManager.getEntries();
    const lastEntry = entries[entries.length - 1];
    assert.strictEqual(lastEntry.type, 'custom');
    assert.strictEqual((lastEntry as CustomEntry).customType, TASK_DONE_ENTRY_TYPE);
  });

  it('does not append task-done when navigation is cancelled', async () => {
    const { pi, ctx, setCancelNextNav } = makeHarness();
    setCancelNextNav(true);

    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });
    const leafId = ctx.sessionManager.getLeafId()!;
    ctx.sessionManager.branch(leafId);
    ctx.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId });

    const entriesBefore = ctx.sessionManager.getEntries().length;

    const cmd = createCancelCommand(pi);
    await cmd.handler('', ctx);

    assert.strictEqual(ctx.sessionManager.getEntries().length, entriesBefore);
  });
});

function assertNoCheckpoint(sm: SessionManager): void {
  const cp = getCheckpoint(sm);
  assert.strictEqual(cp, null, `Expected no checkpoint, but found one: ${JSON.stringify(cp)}`);
}

describe('createDiscardTaskCommand', () => {
  it('notifies when there is no pending task', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createDiscardTaskCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No pending task.');
  });

  it('appends task-done to consume the active task', async () => {
    const { pi, ctx } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'first task' });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'second task' });

    const cmd = createDiscardTaskCommand(pi);
    await cmd.handler('', ctx);

    const entries = ctx.sessionManager.getEntries();
    const lastEntry = entries[entries.length - 1];
    assert.strictEqual(lastEntry.type, 'custom');
    assert.strictEqual((lastEntry as CustomEntry).customType, TASK_DONE_ENTRY_TYPE);

    // Active task is now 'first task' (second was consumed)
    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'first task');
  });

  it('clears the only pending task so no task remains', async () => {
    const { pi, ctx } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'only task' });

    const cmd = createDiscardTaskCommand(pi);
    await cmd.handler('', ctx);

    assertNoActiveTask(ctx.sessionManager);
  });
});

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
    sm.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
  });

  it('navigates to the checkpoint return target and appends task-done', async () => {
    const { pi, ctx, sm, navigations } = makeHarness();

    // Set up: user msg → task → assistant msg
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    sm.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });
    sm.appendMessage(assistantMessage('Ready.'));

    // Simulate /start-branch: branch from leaf, checkpoint returns to leaf (assistant)
    const leafId = sm.getLeafId()!;
    sm.branch(leafId);
    // Checkpoint at leaf; returnTo is the leaf (assistant), after navigating there the task is reachable via parent chain
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId });
    sm.appendMessage({ role: 'user', content: 'Implement phase 1.', timestamp: 0 });

    // Simulate work on branch
    sm.appendMessage(assistantMessage('Done.'));

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, leafId);
    assert.strictEqual((navigations[0].opts as { summarize?: boolean })?.summarize, true);

    // Task-done was appended
    const entries = ctx.sessionManager.getEntries();
    const lastEntry = entries[entries.length - 1];
    assert.strictEqual(lastEntry.type, 'custom');
    assert.strictEqual((lastEntry as CustomEntry).customType, TASK_DONE_ENTRY_TYPE);

    // After return, the task should be consumed
    assertNoActiveTask(ctx.sessionManager);
  });

  it('does not append task-done when tree navigation is cancelled', async () => {
    const { pi, ctx, sm, setCancelNextNav } = makeHarness();
    setCancelNextNav(true);

    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    const rootId = sm.getLeafId()!;
    sm.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });
    const taskId = sm.getLeafId()!;
    sm.branch(taskId);
    sm.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: rootId });

    const entriesBefore = ctx.sessionManager.getEntries().length;

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assert.strictEqual(ctx.sessionManager.getEntries().length, entriesBefore);
  });

  it('supports a complete start-task → work → return roundtrip', async () => {
    const { pi, ctx, sm, sentMessages, sentCustomMessages } = makeHarness();

    // User starts a conversation
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    // LLM stores a task
    pi.appendEntry(TASK_ENTRY_TYPE, { prompt: 'Write tests first.' });

    // User runs /start-task
    const startCmd = createStartTaskCommand(pi);
    await startCmd.handler('', ctx);
    assert.deepStrictEqual(sentMessages, ['Write tests first.']);

    // Simulate assistant work on the branch
    sm.appendMessage(assistantMessage('Tests and implementation are complete.'));

    // User runs /return
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    // Last response should have been injected
    assert.strictEqual(sentCustomMessages.length, 1);

    // Task-done was appended, consuming the task
    assertNoActiveTask(ctx.sessionManager);
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

function assertNoActiveTask(sm: SessionManager): void {
  const task = getActiveTask(sm);
  assert.strictEqual(task, null, `Expected no active task, but found: ${JSON.stringify(task)}`);
}

describe('registration', () => {
  it('registers the push-task tool and all seven navigation commands', () => {
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
      { type: 'tool', name: 'push-task', description: 'Store a task prompt for a user-started navigation branch.' },
      { type: 'command', name: 'start-branch', description: 'Start a focused branch from the current position' },
      { type: 'command', name: 'start-fresh', description: 'Start a focused branch in a fresh context' },
      { type: 'command', name: 'start-task', description: 'Start the active task as a subagent' },
      { type: 'command', name: 'return', description: 'Return to the checkpoint for the current task branch' },
      { type: 'command', name: 'cancel', description: 'Return without summarizing the current task branch' },
      { type: 'command', name: 'discard-task', description: 'Discard the active task without executing it' },
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

describe('integration: nested /start-task', () => {
  it('supports /start-task → work → /return roundtrip with stacked tasks', async () => {
    const { pi, ctx, sentMessages } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'inner task' });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'outer task' });

    // /start-task: consumes outer task (most recent = closest to leaf)
    const startTaskCmd = createStartTaskCommand(pi);
    await startTaskCmd.handler('', ctx);
    assert.strictEqual(sentMessages[0], 'outer task');
    sentMessages.length = 0;

    // Work
    ctx.sessionManager.appendMessage(assistantMessage('doing outer'));

    // /return
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    // Outer task consumed, inner task is now active
    const active = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(active.prompt, 'inner task');
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

  it('/return with no checkpoint notifies without navigating', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'orphan task' });

    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
  });

  it('/cancel with no checkpoint notifies without navigating', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createCancelCommand(pi);
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

  it('/discard-task with no pending task notifies', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createDiscardTaskCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No pending task.');
  });

  it('/undo on first user message notifies', async () => {
    const { ctx, notifications } = makeHarness();
    const firstMsgId = ctx.sessionManager.appendMessage({ role: 'user', content: 'first', timestamp: 0 });

    ctx.sessionManager.branch(firstMsgId);

    const cmd = createUndoCommand();
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'info', 'Already at the start.');
  });

  it('user manually /tree away from branch then /return yields no return point', async () => {
    const { pi, ctx, notifications } = makeHarness();

    // Build a branch with a checkpoint
    const mainId = ctx.sessionManager.appendMessage({ role: 'user', content: 'main branch', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'task' });
    ctx.sessionManager.appendMessage(assistantMessage('ready'));
    const leafId = ctx.sessionManager.getLeafId()!;
    ctx.sessionManager.branch(leafId);
    ctx.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: leafId });
    ctx.sessionManager.appendMessage({ role: 'user', content: 'working on task', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working...'));

    // User manually /trees back to main
    ctx.sessionManager.branch(mainId);
    // Continue on main branch
    ctx.sessionManager.appendMessage({ role: 'user', content: 'continuing main', timestamp: 0 });

    // /return from main branch — checkpoint is on abandoned branch, not found
    const cmd = createReturnCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No return point.');
  });

  it('task called twice - second task is the active one (closest to leaf)', async () => {
    const { pi, ctx } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    pi.appendEntry(TASK_ENTRY_TYPE, { prompt: 'first task' });
    pi.appendEntry(TASK_ENTRY_TYPE, { prompt: 'second task' });

    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'second task');
  });

  it('after clearing second task, first task becomes active', async () => {
    const { pi, ctx } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
    pi.appendEntry(TASK_ENTRY_TYPE, { prompt: 'first task' });
    pi.appendEntry(TASK_ENTRY_TYPE, { prompt: 'second task' });

    const discardCmd = createDiscardTaskCommand(pi);
    await discardCmd.handler('', ctx);

    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'first task');
  });

  it('/undo from a /start-task branch goes to the injected task message', async () => {
    const { pi, ctx, navigations } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main message', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'task work' });

    // /start-task — injects the task prompt as the first user message
    const startTaskCmd = createStartTaskCommand(pi);
    await startTaskCmd.handler('', ctx);

    // Now on the branch. The only user message is the injected task prompt.
    // Simulate assistant work
    ctx.sessionManager.appendMessage(assistantMessage('working on branch'));

    navigations.length = 0;
    const undoCmd = createUndoCommand();
    await undoCmd.handler('', ctx);

    // Should navigate to the injected task message (the only user message on this branch)
    assert.strictEqual(navigations.length, 1);
    // The target should be a user message
    const targetEntry = ctx.sessionManager.getEntry(navigations[0].targetId);
    assert.ok(targetEntry);
    assert.strictEqual(targetEntry.type, 'message');
    if (targetEntry.type === 'message') {
      assert.strictEqual(targetEntry.message.role, 'user');
    }
  });
});

describe('integration: /start-task fresh context', () => {
  it('completes /start-task → work → /return with last-response injection', async () => {
    const { pi, ctx, sentMessages, sentCustomMessages, notifications } = makeHarness();

    // Main conversation
    ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working on main...'));

    // LLM stores a task
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Analyze performance.' });

    // /start-task
    const startCmd = createStartTaskCommand(pi);
    await startCmd.handler('', ctx);

    assert.deepStrictEqual(sentMessages, ['Analyze performance.']);

    // Simulate work on task branch
    ctx.sessionManager.appendMessage(assistantMessage('Found 3 bottlenecks: ...'));

    // /return
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    // Should inject last response
    assert.strictEqual(sentCustomMessages.length, 1);
    assert.strictEqual(sentCustomMessages[0].customType, 'branch-result');
    const content = sentCustomMessages[0].content as Array<{ text: string }>;
    assert.strictEqual(content[0].text, 'Found 3 bottlenecks: ...');

    assertLastNotification(notifications, 'info', 'Returned. Last response attached.');

    // Task should be consumed
    assertNoActiveTask(ctx.sessionManager);
  });
});

describe('integration: /start-task branch context', () => {
  it('completes /start-task branch → work → /return with last-response injection', async () => {
    const { pi, ctx, sentMessages, sentCustomMessages } = makeHarness();

    // Main conversation
    ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working...'));

    // LLM stores a branch-context task
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Quick fix.', context: 'branch' });

    // /start-task
    const startCmd = createStartTaskCommand(pi);
    await startCmd.handler('', ctx);

    assert.deepStrictEqual(sentMessages, ['Quick fix.']);

    // Simulate work
    ctx.sessionManager.appendMessage(assistantMessage('Fixed the bug.'));

    // /return
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    // Should inject last response
    assert.strictEqual(sentCustomMessages.length, 1);
    assert.strictEqual(sentCustomMessages[0].customType, 'branch-result');
    const content2 = sentCustomMessages[0].content as Array<{ text: string }>;
    assert.strictEqual(content2[0].text, 'Fixed the bug.');
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

function assertActiveTask(sm: SessionManager): TaskData {
  const task = getActiveTask(sm);
  assert.ok(task, 'Expected active task, found none.');
  return task;
}

function getActiveTask(sm: SessionManager): TaskData | null {
  const branch = sm.getBranch();
  let skip = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === 'custom' && e.customType === TASK_DONE_ENTRY_TYPE) {
      skip++;
    } else if (e.type === 'custom' && e.customType === TASK_ENTRY_TYPE) {
      if (skip === 0) return e.data as TaskData;
      skip--;
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
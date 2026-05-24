import assert from 'node:assert';

import { describe, it } from 'node:test';

import { SessionManager, type CustomEntry, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import registerNavigationCommands, {
  createStartBranchCommand,
  createReturnCommand,
  createTaskTool,
  createStartFreshCommand,
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

describe('createTaskTool', () => {
  it('stores a task entry and returns instruction text', async () => {
    const { pi, ctx, sm } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    const tool = createTaskTool(pi);
    await tool.execute('call-1', { prompt: 'Review the spec.' }, undefined, undefined, ctx);

    const task = assertActiveTask(ctx.sessionManager);
    assert.strictEqual(task.prompt, 'Review the spec.');
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

    const checkpoint = assertCheckpoint(ctx.sessionManager);
    assert.strictEqual(checkpoint.returnTo, leafBefore);
  });

  it('bookmarks the current leaf with a checkpoint and injects the active task prompt', async () => {
    const { pi, ctx, sm, sentMessages } = makeHarness();
    sm.appendMessage({ role: 'user', content: 'lets work', timestamp: 0 });
    sm.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Implement phase 1.' });
    const taskLeafId = ctx.sessionManager.getLeafId();

    const cmd = createStartBranchCommand(pi);
    await cmd.handler('', ctx);

    assert.deepStrictEqual(sentMessages, ['Implement phase 1.']);
    const checkpoint = assertCheckpoint(ctx.sessionManager);
    // returnTo is the leaf the checkpoint was created at (the task entry)
    assert.strictEqual(checkpoint.returnTo, taskLeafId);

    // The task is still findable from the new leaf
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
    const checkpoint = assertCheckpoint(ctx.sessionManager);
    assert.strictEqual(checkpoint.returnTo, leafBefore);
  });

  it('navigates to pre-conversation point, creates checkpoint on fresh branch, and injects task prompt', async () => {
    const { pi, ctx, sentMessages, navigations } = makeHarness();

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
    const checkpoint = assertCheckpoint(ctx.sessionManager);
    assert.strictEqual(checkpoint.returnTo, departureLeafId);

    // Task prompt should have been injected
    assert.deepStrictEqual(sentMessages, ['Review spec at docs/specs/design.md for completeness.']);
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

  it('supports a complete start-branch → work → return roundtrip', async () => {
    const { pi, ctx, sm, sentMessages, navigations } = makeHarness();

    // User starts a conversation
    sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

    // LLM stores a task
    pi.appendEntry(TASK_ENTRY_TYPE, { prompt: 'Write tests first.' });
    const taskLeafId = sm.getLeafId()!;

    // User runs /start-branch
    const startCmd = createStartBranchCommand(pi);
    await startCmd.handler('', ctx);
    assert.deepStrictEqual(sentMessages, ['Write tests first.']);

    // Simulate assistant work on the branch
    sm.appendMessage(assistantMessage('Tests and implementation are complete.'));

    // User runs /return
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    assert.strictEqual(navigations.length, 1);
    assert.strictEqual(navigations[0].targetId, taskLeafId);

    // Task-done was appended, consuming the task
    assertNoActiveTask(ctx.sessionManager);
  });
});

function assertNoActiveTask(sm: SessionManager): void {
  const task = getActiveTask(sm);
  assert.strictEqual(task, null, `Expected no active task, but found: ${JSON.stringify(task)}`);
}

describe('registration', () => {
  it('registers the task tool and all six navigation commands', () => {
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
      { type: 'tool', name: 'task', description: 'Store a task prompt for a user-started navigation branch.' },
      { type: 'command', name: 'start-branch', description: 'Start the active task from the current branch' },
      { type: 'command', name: 'start-fresh', description: 'Start the active task in a fresh context' },
      { type: 'command', name: 'return', description: 'Return to the checkpoint for the current task branch' },
      { type: 'command', name: 'cancel', description: 'Return without summarizing the current task branch' },
      { type: 'command', name: 'discard-task', description: 'Discard the active task without executing it' },
      { type: 'command', name: 'undo', description: 'Jump to the previous user message to re-prompt' },
    ]);
  });
});

describe('integration: nested /start-fresh', () => {
  it('completes /start-fresh → /return roundtrip with checkpoint', async () => {
    const { pi, ctx, sentMessages, notifications } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working...'));
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'fresh context task' });

    // /start-fresh: navigates to pre-conversation point
    const startFreshCmd = createStartFreshCommand(pi);
    await startFreshCmd.handler('', ctx);

    assert.strictEqual(sentMessages[0], 'fresh context task');

    // Simulate work on the fresh branch
    ctx.sessionManager.appendMessage(assistantMessage('task done'));

    // /return — navigates back to checkpoint
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);

    assertLastNotification(notifications, 'info', 'Returned. Branch summary attached.');

    // Task should be consumed
    const lastEntry = ctx.sessionManager.getEntries()[ctx.sessionManager.getEntries().length - 1];
    assert.strictEqual((lastEntry as CustomEntry).customType, TASK_DONE_ENTRY_TYPE);
  });
});

describe('integration: nested /start-branch', () => {
  it('supports /start-branch → work → /return roundtrip with stacked tasks', async () => {
    const { pi, ctx, sentMessages, notifications } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'inner task' });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'outer task' });

    // /start-branch: bookmarks, injects outer task (most recent = closest to leaf)
    const startBranchCmd = createStartBranchCommand(pi);
    await startBranchCmd.handler('', ctx);
    assert.strictEqual(sentMessages[0], 'outer task');
    sentMessages.length = 0;

    // Work
    ctx.sessionManager.appendMessage(assistantMessage('doing outer'));

    // /return
    const returnCmd = createReturnCommand(pi);
    await returnCmd.handler('', ctx);
    assertLastNotification(notifications, 'info', 'Returned. Branch summary attached.');

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

  it('/undo from a /start-fresh branch goes to the injected task message', async () => {
    const { pi, ctx, navigations } = makeHarness();

    ctx.sessionManager.appendMessage({ role: 'user', content: 'main message', timestamp: 0 });
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'fresh task' });

    // /start-fresh
    const startFreshCmd = createStartFreshCommand(pi);
    await startFreshCmd.handler('', ctx);

    // Now on fresh branch. The only user message is the injected task prompt.
    // Simulate assistant work
    ctx.sessionManager.appendMessage(assistantMessage('working on fresh branch'));

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

function assertCheckpoint(sm: SessionManager): CheckpointData {
  const cp = getCheckpoint(sm);
  assert.ok(cp, 'Expected checkpoint, found none.');
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
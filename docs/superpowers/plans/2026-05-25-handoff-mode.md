# Handoff Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add handoff mode to checkpoints so `/return` can either summarize the branch or inject the last assistant message verbatim.

**Architecture:** Checkpoints gain a `handoff` field (`"summary"` | `"last-response"`). Each `/start-*` command sets its own default handoff mode. A new `/start-task` command handles subagent-style workflows. `/return` reads the checkpoint's handoff mode and supports override via `/return last` or `/return summary`.

**Tech Stack:** TypeScript, Node.js test runner, typebox for schema validation

**Roadmap:** None

**Phase:** Single-plan implementation

---

## File Structure

| File | Responsibility |
|------|----------------|
| `index.ts` | All commands, tool, types, helpers |
| `index.test.ts` | All tests |

No new files needed — the feature extends existing commands and adds one new command.

---

### Task 1: Add `handoff` field to `CheckpointData` and update existing checkpoint creation

**Files:**
- Modify: `index.ts` (CheckpointData type, createStartBranchCommand, createStartFreshCommand)
- Modify: `index.test.ts` (assertCheckpoint helper, existing checkpoint assertions)

- [ ] **Step 1: Update `CheckpointData` interface**

```typescript
export interface CheckpointData {
  returnTo: string;
  handoff: "summary" | "last-response";
}
```

- [ ] **Step 2: Update `createStartBranchCommand` to set `handoff: "summary"`**

Find the `pi.appendEntry(CHECKPOINT_ENTRY_TYPE, ...)` call and add the `handoff` field:

```typescript
pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: ctx.sessionManager.getLeafId(), handoff: 'summary' });
```

- [ ] **Step 3: Update `createStartFreshCommand` to set `handoff: "summary"`**

Find the `pi.appendEntry(CHECKPOINT_ENTRY_TYPE, ...)` call and add the `handoff` field:

```typescript
pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: departureLeafId, handoff: 'summary' });
```

- [ ] **Step 4: Update `assertCheckpoint` in tests to validate `handoff` field**

```typescript
function assertCheckpoint(sm: SessionManager, expectedHandoff?: CheckpointData['handoff']): CheckpointData {
  const cp = getCheckpoint(sm);
  assert.ok(cp, 'Expected checkpoint, found none.');
  if (expectedHandoff) {
    assert.strictEqual(cp.handoff, expectedHandoff);
  }
  return cp;
}
```

- [ ] **Step 5: Update existing checkpoint assertions to verify `handoff: "summary"`**

In `createStartBranchCommand` tests:
```typescript
const checkpoint = assertCheckpoint(ctx.sessionManager, 'summary');
```

In `createStartFreshCommand` tests:
```typescript
const checkpoint = assertCheckpoint(ctx.sessionManager, 'summary');
```

- [ ] **Step 6: Run tests to verify everything still passes**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add index.ts index.test.ts
git commit -m "feat: add handoff field to CheckpointData"
```

---

### Task 2: Extract shared fresh-context logic into helper function

**Files:**
- Modify: `index.ts` (add `findFreshTargetId` helper, refactor `createStartFreshCommand`)

- [ ] **Step 1: Extract `findFreshTargetId` helper from `createStartFreshCommand`**

Add this helper function (near the other lookup utilities):

```typescript
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
```

- [ ] **Step 2: Refactor `createStartFreshCommand` to use `findFreshTargetId`**

Replace the inline fresh-target logic with:

```typescript
const freshTargetId = findFreshTargetId(ctx.sessionManager);
if (!freshTargetId) {
  ctx.ui.notify('No starting point found on current branch.', 'warning');
  return;
}

const result = await ctx.navigateTree(freshTargetId, { summarize: false });
if (result.cancelled) return;

pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: departureLeafId, handoff: 'summary' });
```

- [ ] **Step 3: Run tests to verify refactor didn't break anything**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "refactor: extract findFreshTargetId helper"
```

---

### Task 3: Add `context` field to `TaskData` and update `push-task`

**Files:**
- Modify: `index.ts` (TaskData type, pushTaskParameters, push-task storage)
- Modify: `index.test.ts` (tests for push-task with context)

- [ ] **Step 1: Update `TaskData` interface**

```typescript
export interface TaskData {
  prompt: string;
  context: "fresh" | "branch";
}
```

- [ ] **Step 2: Update `pushTaskParameters` schema**

```typescript
const pushTaskParameters = Type.Object({
  prompt: Type.String({ description: 'Full prompt for the task, including all context and instructions.' }),
  context: Type.Optional(Type.Union([
    Type.Literal('fresh'),
    Type.Literal('branch'),
  ], { description: 'Context mode: "fresh" (clean slate, default) or "branch" (current branch).' })),
});
```

- [ ] **Step 3: Update push-task storage to include context**

```typescript
pi.appendEntry(TASK_ENTRY_TYPE, { prompt: params.prompt, context: params.context ?? 'fresh' });
```

- [ ] **Step 4: Update existing push-task test to verify default context**

```typescript
it('pushes a task entry with default context "fresh"', async () => {
  const { pi, ctx, sm } = makeHarness();
  sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

  const tool = createPushTaskTool(pi);
  await tool.execute('call-1', { prompt: 'Review the spec.' }, undefined, undefined, ctx);

  const task = assertActiveTask(ctx.sessionManager);
  assert.strictEqual(task.prompt, 'Review the spec.');
  assert.strictEqual(task.context, 'fresh');
});
```

- [ ] **Step 5: Add test for push-task with explicit context**

```typescript
it('pushes a task entry with explicit context "branch"', async () => {
  const { pi, ctx, sm } = makeHarness();
  sm.appendMessage({ role: 'user', content: 'start', timestamp: 0 });

  const tool = createPushTaskTool(pi);
  await tool.execute('call-1', { prompt: 'Quick fix.', context: 'branch' }, undefined, undefined, ctx);

  const task = assertActiveTask(ctx.sessionManager);
  assert.strictEqual(task.prompt, 'Quick fix.');
  assert.strictEqual(task.context, 'branch');
});
```

- [ ] **Step 6: Run tests**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add index.ts index.test.ts
git commit -m "feat: add context field to TaskData and push-task"
```

---

### Task 4: Create `/start-task` command

**Files:**
- Modify: `index.ts` (add `createStartTaskCommand`, register it)
- Modify: `index.test.ts` (add tests for start-task)

- [ ] **Step 1: Implement `createStartTaskCommand`**

```typescript
export function createStartTaskCommand(pi: ExtensionAPI): CommandOptions {
  return {
    description: 'Start the active task as a subagent',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const activeTask = findActiveTask(ctx.sessionManager);
      if (!activeTask) {
        ctx.ui.notify('No pending task. Use push-task first.', 'warning');
        return;
      }

      const taskContext = activeTask.data.context ?? 'fresh';

      if (taskContext === 'fresh') {
        const departureLeafId = ctx.sessionManager.getLeafId()!;
        const freshTargetId = findFreshTargetId(ctx.sessionManager);
        if (!freshTargetId) {
          ctx.ui.notify('No starting point found on current branch.', 'warning');
          return;
        }

        const result = await ctx.navigateTree(freshTargetId, { summarize: false });
        if (result.cancelled) return;

        pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: departureLeafId, handoff: 'last-response' });
      } else {
        // Branch context — same as /start-branch
        pi.appendEntry(CHECKPOINT_ENTRY_TYPE, { returnTo: ctx.sessionManager.getLeafId(), handoff: 'last-response' });
      }

      pi.sendUserMessage(activeTask.data.prompt);
    },
  };
}
```

- [ ] **Step 2: Register the new command in `registerNavigationCommands`**

Add after the other command registrations:

```typescript
pi.registerCommand('start-task', createStartTaskCommand(pi));
```

- [ ] **Step 3: Export `createStartTaskCommand` for testing**

Add to the exports:

```typescript
export {
  createStartTaskCommand,
  // ... other exports
};
```

- [ ] **Step 4: Add test for `/start-task` with no pending task**

```typescript
describe('createStartTaskCommand', () => {
  it('notifies when there is no pending task', async () => {
    const { pi, ctx, notifications } = makeHarness();
    ctx.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: 0 });

    const cmd = createStartTaskCommand(pi);
    await cmd.handler('', ctx);

    assertLastNotification(notifications, 'warning', 'No pending task. Use push-task first.');
  });
```

- [ ] **Step 5: Add test for `/start-task` with `context: "fresh"`**

```typescript
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
```

- [ ] **Step 6: Add test for `/start-task` with `context: "branch"`**

```typescript
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
```

- [ ] **Step 7: Add test for `/start-task` with `context: "fresh"` (default)**

```typescript
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
```

- [ ] **Step 8: Update registration test to include `start-task`**

```typescript
it('registers the push-task tool and all seven navigation commands', () => {
  // Currently checks for 6 commands; after adding start-task, it should check for 7
  // ... update expected array to include:
  { type: 'command', name: 'start-task', description: 'Start the active task as a subagent' },
});
```

- [ ] **Step 9: Run tests**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add index.ts index.test.ts
git commit -m "feat: add /start-task command"
```

---

### Task 5: Update `/return` to support handoff modes and overrides

**Files:**
- Modify: `index.ts` (createReturnCommand)
- Modify: `index.test.ts` (update existing return tests, add new tests)

- [ ] **Step 1: Update `createReturnCommand` implementation**

Replace the entire function with:

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
      let handoff = checkpoint.data.handoff ?? 'summary';
      const trimmed = args.trim();
      if (trimmed === 'last' || trimmed === 'last-response') {
        handoff = 'last-response';
      } else if (trimmed === 'summary') {
        handoff = 'summary';
      }

      // Capture last assistant message before navigation (for last-response mode)
      let lastAssistantMessage: SessionEntry | undefined;
      if (handoff === 'last-response') {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry.type === 'message' && entry.message?.role === 'assistant') {
            lastAssistantMessage = entry;
            break;
          }
        }
      }

      const result = await ctx.navigateTree(checkpoint.data.returnTo, {
        summarize: handoff === 'summary',
      });
      if (result.cancelled) return;

      // Inject last assistant message after navigation
      if (handoff === 'last-response' && lastAssistantMessage) {
        pi.sendMessage({
          customType: 'branch-result',
          content: lastAssistantMessage.message.content,
          display: true,
          details: { sourceEntryId: lastAssistantMessage.id },
        }, { triggerTurn: true });
      }

      if (findActiveTask(ctx.sessionManager)) {
        pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
      }

      const label = handoff === 'last-response' ? 'Last response attached.' : 'Branch summary attached.';
      ctx.ui.notify(`Returned. ${label}`, 'info');
    },
  };
}
```

- [ ] **Step 2: Update `makeHarness` to support `sendMessage` spy**

Add `sentCustomMessages` array to track custom messages:

```typescript
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

  // ... rest of harness

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
```

- [ ] **Step 3: Update existing `/return` test to verify `summarize: true` is passed**

The existing test already checks this — verify it still passes with the new implementation.

- [ ] **Step 4: Add test for `/return` with `handoff: "last-response"`**

```typescript
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

  // navigateTree should be called with summarize: false
  // (harness tracks this via navigations array)

  // Should have injected the last assistant message
  assert.strictEqual(sentCustomMessages.length, 1);
  assert.strictEqual(sentCustomMessages[0].customType, 'branch-result');
  assert.ok(sentCustomMessages[0].options?.triggerTurn);

  assertLastNotification(notifications, 'info', 'Returned. Last response attached.');
});
```

- [ ] **Step 5: Add test for `/return last` override**

```typescript
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
```

- [ ] **Step 6: Add test for `/return summary` override**

```typescript
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
```

- [ ] **Step 7: Add test for `/return` with no assistant messages on branch**

```typescript
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
  assertLastNotification(notifications, 'info', 'Returned. Last response attached.');
});
```

- [ ] **Step 8: Run tests**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add index.ts index.test.ts
git commit -m "feat: implement handoff modes in /return"
```

---

### Task 6: Add integration tests for `/start-task` → `/return` roundtrip

**Files:**
- Modify: `index.test.ts` (add integration tests)

- [ ] **Step 1: Add integration test for fresh context task roundtrip**

```typescript
describe('integration: /start-task fresh context', () => {
  it('completes /start-task → work → /return with last-response injection', async () => {
    const { pi, ctx, sentMessages, sentCustomMessages, notifications } = makeHarness();

    // Main conversation
    ctx.sessionManager.appendMessage({ role: 'user', content: 'main work', timestamp: 0 });
    ctx.sessionManager.appendMessage(assistantMessage('working on main...'));

    // LLM stores a task
    ctx.sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { prompt: 'Analyze performance.' });
    const departureLeafId = ctx.sessionManager.getLeafId()!;

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
    assert.strictEqual((sentCustomMessages[0].content as Array<{ text: string }>)[0].text, 'Found 3 bottlenecks: ...');

    assertLastNotification(notifications, 'info', 'Returned. Last response attached.');

    // Task should be consumed
    assertNoActiveTask(ctx.sessionManager);
  });
});
```

- [ ] **Step 2: Add integration test for branch context task roundtrip**

```typescript
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
  });
});
```

- [ ] **Step 3: Run tests**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add index.test.ts
git commit -m "test: add integration tests for /start-task roundtrip"
```

---

### Task 7: Update README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `/return` command description**

Add override documentation:

```markdown
### `/return`

Jump back to the nearest checkpoint and attach a branch summary. The LLM on the main branch reads the summary and picks up where you left off.

Run this when your branch work is done and you want the findings folded into the main conversation. Shown in every [branching example](#spike-investigation).

**Override:** `/return last` injects the last assistant message verbatim (useful for subagent-style tasks). `/return summary` forces summarization regardless of checkpoint mode.
```

- [ ] **Step 2: Add `/start-task` command description**

After `/start-fresh`:

```markdown
### `/start-task`

Start the active task as a subagent. Requires a pending task (from `push-task`). The task's result is returned verbatim — no summarization.

The task's `context` parameter controls whether it runs in a fresh context or on the current branch:
- `context: "fresh"` (default) — clean slate, like `/start-fresh`
- `context: "branch"` — stays on current branch, like `/start-branch`

When the task is done, `/return` injects the last assistant message directly into the parent context.
```

- [ ] **Step 3: Update `push-task` documentation to include `context` parameter**

```markdown
### How it works

The LLM calls `push-task({ prompt: "...", context: "fresh" })`. The `context` parameter is optional (defaults to `"fresh"`):
- `"fresh"` — task runs in a clean context (via `/start-task`)
- `"branch"` — task runs on the current branch (via `/start-task`)

This stores a task entry in the session tree. Nothing else happens — no navigation, no branching, no context switch. The tool says "Task stored. Run `/start-task` to begin."
```

- [ ] **Step 4: Update the skill-driven review example to use `/start-task`**

Update the example to show the new workflow:

```markdown
LLM:     [calls push-task({ prompt: "Review docs/specs/feature-design.md...", context: "fresh" })]

LLM:     Task stored. Run /start-task for a fresh review.

You:     /start-task
Pi:      [jumps to pre-conversation point, injects task prompt]
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add /start-task and handoff mode documentation"
```

---

### Task 8: Run full test suite and verify

**Files:**
- None (verification only)

- [ ] **Step 1: Run all tests**

Run: `node --test index.test.ts`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript type checking**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify no regressions in existing commands**

All existing tests should still pass without modification (except those updated to check `handoff` field).

- [ ] **Step 4: Final commit if needed**

```bash
git add -A
git commit -m "chore: final cleanup for handoff mode feature"
```

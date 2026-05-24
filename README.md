# pi-navigator

Commands for common patterns when navigating [Pi](https://pi.dev) session tree.

## Install

```bash
pi install npm:pi-navigator
```

If Pi is already running, restart it or run `/reload`.

## Philosophy

Pi has a session tree you can already navigate with `/tree`, so you can control your context. This extension just adds a few commands for common workflows. No new subsystems, parallel processes, or any magic under the hood.

## Commands

### `/undo`

Jump back to the previous user message so you can re-prompt from there. If you're already at a user message, `/undo` goes to the one before it.

`/undo` is for fixing mistakes. You asked the wrong question, the LLM went down a tangent, you want to try a different prompt. `/undo` drops you at the last place you gave input. Similar to the same-named command in OpenCode. [Example](#fixing-a-wrong-turn).

### `/start-branch`

Mark your current position as a return point and keep working on the same branch. Use this for a spike, an investigation, or any focused piece of work inside your existing context.

This saves a checkpoint at your current position in the session tree. You get a notification and can keep working. When you're done, `/return` jumps you back to the checkpoint with a summary, compressing the branch into a single message. See the [example](#spike-investigation).

### `/start-fresh`

Like `/start-branch`, but jumps to a fresh context first - the point in the session just before the first user message. The LLM sees a clean context. Your existing conversation is still there, just invisible to this branch.

Useful for reviews, design work, or anything where previous conversation shouldn't influence the result. The checkpoint points back to where you were on the main branch, so `/return` always brings you home with a summary. See the [example](#fresh-context-review).

### `/return`

Jump back to the nearest checkpoint and attach a branch summary. The LLM on the main branch reads the summary and picks up where you left off.

Run this when your branch work is done and you want the findings folded into the main conversation. Shown in every [branching example](#spike-investigation).

### `/cancel`

Same as `/return` but without the summary. The branch is just dropped. Use this when the investigation was a dead end or you changed your mind. See the [example](#abandoning-a-dead-end).

## The `task` tool

The commands above work on their own. You can branch, return, and undo without the LLM ever calling a tool. But sometimes it's useful when skills hand you a prompt for the next branch. The `task` tool handles this use case.

### How it works

The LLM calls `task({ prompt: "..." })`. This stores a custom entry in the session tree. Nothing else happens — no navigation, no branching, no context switch. The tool says "Task stored. Run `/start-branch` or `/start-fresh` to begin."

When you later run `/start-branch` or `/start-fresh`, the command searches backward from the current leaf, finds the nearest pending `task` entry, and injects its prompt as the first message of the new branch. Later, when you run `/return`, a `task-done` marker is injected, preventing the task from firing again. To get a better idea of how it could be useful, see an [example](#skill-driven-review).

Multiple tasks can stack. If the LLM calls `task` twice before you run any `/start-*`, the second one (closer to the leaf) is picked up first. The first one waits underneath until that one is consumed.

### `/discard-task`

Discard the active task without executing it, inserting a `task-done` marker.

## Example workflows

### Fixing a wrong turn

`/undo` jumps back to your previous prompt. Use it when the LLM misunderstood, went down a tangent, or you want to rephrase your question.

```
You:     Write a React component that fetches user data and
         displays it in a table with sorting.

LLM:     Let me build a full data grid with server-side
         pagination, column resizing, virtual scrolling,
         and export to CSV. First, we'll need...

You:     /undo
Pi:      [jumps back to your previous message]

You:     Write a React component that fetches user data and
         displays it in a table with sorting. Client-side
         only, no extra features — I just need a simple table.

LLM:     Got it. Here's a simple table component with
         client-side sorting and data fetching.
```

### Spike investigation

You're working on a feature and realize you need to explore how a library handles edge cases before committing to an approach.

```
You:     /start-branch (or /start-fresh)
Pi:      Ready to work on this branch. Use /return or /cancel when done.

You:     How does zod handle recursive schemas? Show me examples.

LLM:     [digs through docs, writes example code, explains trade-offs]
LLM:     Looks like zod supports .lazy() for recursion but has limits
         with deep nesting. Here is what I found.

You:     /return
Pi:     [summarizes the spike into a branch_summary entry]
Pi:     Returned. Branch summary attached.

LLM:     [reads summary] Based on the zod recursive schema
         investigation, I recommend the .lazy() approach with a
         depth guard. Want me to implement it?
```

The spike compacts into a summary and folds back into the main conversation. The LLM on the main branch sees the findings without the back-and-forth — you get the answer without polluting the main context.

### Abandoning a dead end

`/cancel` is like `/return` but without a summary. Use it when the investigation was a dead end or you changed direction — the main branch picks up as if the branch never happened.

```
You:     /start-branch
Pi:      Ready to work on this branch.

You:     Can we parse the config with a custom grammar
         instead of JSON?

LLM:     [investigates parser generators, tries a few]
LLM:     This would add ~200KB to the bundle and the
         grammar gets complex with nested structures.
         JSON with schema validation is probably better.

You:     Yeah, not worth it. /cancel
Pi:     Cancelled. Branch abandoned without summary.

LLM:     [continues on main branch where you left off]
```

### Fresh-context review

`/start-fresh` jumps to a clean context so the LLM reads your work with fresh eyes. No prior conversation to anchor to — ideal for reviewing specs, designs, or code before committing to implementation.

```
You:     /start-fresh
Pi:      Ready to work on this branch. Use /return or /cancel
         when done.

You:     Review docs/specs/feature-design.md for completeness,
         consistency, and scope. Flag anything that needs
         clarification.

LLM:     [reads spec with no prior conversation bias]
LLM:     Found 3 issues: the error handling section is
         underspecified, the API surface has grown beyond
         the original scope, and the migration path for
         existing users is missing.

You:     /return
Pi:     [navigates back, appends summary]
Pi:     Returned. Branch summary attached.

LLM:     [reads summary] Good catches. Let me fix the error
         handling section first, then we can discuss scope.
```

### Skill-driven review

Skills, aware of this extension, can ask the LLM to get a fresh perspective before committing to something. Here's what that looks like with `task` and `/start-fresh`.

```
LLM:     I have written the spec. Before we proceed, let me queue
         a fresh-context review.

LLM:     [calls task({ prompt: "Review docs/specs/feature-design.md
         for completeness, consistency, scope, and YAGNI. Flag
         anything that needs clarification. Ask user to run /return
         when done." })]

LLM:     Task stored. Run /start-fresh for a fresh review.

You:     /start-fresh
Pi:      [jumps to pre-conversation point, injects task prompt]

LLM:     [reads spec with no prior conversation bias]
LLM:     Found 3 issues: the error handling section is
         underspecified, the API surface has grown beyond
         the original scope, and the migration path for
         existing users is missing. I recommend addressing
         these before implementation.

LLM:     Review done. Run /return.

You:     /return
Pi:     [navigates back, appends summary, marks task done]

LLM:     [reads summary] Good catches. Let me fix the error
         handling section first, then we can discuss scope.
```

Because the review ran in a fresh context, the LLM wasn't anchored to the decisions made during spec writing. It read the document cold.

## License

MIT. See [LICENSE](./LICENSE).

# pi-navigator

Commands for common patterns when navigating [Pi](https://pi.dev) session tree.

## Install

```bash
pi install npm:pi-navigator
```

If Pi is already running, restart it or run `/reload`.

## Philosophy

Pi has a session tree, that you can already navigate with `/tree`, providing precise control over context. This extension just adds a few commands for common workflows. No new subsystems, parallel processes or any magic under the hood.

## Commands

### `/undo`

Jump back to the previous user message so you can re-prompt from there. If you're already at a user message, `/undo` goes to the one before it.

`/undo` is for fixing mistakes. You asked the wrong question, the LLM went down a tangent, you want to try a different prompt. `/undo` drops you at the last place you gave input. Similar to same named command in OpenCode.

### `/start-branch`

Mark your current position as a return point and keep working on the same branch. Use this for a spike, an investigation, or any focused piece of work inside your existing context.

A checkpoint entry gets saved at your current position in the session tree. You get a notification and can continue working. When you're done, `/return` brings you back to the checkpoint with a summary - basically compressing all the context spent on the branch into a single message.

### `/start-fresh`

Like `/start-branch`, but jumps to a fresh context first - the point in the session just before the first user message. The LLM sees a clean context. Your existing conversation is still there, just invisible to this branch.

Useful for reviews, design work, or anything where previous conversation shouldn't influence the result. The checkpoint points back to where you were on the main branch, so `/return` always brings you home with a summary.

```
Before /start-fresh:
root
└─ user: "Let's design feature X"
   assistant: [design discussion...]
   assistant: "Design done, ready for a review."
   user: "/start-fresh"

After /start-fresh:
root
├─ [main branch still there, but LLM doesn't see it]
└─ checkpoint: { returnTo: main-branch-leaf }    ← sits before first user message
   user: "Review the spec at docs/specs/feature-design.md for completeness and consistency."
   assistant: [review findings]
   user: "/return"

After /return:
root
├─ [review branch still there, but LLM no longer sees it]
└─ user: "Let's design feature X"
   assistant: [design discussion...]
   assistant: "Design done, ready for a review."
   [branch summary]                        ← /return appends summary here
   assistant: [incorporates review findings, continues]
```

### `/return`

Walk back to the closest checkpoint and attach a branch summary. The LLM on the main branch reads the summary and picks up where you left off.

Run this when you're done with a sub-branch and want the findings folded back into the main line of work.

### `/cancel`

Same as `/return` but without the summary. The branch gets abandoned quietly. Use this when the investigation was a dead end or you changed your mind.

## The `task` tool

The commands above work on their own. You can branch, return, and undo without the LLM ever calling a tool. But sometimes it could be useful, if skills could hand you a specific prompt for the next branch. That's what `task` is for.

### How it works

The LLM calls `task({ prompt: "..." })`. This stores a custom entry in the session tree. Nothing else happens — no navigation, no branching, no context switch. The tool says "Task stored. Run `/start-branch` or `/start-fresh` to begin."

When you later run `/start-branch` or `/start-fresh`, the command searches backward from the current leaf, finds the nearest unconsumed `task` entry, and injects its prompt as a first message of a new branch. Later, when user uses `/return`, a `task-done` marker is injected, preventing task from being picked up again.

Multiple tasks can stack. If the LLM calls `task` twice before you run any `/start-*`, the second one (closer to the leaf) gets picked up first. The first one waits underneath until that one is consumed.

### `/clear-task`

Discard the active task without executing it, inserting `task-done` marker.

## Example workflows

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

The spike work gets compacted into a summary and folded back into the main conversation. The LLM on the main branch sees the findings without the back-and-forth. You got the answer without polluting the main context.

### Skill-driven review

Skills, aware of this extension, can ask the LLM to get a fresh perspective before committing to something. Here's how that could look like with `task` and `/start-fresh`.

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

Because the review ran in a fresh context, the LLM wasn't anchored to the decisions made during spec writing. It read the document cold — exactly what you want from a review.

## License

MIT. See [LICENSE](./LICENSE).

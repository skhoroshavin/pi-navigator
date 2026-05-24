# pi-navigator

Navigation extension for [Pi](https://pi.dev) — session tree navigation from slash commands.

## Install

```bash
pi install npm:pi-navigator
```

If Pi is already running, restart it or run `/reload`.

## Philosophy

Pi has a session tree, that allows very flexible navigation and context control using /tree command. This extension is just adding some additional easy-to-use commands for typical tasks. It is not yet another subagent framework - focus is on retaining user control, while improving the overall experience.

## Commands

### `/undo`

Jump back to the previous user message so you can re-prompt from there. If you are already at a user message, `/undo` goes to the one before it.

This is mostly about fixing mistakes. You asked the wrong question, the LLM went down a tangent, you want to try again with a different prompt. `/undo` drops you at the last point where you gave input. No summary, no checkpoint — just navigation.

### `/start-branch`

Mark your current position as a return point and keep working on the same branch. Run this when you want to do a spike, an investigation, or any focused piece of work within your existing context.

Behind the scenes, a checkpoint entry gets saved at your current position in the session tree. You get a notification and can start working. When you are done, `/return` brings you back to the checkpoint with a summary. `/cancel` brings you back without one.

### `/start-fresh`

Like `/start-branch`, but jumps to a fresh context first — the point in the session just before the first user message. The LLM sees a clean slate. Your existing conversation is still there, but invisible to this branch.

This is useful for reviews, design work, or anything that benefits from not being influenced by the conversation so far. The checkpoint that gets created points back to where you were on the main branch, so `/return` always brings you home.

```
Before /start-fresh:
root
└─ user: "Let's design feature X"
   └─ assistant: [design discussion...]
      └─ assistant: "Let me review what we have so far. Run /start-fresh."

After /start-fresh:
root
├─ [main branch continues...]
└─ checkpoint: { returnTo: main-branch-leaf }    ← sits before first user message
   └─ user: "Review the spec at docs/specs/feature-design.md
            for completeness and consistency."
      └─ assistant: [review findings]
         └─ assistant: "Done. Run /return."

After /return:
root
└─ user: "Let's design feature X"
   └─ assistant: [design discussion...]
      └─ assistant: "Let me review what we have so far. Run /start-fresh."
      └─ [branch summary]                        ← /return appends summary here
      └─ assistant: [incorporates review findings, continues]
```

### `/return`

Walk back to the closest checkpoint and attach a branch summary. The LLM on the main branch can read the summary and pick up where you left off.

Run this when you are done with a sub-branch and want the findings folded back into the main line of work.

### `/cancel`

Same as `/return` but without the summary. The branch gets abandoned quietly. Use this when the investigation turned out to be a dead end or you just changed your mind.

## The `task` tool

The commands above work on their own — you can branch, return, and undo without the LLM ever calling a tool. But skills and structured workflows often need the LLM to hand you a specific prompt for the next branch. That is what `task` does.

### How it works

The LLM calls `task({ prompt: "..." })`. This stores a custom entry in the session tree. Nothing else happens. No navigation, no branching, no context switch. The tool just says "Task stored. Run `/start-branch` or `/start-fresh` to begin."

When you later run `/start-branch` or `/start-fresh`, the command walks backward from the current leaf, finds the nearest unconsumed `task` entry, and injects its prompt. Each task gets consumed by exactly one `/start-*` or `/clear-task` call — a `task-done` marker prevents it from being picked up again.

Multiple tasks can stack. If the LLM calls `task` twice before you run any `/start-*`, the second one (closer to the leaf) gets picked up first. The first one waits underneath until that one is consumed.

### `/clear-task`

Discard the active task without executing it. Pairs with the `task` tool the same way `/cancel` pairs with `/return`: sometimes you just want to say "never mind" and move on.

## Example workflows

### Spike investigation

You are working on a feature and realize you need to explore how a library handles edge cases before committing to an approach. No task tool needed — just run `/start-branch`.

```
You:     /start-branch
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

The spike work got compacted into a summary and folded back into the main conversation. The LLM on the main branch sees the findings without the back-and-forth of the exploration itself. You got the answer you needed without polluting the main context.

### Skill-driven review

Many skills from pi-supergsd (brainstorming, code review, writing plans) ask the LLM to get a fresh perspective before committing to something. Here is what that looks like with `task` and `/start-fresh`.

```
LLM:     I have written the spec. Before we proceed, let me queue
         a fresh-context review.

LLM:     [calls task({ prompt: "Review docs/specs/feature-design.md
         for completeness, consistency, scope, and YAGNI. Flag
         anything that needs clarification." })]

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

Because the review ran in a fresh context, the LLM was not anchored to the decisions made during spec writing. It read the document as if coming to it cold, which is exactly what you want from a review.

### Nested fresh-context flow (design → plan → implement)

For structured workflows with multiple phases, you can chain `/start-fresh` calls. Each phase gets a clean context, and summaries bring the results back to the main branch as you go.

```
Main branch:

LLM:     [calls task({ prompt: "Design the authentication module.
         Produce a spec at docs/specs/auth-design.md." })]
LLM:     Run /start-fresh to begin the design phase.

You:     /start-fresh

Fresh branch (design):
LLM:     [writes design spec, commits it]
LLM:     Design done. Run /return.

You:     /return    ← back on main branch with design summary

Main branch:
LLM:     Design looks solid. Let me queue the planning phase.
LLM:     [calls task({ prompt: "Read docs/specs/auth-design.md
         and produce an implementation plan." })]
LLM:     Run /start-fresh to begin planning.

You:     /start-fresh

Fresh branch (planning):
LLM:     [writes implementation plan, commits it]
LLM:     Plan done. Run /return.

You:     /return    ← back on main branch with plan summary

Main branch:
LLM:     Plan covers all the edge cases. Implementation time.
LLM:     [calls task({ prompt: "Implement the auth module
         following docs/plans/auth-plan.md." })]
LLM:     Run /start-fresh to begin implementation.

You:     /start-fresh

Fresh branch (implementation):
LLM:     [writes code, writes tests, commits]
LLM:     Implementation complete. Run /return.

You:     /return    ← back on main branch, all phases summarized
```

Each phase got a clean slate. The design phase was not influenced by planning concerns. The planning phase saw the design summary but not the design conversation. The implementation phase saw the plan summary but not the planning back-and-forth. The main branch accumulated structured summaries at each step.

## License

MIT. See [LICENSE](./LICENSE).

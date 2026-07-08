# Architecture

A model-agnostic agent harness whose two design goals are **plan-first reasoning**
and **step-wise self-correction**. Everything below is derived from a single rule.

## The one rule

> Every model call is **stateless**. Therefore `RunContext` is the only source of
> truth, and it must always be serializable.

That rule alone buys long-horizon consistency, crash recovery, context compaction,
and reproducibility. Every other decision is reverse-engineered from it.

## The core loop

```
run(goal, config):
  ctx = RunContext.create(goal, config)
  ctx.plan = planner.plan(goal)                         # grounded in the executor's tools
  store.save(ctx)
  loop:
    if budget.exceeded:        return halted          # hard ceiling, checked first
    step = nextPendingStep(ctx)
    if step is null:
      if pending-but-stranded steps exist: replan      # a blocked plan is not a finished one
      if goal.successCriteria:
        verdict = reflector.verifyGoal(ctx)             # exit check — exhaustion ≠ completion
        if verdict != goal_met: replan; continue
      return done
    if contextManager.overBudget(ctx): compact         # required path on long runs
    obs        = executor.execute(step, ctx)
    reflection = reflector.reflect(plan, obs, ctx)
    applyReflection(ctx, step, obs, reflection)
    fold active runtime into budget.elapsedMs           # a crash is a pause, not spent time
    store.save(ctx)                                     # checkpoint — the invariant
    switch reflection.progress:
      goal_met     → done
      needs_replan → plan = planner.replan(...)         # accumulate, never reset
      blocked      → replan / escalate
      on_track     → continue
```

**Invariant:** at the end of every iteration, `ctx` equals what's on disk. So a
crash anywhere resumes from the last checkpoint with zero lost progress.

## RunContext — the state model

```ts
interface RunContext {
  runId: string;
  goal: Goal;
  plan: Plan;            // structured, NOT mixed into the chat
  history: Message[];    // the conversation handed to the model (compacted)
  digests: Digest[];     // folded-away history as summaries
  budget: BudgetState;
  config: SerializableConfig;
  createdAt; updatedAt;
  meta: Record<string, unknown>;  // extension slot
}
```

Three decisions:

1. **`plan` is separate from `history`.** The plan is structured truth; history is
   just text for the model. Mixed together, the model loses "which step am I on" in
   a growing pile of text. Separated, the plan stays sharp.
2. **`digests` exist.** Completed old turns are replaced by summaries — the storage
   for context compaction.
3. **`meta` is an open slot.** Extensions attach state without touching the core.

## Planner — accumulate, never reset

`replan()` preserves every `done` step verbatim (with its result) and regenerates
only the work after the blockage. The revision counter bumps each time. Making
replan a *full regeneration* is how long tasks loop forever; making it *accumulate*
is how they finish.

## Reflector — self-correction, and loop prevention

Four verdicts: `on_track`, `needs_replan`, `blocked`, `goal_met`. `goal_met` is
separate because an over-eager plan should be allowed to stop early — plan
exhaustion and goal completion are different events. The same principle runs in
the other direction too: when the plan runs out of steps and the goal has
success criteria, `verifyGoal` runs a final **exit check** against the recorded
evidence — an exhausted plan with unmet criteria replans instead of declaring a
false done.

It's a **heuristic + model hybrid**: cheap, certain things (a step that failed N
times in a row → `blocked`) are decided in code before any model call. The model
judges the rest — with schema-enforced structured output where the provider
supports it, JSON self-repair as the fallback, and a conservative default
(`needs_replan` on unparseable output — one more loop beats a wrong exit).

The exit check has **read-only hands**: tools marked `readOnly` are handed to
`verifyGoal`, which may inspect the actual artifacts (read files, list
directories) in a bounded tool loop before judging. Write tools are
structurally withheld from the verifier.

The reflector and the budget together are the **double safety net** against the two
runaway loops:

- **retry loop** — `step.attempts` + `maxStepAttempts` → forced `blocked`.
- **replan loop** — `budget.replans` + `maxReplans` → `halted`.

We never trust the model's judgment alone to terminate.

## ContextManager — compaction is a required path

Long runs *will* exceed the window. Old completed turns are folded into a digest;
the model then sees `[goal] + [digests] + [current plan] + [recent K messages]`.
Two rules: the **plan is never compacted** (it lives outside history for exactly
this reason), and the **most recent K messages are kept verbatim** (summarizing the
immediate context derails the very next step). Digests meta-compact if they grow.

## Failure modes & where each is stopped

| failure | guard | response |
| --- | --- | --- |
| model violates the JSON schema | `core/json` repair + planner/reflector | one repair call → conservative default |
| a single step retries forever | reflector + `step.attempts` | `maxStepAttempts` → blocked |
| replan storm | `budget.replans` | `maxReplans` → halted |
| context window overflow | contextManager | compaction (required path) |
| tool throws | executor try/catch | captured in `Observation.error` → reflector decides |
| process crash | store checkpoint | resume from last `ctx` |
| cost runaway | three budget guards | halt cleanly, work preserved |
| plan over/under-completes | reflector `goal_met` | stop when criteria met, even with steps left |
| plan exhausts with criteria unmet | reflector `verifyGoal` exit check | replan and keep working, never a false done |
| pending steps stranded by failed deps | loop step-selection | replan around them, never a false done |
| model refuses a step (safety) | provider `refusal` stop reason | observation fails → reflector routes; Fable-tier auto-fallback to opus |
| process dead for hours before resume | `budget.elapsedMs` folding | wall-clock counts active runtime only |

## Extension points (swap without touching the core)

- **Provider** — implement `complete()` + `estimateTokens()`. Model upgrade cost: 0.
- **Tool** — `ToolRegistry.register` / `defineTool`. Core unchanged.
- **Store** — file → SQLite/Redis/DB, same interface.
- **Compaction** — digest → sliding-window / vector recall.
- **meta** — extend state without a core change.

---

*The whole thing is a serializable source of truth (`RunContext`) on top of
stateless model calls. The planner draws the path, the executor walks it, the
reflector looks at the path again.*

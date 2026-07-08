import type { RunContext, RunResult, Observation, Reflection, Step, RunEvent } from "./types.js";
import type { Planner } from "../planner/planner.js";
import type { Executor } from "../executor/executor.js";
import type { Reflector } from "../reflector/reflector.js";
import type { ContextManager } from "../memory/context.js";
import type { Store } from "./types.js";
import { checkBudget } from "../run/budget.js";
import { nextPendingStep, touch } from "../run/context.js";

export interface LoopDeps {
  planner: Planner;
  executor: Executor;
  reflector: Reflector;
  contextManager: ContextManager;
  store: Store;
  onEvent: (e: RunEvent) => void;
}

function applyReflection(ctx: RunContext, step: Step, obs: Observation, reflection: Reflection): void {
  ctx.meta["lastReflectionNotes"] = reflection.notes;
  // (tokens are metered at the provider layer — every model call, not just execution)
  ctx.budget.steps += 1;
  if (obs.ok) {
    step.status = "done";
    step.result = obs.output.slice(0, 600);
  } else if (reflection.progress === "on_track") {
    // The reflector thinks this failure is recoverable → retry the same step.
    step.status = "pending";
  } else {
    step.status = "failed";
  }
}

/**
 * The plan ↔ execute ↔ reflect loop. Its one invariant: at the end of every
 * iteration, `ctx` equals what's on disk — so a crash anywhere resumes from the
 * last checkpoint with zero lost progress.
 */
export async function runLoop(ctx: RunContext, deps: LoopDeps): Promise<RunResult> {
  const { planner, executor, reflector, contextManager, store, onEvent } = deps;

  // Plan only if we don't already have one (a resumed run keeps its plan).
  if (ctx.plan.steps.length === 0) {
    ctx.plan = await planner.plan(ctx.goal);
    touch(ctx);
    await store.save(ctx);
    onEvent({ type: "plan_created", plan: ctx.plan });
  }

  while (true) {
    // 1. Hard budget ceiling.
    const guard = checkBudget(ctx);
    if (guard.exceeded) {
      ctx.plan.status = "failed";
      touch(ctx);
      await store.save(ctx);
      onEvent({ type: "halted", reason: guard.reason! });
      return { status: "halted", reason: guard.reason, ctx };
    }

    // 2. Next actionable step.
    const step = nextPendingStep(ctx);
    if (step === null) {
      // 2a. Pending steps exist but none is actionable — their dependencies
      // failed or don't exist. That is a blocked plan, not a finished one.
      const stranded = ctx.plan.steps.filter((s) => s.status === "pending");
      if (stranded.length > 0) {
        const reason = `steps [${stranded.map((s) => s.id).join(", ")}] can never run — their dependencies did not complete`;
        ctx.meta["lastReflectionNotes"] = reason;
        const obs: Observation = { stepId: stranded[0]!.id, ok: false, output: "", error: reason, tokensUsed: 0 };
        ctx.budget.replans += 1;
        ctx.plan = await planner.replan(ctx.plan, obs, ctx);
        touch(ctx);
        await store.save(ctx);
        onEvent({ type: "replan", revision: ctx.plan.revision, reason });
        continue;
      }

      // 2b. Plan exhausted. Plan exhaustion ≠ goal completion: when the goal
      // has explicit success criteria, verify them before declaring done —
      // and go back to work if they aren't met yet.
      if (ctx.goal.successCriteria?.length) {
        const verdict = await reflector.verifyGoal(ctx);
        onEvent({ type: "exit_check", reflection: verdict });
        if (verdict.progress !== "goal_met") {
          ctx.meta["lastReflectionNotes"] = verdict.notes;
          const obs: Observation = {
            stepId: "(exit-check)",
            ok: false,
            output: verdict.notes,
            error: "the plan ran out of steps but the success criteria are not met yet",
            tokensUsed: 0,
          };
          ctx.budget.replans += 1;
          ctx.plan = await planner.replan(ctx.plan, obs, ctx);
          touch(ctx);
          await store.save(ctx);
          onEvent({ type: "replan", revision: ctx.plan.revision, reason: verdict.notes || "success criteria not met" });
          continue;
        }
      }

      ctx.plan.status = "done";
      touch(ctx);
      await store.save(ctx);
      onEvent({ type: "done", reason: "all steps complete" });
      return { status: "done", reason: "all steps complete", ctx };
    }

    // 3. Compaction (a required path on long runs, not an optimization).
    if (contextManager.overBudget(ctx)) {
      const before = ctx.history.length;
      ctx.history = await contextManager.compact(ctx);
      onEvent({
        type: "compaction",
        foldedMessages: before - ctx.history.length,
        digestChars: ctx.digests.reduce((n, d) => n + d.summary.length, 0),
      });
    }

    // 4. Execute.
    step.status = "running";
    onEvent({ type: "step_start", step });
    const obs = await executor.execute(step, ctx);

    // 5. Reflect.
    const reflection = await reflector.reflect(ctx.plan, obs, ctx);

    // 6. Update state.
    applyReflection(ctx, step, obs, reflection);
    onEvent({ type: "step_done", step, observation: obs });
    onEvent({ type: "reflection", reflection, step });

    // 7. Checkpoint — the invariant. Fold active runtime into the budget here
    // so downtime between a crash and its resume never counts against the
    // wall-clock ceiling (a crash is a pause, not spent time).
    const now = Date.now();
    ctx.budget.elapsedMs = (ctx.budget.elapsedMs ?? 0) + (now - ctx.budget.startedAtMs);
    ctx.budget.startedAtMs = now;
    touch(ctx);
    await store.save(ctx);
    onEvent({ type: "checkpoint", runId: ctx.runId });

    // 8. Route on the verdict.
    switch (reflection.progress) {
      case "goal_met": {
        ctx.plan.status = "done";
        touch(ctx);
        await store.save(ctx);
        onEvent({ type: "done", reason: reflection.notes || "goal met" });
        return { status: "done", reason: reflection.notes || "goal met", ctx };
      }
      case "needs_replan": {
        ctx.budget.replans += 1;
        ctx.plan = await planner.replan(ctx.plan, obs, ctx);
        touch(ctx);
        await store.save(ctx);
        onEvent({ type: "replan", revision: ctx.plan.revision, reason: reflection.notes });
        break;
      }
      case "blocked": {
        onEvent({ type: "escalation", step, notes: reflection.notes });
        ctx.budget.replans += 1;
        ctx.plan = await planner.replan(ctx.plan, obs, ctx);
        touch(ctx);
        await store.save(ctx);
        onEvent({ type: "replan", revision: ctx.plan.revision, reason: `recovering from blocked: ${reflection.notes}` });
        break;
      }
      case "on_track":
      default:
        break;
    }
  }
}

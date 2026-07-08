import type { Plan, Observation, Reflection, Progress, RunContext, Provider } from "../core/types.js";
import { findStep } from "../run/context.js";
import { parseWithRepair } from "../core/json.js";
import { reflectPrompt, verifyPrompt } from "./prompts.js";

const PROGRESS_VALUES: Progress[] = ["on_track", "needs_replan", "blocked", "goal_met"];

interface RawReflection {
  progress?: unknown;
  notes?: unknown;
  confidence?: unknown;
}

export class Reflector {
  constructor(private readonly provider: Provider) {}

  async reflect(plan: Plan, obs: Observation, ctx: RunContext): Promise<Reflection> {
    const step = findStep(ctx, obs.stepId);

    // ── Heuristic pre-judgment (no model call) ──
    if (!obs.ok && step) {
      step.attempts += 1;
      if (step.attempts >= ctx.config.maxStepAttempts) {
        return {
          progress: "blocked",
          notes: `Step failed ${step.attempts} times in a row (last error: ${obs.error ?? "unknown"}). No path with the current plan.`,
          confidence: 0.95,
        };
      }
    }

    // ── Model judgment ──
    const res = await this.provider.complete({
      messages: reflectPrompt(plan, obs, ctx.goal, step),
      responseFormat: "json",
      temperature: 0,
    });

    const raw = await parseWithRepair<RawReflection>(res.content, this.provider, (v) => typeof v.progress === "string");

    if (!raw || typeof raw.progress !== "string" || !PROGRESS_VALUES.includes(raw.progress as Progress)) {
      // Conservative on parse failure: one more loop beats a wrong early exit.
      return { progress: "needs_replan", notes: "Could not parse a verdict; replanning conservatively." };
    }

    return {
      progress: raw.progress as Progress,
      notes: typeof raw.notes === "string" ? raw.notes : "",
      confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    };
  }

  /**
   * The final completion check, run when the plan runs out of steps. Plan
   * exhaustion and goal completion are different events — this is the moment
   * the harness verifies the success criteria against the recorded evidence
   * instead of assuming "no steps left" means "done".
   */
  async verifyGoal(ctx: RunContext): Promise<Reflection> {
    const res = await this.provider.complete({
      messages: verifyPrompt(ctx),
      responseFormat: "json",
      temperature: 0,
    });

    const raw = await parseWithRepair<RawReflection>(res.content, this.provider, (v) => typeof v.progress === "string");

    if (!raw || typeof raw.progress !== "string" || !PROGRESS_VALUES.includes(raw.progress as Progress)) {
      // Conservative on parse failure: one more loop beats a false "done".
      return { progress: "needs_replan", notes: "Could not parse the final goal check; replanning conservatively." };
    }

    return {
      progress: raw.progress as Progress,
      notes: typeof raw.notes === "string" ? raw.notes : "",
      confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    };
  }
}

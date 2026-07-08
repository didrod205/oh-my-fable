import type { Goal, Plan, Step, Observation, RunContext, Provider, ToolSchema } from "../core/types.js";
import { parseWithRepair } from "../core/json.js";
import { planPrompt, replanPrompt, PLAN_SCHEMA } from "./prompts.js";

interface RawStep {
  id?: unknown;
  intent?: unknown;
  dependsOn?: unknown;
}
interface RawPlan {
  steps?: RawStep[];
}

function coerceSteps(raw: RawPlan | null, idPrefix: string): Step[] {
  const steps: Step[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const s of raw?.steps ?? []) {
    if (typeof s?.intent !== "string" || s.intent.trim() === "") continue;
    let id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : `${idPrefix}${++n}`;
    while (seen.has(id)) id = `${idPrefix}${++n}`;
    seen.add(id);
    const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === "string") : undefined;
    steps.push({ id, intent: s.intent.trim(), dependsOn, status: "pending", attempts: 0 });
  }
  return steps;
}

export class Planner {
  constructor(
    private readonly provider: Provider,
    private readonly temperature: number,
    /** What the executor can actually do — plans grounded in real capabilities, not hypothetical ones. */
    private readonly tools: ToolSchema[] = [],
  ) {}

  async plan(goal: Goal): Promise<Plan> {
    const res = await this.provider.complete({ messages: planPrompt(goal, this.tools), responseFormat: "json", responseSchema: PLAN_SCHEMA, temperature: this.temperature });
    const raw = await parseWithRepair<RawPlan>(res.content, this.provider, (v) => Array.isArray(v.steps));
    let steps = coerceSteps(raw, "s");
    // Graceful degradation: a plan we can't read becomes a single do-the-goal step.
    if (steps.length === 0) {
      steps = [{ id: "s1", intent: goal.description, status: "pending", attempts: 0 }];
    }
    return { goal: goal.description, steps, status: "active", revision: 0 };
  }

  /**
   * Accumulate, never reset: completed steps are preserved verbatim; only the
   * remaining work is regenerated from the point of failure. This is what lets
   * a long task make forward progress instead of restarting forever.
   */
  async replan(plan: Plan, obs: Observation, ctx: RunContext): Promise<Plan> {
    const notes = String(ctx.meta["lastReflectionNotes"] ?? "");
    const res = await this.provider.complete({
      messages: replanPrompt(plan, obs, notes, ctx.goal, this.tools),
      responseFormat: "json",
      responseSchema: PLAN_SCHEMA,
      temperature: this.temperature,
    });
    const raw = await parseWithRepair<RawPlan>(res.content, this.provider, (v) => Array.isArray(v.steps));

    const revision = plan.revision + 1;
    const done = plan.steps.filter((s) => s.status === "done");
    const doneIds = new Set(done.map((s) => s.id));
    let fresh = coerceSteps(raw, `r${revision}s`).filter((s) => !doneIds.has(s.id));
    if (fresh.length === 0) {
      // Couldn't generate new steps — keep one explicit retry of the goal so the
      // run doesn't silently stall (the budget/replan guards bound this).
      fresh = [{ id: `r${revision}s1`, intent: `Make progress toward: ${ctx.goal.description}`, status: "pending", attempts: 0 }];
    }
    return { goal: plan.goal, steps: [...done, ...fresh], status: "active", revision };
  }
}

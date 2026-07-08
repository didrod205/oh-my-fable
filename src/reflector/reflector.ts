import type { Plan, Observation, Reflection, Progress, RunContext, Provider, Message, ToolResultBlock } from "../core/types.js";
import { findStep } from "../run/context.js";
import { parseWithRepair } from "../core/json.js";
import { reflectPrompt, verifyPrompt, REFLECTION_SCHEMA } from "./prompts.js";
import type { ToolRegistry } from "../executor/tools.js";

const PROGRESS_VALUES: Progress[] = ["on_track", "needs_replan", "blocked", "goal_met"];

/** Evidence-gathering is bounded — the verifier looks, it doesn't wander. */
const MAX_VERIFY_HOPS = 5;

interface RawReflection {
  progress?: unknown;
  notes?: unknown;
  confidence?: unknown;
}

export class Reflector {
  constructor(
    private readonly provider: Provider,
    /** Read-only tools the exit check may use to inspect real artifacts. */
    private readonly verifierTools?: ToolRegistry,
  ) {}

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
      responseSchema: REFLECTION_SCHEMA,
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
    // The verifier gets hands: read-only tools to inspect the real artifacts
    // (files, directories) the success criteria refer to — evidence over log.
    const registry = this.verifierTools && this.verifierTools.size > 0 ? this.verifierTools : undefined;
    const tools = registry ? registry.schemas() : undefined;
    const messages: Message[] = verifyPrompt(ctx, !!tools);

    let res = await this.provider.complete({
      messages,
      tools,
      responseFormat: "json",
      // Schema enforcement and tool use don't mix — prompt-JSON when inspecting.
      responseSchema: tools ? undefined : REFLECTION_SCHEMA,
      temperature: 0,
    });

    let hops = 0;
    while (registry && res.stopReason === "tool_use" && res.toolCalls?.length && hops < MAX_VERIFY_HOPS) {
      hops++;
      const resultsText: string[] = [];
      const resultBlocks: ToolResultBlock[] = [];
      for (const call of res.toolCalls) {
        const out = await registry.run(call.name, call.input);
        resultBlocks.push({ toolCallId: call.id, ok: out.ok, output: out.ok ? out.output : (out.error ?? "tool failed") });
        resultsText.push(`- ${call.name}: ${out.ok ? out.output : `ERROR: ${out.error}`}`);
      }
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
      messages.push({ role: "user", content: `Tool results:\n${resultsText.join("\n")}\n\nNow give your verdict.`, toolResults: resultBlocks });
      res = await this.provider.complete({ messages, tools, responseFormat: "json", temperature: 0 });
    }

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

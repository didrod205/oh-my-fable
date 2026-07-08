import type { Step, RunContext, Observation, Provider, Message, ToolCall, ToolResultBlock } from "../core/types.js";
import { ToolRegistry } from "./tools.js";

const EXEC_SYSTEM = `You are the execution module of an autonomous agent. You are given the overall goal for context and exactly ONE step to perform now.

- Do only this step. Don't get ahead of the plan.
- If a tool would help and tools are available, call it.
- Respond with the concrete result of the step — what you produced, found, or decided. Be specific and concise; this becomes the step's recorded result.`;

const MAX_TOOL_HOPS = 8;

function background(ctx: RunContext): string {
  const g = ctx.goal;
  const done = ctx.plan.steps.filter((s) => s.status === "done");
  const pending = ctx.plan.steps.filter((s) => s.status === "pending");
  const lines = [`Goal: ${g.description}`];
  if (g.constraints?.length) lines.push(`Constraints: ${g.constraints.join("; ")}`);
  if (g.successCriteria?.length) lines.push(`Done when: ${g.successCriteria.join("; ")}`);
  if (ctx.digests.length) {
    lines.push("", "Summary of earlier work:");
    for (const d of ctx.digests) lines.push(`  ${d.summary}`);
  }
  if (done.length) {
    lines.push("", "Completed steps:");
    for (const s of done) lines.push(`  ✓ ${s.intent}${s.result ? ` → ${s.result}` : ""}`);
  }
  if (pending.length) {
    lines.push("", "Still to do:");
    for (const s of pending) lines.push(`  • ${s.intent}`);
  }
  return lines.join("\n");
}

export class Executor {
  private registry: ToolRegistry;
  constructor(
    private readonly provider: Provider,
    registry: ToolRegistry,
    private readonly opts: { temperature: number; maxStepTokens: number },
  ) {
    this.registry = registry;
  }

  async execute(step: Step, ctx: RunContext): Promise<Observation> {
    const tools = this.registry.size > 0 ? this.registry.schemas() : undefined;

    // Cache-friendly ordering: stable content first (system, then the append-only
    // history), volatile content last (plan state + this step's instruction).
    // The last history message is flagged as a cache breakpoint — on providers
    // with prompt caching, each step re-reads the replayed history at ~0.1×
    // instead of paying full price for it every step. Copies only: the flag is
    // request-local and never persisted into the checkpointed history.
    const past: Message[] = ctx.history.map((m) => ({ ...m }));
    if (past.length > 0) past[past.length - 1] = { ...past[past.length - 1]!, cache: true };

    const local: Message[] = [
      { role: "system", content: EXEC_SYSTEM },
      ...past,
      { role: "user", content: `${background(ctx)}\n\nNow do this step:\n[${step.id}] ${step.intent}` },
    ];

    let tokensUsed = 0;
    const allToolCalls: ToolCall[] = [];
    let toolError: string | undefined;

    try {
      let result = await this.provider.complete({
        messages: local,
        tools,
        temperature: this.opts.temperature,
        maxTokens: this.opts.maxStepTokens,
      });
      tokensUsed += result.tokensIn + result.tokensOut;

      let hops = 0;
      while (result.stopReason === "tool_use" && result.toolCalls?.length && hops < MAX_TOOL_HOPS) {
        hops++;
        const resultsText: string[] = [];
        const resultBlocks: ToolResultBlock[] = [];
        for (const call of result.toolCalls) {
          allToolCalls.push(call);
          const out = await this.registry.run(call.name, call.input);
          if (!out.ok) toolError = out.error;
          resultBlocks.push({ toolCallId: call.id, ok: out.ok, output: out.ok ? out.output : (out.error ?? "tool failed") });
          resultsText.push(`- ${call.name}: ${out.ok ? out.output : `ERROR: ${out.error}`}`);
        }
        // Structured tool messages: providers with a native tool wire format
        // (Anthropic tool_use/tool_result, OpenAI tool_calls/role:"tool") render
        // these exactly; the flattened `content` is the text-only fallback.
        local.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
        local.push({ role: "user", content: `Tool results:\n${resultsText.join("\n")}\n\nContinue the step with these.`, toolResults: resultBlocks });
        result = await this.provider.complete({ messages: local, tools, temperature: this.opts.temperature, maxTokens: this.opts.maxStepTokens });
        tokensUsed += result.tokensIn + result.tokensOut;
      }

      const ok = result.stopReason !== "error" && result.stopReason !== "refusal";
      let output = result.content.trim() || (ok ? "(step produced no text output)" : "");
      // Surface truncation to the reflector — a cut-off result is a signal, not a success to record silently.
      if (ok && result.stopReason === "max_tokens") {
        output += "\n[note: the output hit the step token limit and was truncated]";
      }

      // Record the step exchange in history for continuity (kept lean; tools live in the observation).
      ctx.history.push({ role: "user", content: `Step [${step.id}]: ${step.intent}` });
      ctx.history.push({ role: "assistant", content: output });

      return {
        stepId: step.id,
        ok,
        output,
        toolCalls: allToolCalls.length ? allToolCalls : undefined,
        error: ok
          ? toolError
          : result.stopReason === "refusal"
            ? "the model declined this step (safety refusal) — the plan likely needs a different approach"
            : `model error (stopReason=${result.stopReason})`,
        tokensUsed,
      };
    } catch (err) {
      // A provider failure is itself an observation — let the reflector decide.
      return {
        stepId: step.id,
        ok: false,
        output: "",
        error: (err as Error).message ?? "execution failed",
        tokensUsed,
      };
    }
  }
}

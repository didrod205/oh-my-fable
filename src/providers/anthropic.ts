import type { Provider, CompletionRequest, CompletionResult, Message, ToolCall, ToolResultBlock, StopReason } from "../core/types.js";
import { estimateTokens, withRetry } from "./provider.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** anthropic-version header. */
  version?: string;
  maxRetries?: number;
  defaultMaxTokens?: number;
  /**
   * Cache the stable system + tools prefix with `cache_control: ephemeral`.
   * A durable agent replays a large prefix every step, so cached tokens cost
   * ~10× less. On by default; harmless when the prefix is below the cache
   * minimum (it just won't cache). Set false to disable.
   */
  cache?: boolean;
  /** Turn on adaptive thinking (recommended for planning/reflection on 4.7+/Fable). */
  thinking?: "adaptive";
  /** Reasoning/spend dial for thinking models: low | medium | high | xhigh | max. */
  effort?: Effort;
  /**
   * Server-side refusal fallback (`server-side-fallback` beta). Fable/Mythos
   * run safety classifiers that can decline a benign request mid-run; with a
   * fallback, the API transparently re-serves the request on the named model
   * instead of stopping the step. Defaults to "claude-opus-4-8" on Fable/Mythos
   * models; set `false` to disable, or a model id to override.
   */
  fallbackModel?: string | false;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Models that removed (or reject non-default) sampling parameters
 * (`temperature`/`top_p`/`top_k`) — sending `temperature` to any of these
 * returns HTTP 400. Opus 4.7/4.8, Sonnet 5, Fable 5, and Mythos 5. We strip it
 * for them so the provider works against the flagship models, not just older
 * Sonnets.
 */
export function modelRejectsSampling(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("opus-4-7") || m.includes("opus-4-8") || m.includes("sonnet-5") || m.includes("fable") || m.includes("mythos");
}

/** Fable-tier models run safety classifiers that can return `stop_reason: "refusal"`. */
function isFableTier(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("fable") || m.includes("mythos");
}

/**
 * Models with schema-enforced structured outputs (`output_config.format`).
 * When the request carries a `responseSchema`, these skip the prompt-instructed
 * JSON + repair path entirely — the API guarantees a schema-valid response.
 */
export function modelSupportsStructuredOutputs(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("sonnet-5") ||
    m.includes("opus-4-8") ||
    m.includes("haiku-4-5") ||
    m.includes("opus-4-5") ||
    m.includes("opus-4-1") ||
    m.includes("fable") ||
    m.includes("mythos")
  );
}

interface ConvoMessage {
  role: "user" | "assistant";
  content: string;
  cache?: boolean;
  toolCalls?: ToolCall[];
  toolResults?: ToolResultBlock[];
}

function hasToolParts(m: ConvoMessage): boolean {
  return !!(m.toolCalls?.length || m.toolResults?.length);
}

/** Coalesce consecutive same-role turns — the Messages API wants alternation. */
function coalesce(messages: ConvoMessage[]): ConvoMessage[] {
  const out: ConvoMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    // Never merge across structured tool messages — their block layout is exact.
    if (last && last.role === m.role && !hasToolParts(last) && !hasToolParts(m)) {
      last.content += "\n\n" + m.content;
      if (m.cache) last.cache = true;
    } else out.push({ ...m });
  }
  if (out.length === 0 || out[0]!.role !== "user") out.unshift({ role: "user", content: "(begin)" });
  // The API allows at most 4 cache breakpoints per request (1 is used by the
  // system block) — keep only the last 3 message-level flags, defensively.
  const flagged = out.filter((m) => m.cache);
  for (const m of flagged.slice(0, Math.max(0, flagged.length - 3))) m.cache = false;
  return out;
}

/**
 * The default provider — talks to the Anthropic Messages API over `fetch`, no
 * SDK, no dependencies. Swap in any other `Provider` to go model-agnostic.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly maxRetries: number;
  private readonly defaultMaxTokens: number;
  private readonly cache: boolean;
  private readonly thinking?: "adaptive";
  private readonly effort?: Effort;
  private readonly fallbackModel?: string;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    this.model = opts.model ?? "claude-sonnet-5";
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.version = opts.version ?? "2023-06-01";
    this.maxRetries = opts.maxRetries ?? 4;
    // Room for adaptive thinking: on Sonnet 5 / Fable-tier models, thinking is
    // on by default and shares the max_tokens budget with the visible output.
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 8192;
    this.cache = opts.cache ?? true;
    this.thinking = opts.thinking;
    this.effort = opts.effort;
    const fallback = opts.fallbackModel ?? (isFableTier(this.model) ? "claude-opus-4-8" : false);
    this.fallbackModel = fallback === false ? undefined : fallback;
    if (!this.apiKey) {
      throw new Error("AnthropicProvider needs an API key (pass { apiKey } or set ANTHROPIC_API_KEY).");
    }
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const convo = coalesce(
      req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content, cache: m.cache, toolCalls: m.toolCalls, toolResults: m.toolResults })),
    );

    // Render each message. Structured tool messages become native blocks
    // (tool_use / tool_result) — more precise than flattened text, and the ids
    // stay addressable. `Message.cache` hints become cache breakpoints, so the
    // stable prefix ending there is re-read at ~0.1× on the next call.
    const wireMessages = convo.map((m) => {
      if (hasToolParts(m)) {
        const blocks: Record<string, unknown>[] = [];
        // tool_result blocks must come first in a user message.
        for (const r of m.toolResults ?? []) {
          blocks.push({ type: "tool_result", tool_use_id: r.toolCallId, content: r.output, ...(r.ok ? {} : { is_error: true }) });
        }
        if (m.role === "assistant") {
          if (m.content) blocks.push({ type: "text", text: m.content });
          for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
        }
        return { role: m.role, content: blocks };
      }
      return m.cache && this.cache
        ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
        : { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages: wireMessages,
    };

    // Sampling: omit `temperature` for models that reject it (would 400), and
    // for thinking runs (thinking models don't take sampling params).
    if (typeof req.temperature === "number" && !this.thinking && !modelRejectsSampling(this.model)) {
      body["temperature"] = req.temperature;
    }

    if (this.thinking === "adaptive") body["thinking"] = { type: "adaptive" };

    // Schema-enforced structured outputs: guaranteed-valid JSON, no repair
    // round-trip. Only on models that support it, and only for plain JSON
    // requests (not combined with tool use).
    const useSchema =
      req.responseFormat === "json" && !!req.responseSchema && !req.tools?.length && modelSupportsStructuredOutputs(this.model);
    const outputConfig: Record<string, unknown> = {};
    if (this.effort) outputConfig["effort"] = this.effort;
    if (useSchema) outputConfig["format"] = { type: "json_schema", schema: req.responseSchema };
    if (Object.keys(outputConfig).length > 0) body["output_config"] = outputConfig;

    let sys = system;
    // The prompt-instructed JSON path is the fallback when the schema can't be enforced.
    if (req.responseFormat === "json" && !useSchema) sys = (sys ? sys + "\n\n" : "") + "Output ONLY valid JSON. No prose, no code fences.";
    if (sys) {
      // A cache breakpoint on the system block caches tools + system together.
      body["system"] = this.cache ? [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }] : sys;
    }
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.version,
    };
    // Refusal fallback (Fable/Mythos): if the safety classifiers decline the
    // request, the API re-serves it on the fallback model in the same call.
    if (this.fallbackModel) {
      body["fallbacks"] = [{ model: this.fallbackModel }];
      headers["anthropic-beta"] = "server-side-fallback-2026-06-01";
    }

    const data = await withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
          err.status = res.status;
          throw err;
        }
        return (await res.json()) as { content?: AnthropicBlock[]; stop_reason?: string; usage?: AnthropicUsage };
      },
      {
        retries: this.maxRetries,
        isRetryable: (e) => {
          const status = (e as { status?: number }).status;
          return status === undefined || status === 429 || (status >= 500 && status < 600);
        },
      },
    );

    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && block.text) content += block.text;
      else if (block.type === "tool_use" && block.name) toolCalls.push({ id: block.id ?? block.name, name: block.name, input: block.input });
    }

    // True input size = uncached + cache-read + cache-write, so the budget
    // reflects the real context the model saw, not just the uncached remainder.
    const u = data.usage ?? {};
    const tokensIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

    const map: Record<string, StopReason> = {
      end_turn: "end",
      tool_use: "tool_use",
      max_tokens: "max_tokens",
      stop_sequence: "end",
      // Fable-tier safety classifiers can decline a request; with fallbacks on,
      // this only surfaces when the whole chain refused. Never treat it as success.
      refusal: "refusal",
      model_context_window_exceeded: "error",
    };
    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      tokensIn,
      tokensOut: u.output_tokens ?? 0,
      stopReason: map[data.stop_reason ?? ""] ?? "end",
    };
  }
}

import type { Provider, CompletionRequest, CompletionResult, Message, ToolCall, StopReason } from "../core/types.js";
import { estimateTokens, withRetry } from "./provider.js";

export interface OpenAICompatOptions {
  /** e.g. http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), https://api.openai.com/v1 */
  baseUrl: string;
  /** Optional — local servers don't need one. */
  apiKey?: string;
  model: string;
  label?: string;
  maxRetries?: number;
  defaultMaxTokens?: number;
}

interface OAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OAIChoice {
  message?: { content?: string | null; tool_calls?: OAIToolCall[] };
  finish_reason?: string;
}
interface OAIResponse {
  choices?: OAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const FINISH: Record<string, StopReason> = { stop: "end", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

/**
 * Talks the OpenAI Chat Completions format — which means it works with almost
 * everything: **Ollama and LM Studio (local, no API key)**, llama.cpp's server,
 * OpenRouter, Groq, Together, OpenAI itself… Point `baseUrl` at any of them.
 * No SDK, no dependencies.
 */
export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly defaultMaxTokens: number;

  constructor(opts: OpenAICompatOptions) {
    if (!opts.baseUrl) throw new Error("OpenAICompatProvider needs a baseUrl.");
    if (!opts.model) throw new Error("OpenAICompatProvider needs a model.");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.name = opts.label ?? "openai-compatible";
    this.maxRetries = opts.maxRetries ?? 4;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Native tool wire format where the messages carry structured tool parts:
    // assistant `tool_calls`, results as `role: "tool"` messages. These only
    // occur when the same server produced tool_calls earlier, so it understands
    // the format. Plain messages pass through unchanged.
    const messages: Record<string, unknown>[] = [];
    for (const m of req.messages) {
      if (m.role === "user" && m.toolResults?.length) {
        for (const r of m.toolResults) {
          messages.push({ role: "tool", tool_call_id: r.toolCallId, content: r.ok ? r.output : `ERROR: ${r.output}` });
        }
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })),
        });
        continue;
      }
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      temperature: req.temperature ?? 1,
    };
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    // We rely on prompt-instructed JSON + the harness's parse-repair rather than
    // response_format, so even servers that don't support it work fine.

    const data = await withRetry(
      async () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
        const res = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new Error(`${this.name} ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
          err.status = res.status;
          throw err;
        }
        return (await res.json()) as OAIResponse;
      },
      {
        retries: this.maxRetries,
        isRetryable: (e) => {
          const s = (e as { status?: number }).status;
          return s === undefined || s === 429 || (s >= 500 && s < 600);
        },
      },
    );

    const choice = data.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const toolCalls: ToolCall[] = [];
    for (const tc of choice?.message?.tool_calls ?? []) {
      if (!tc.function?.name) continue;
      let input: unknown = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = tc.function.arguments ?? {};
      }
      toolCalls.push({ id: tc.id ?? tc.function.name, name: tc.function.name, input });
    }

    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      stopReason: FINISH[choice?.finish_reason ?? ""] ?? "end",
    };
  }
}

/** Convenience: a local Ollama model, no API key. `ollama("llama3.1")`. */
export function ollama(model: string, opts: Partial<OpenAICompatOptions> = {}): OpenAICompatProvider {
  return new OpenAICompatProvider({ baseUrl: "http://localhost:11434/v1", model, label: "ollama", ...opts });
}

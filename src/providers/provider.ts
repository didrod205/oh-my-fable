import type { Provider, CompletionRequest, CompletionResult, Message, ToolCall } from "../core/types.js";

export type { Provider } from "../core/types.js";

/** chars/4 — deliberately rough; only used to decide when to compact. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    // Tool arguments and results travel as structured fields, not in `content`.
    // Counting only the text under-reports a tool-using run by most of its
    // size, so compaction never triggers and the context overflows instead.
    for (const c of m.toolCalls ?? []) chars += c.name.length + JSON.stringify(c.input ?? {}).length;
    for (const r of m.toolResults ?? []) chars += r.output.length;
  }
  return Math.ceil(chars / 4);
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** Decide whether an error is worth retrying (429/5xx/network). */
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wrap a flaky async call with exponential backoff. Lives in the provider layer, not the loop. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const retryable = opts.isRetryable ?? (() => true);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !retryable(err)) break;
      await sleep(base * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ── ScriptedProvider — deterministic provider for tests & examples ───────────

export type ScriptedResponse = Partial<CompletionResult> | ((req: CompletionRequest) => Partial<CompletionResult>);

function fill(partial: Partial<CompletionResult>, req: CompletionRequest): CompletionResult {
  const content = partial.content ?? "";
  return {
    content,
    toolCalls: partial.toolCalls,
    tokensIn: partial.tokensIn ?? estimateTokens(req.messages),
    tokensOut: partial.tokensOut ?? Math.ceil(content.length / 4),
    stopReason: partial.stopReason ?? (partial.toolCalls && partial.toolCalls.length > 0 ? "tool_use" : "end"),
  };
}

/**
 * A provider that replays a fixed script of responses in order. The thing that
 * makes an agent built on this harness *deterministically testable* — script the
 * model and assert the loop's behavior, no network, no flakiness.
 */
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private index = 0;
  /** Every request the loop made — handy for assertions. */
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly responses: ScriptedResponse[]) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const r = this.responses[this.index];
    if (this.index < this.responses.length) this.index++;
    const resolved = typeof r === "function" ? r(req) : (r ?? { content: "", stopReason: "end" });
    return fill(resolved, req);
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }
}

// Builders that make scripts readable.
export const reply = {
  plan(steps: Array<{ id: string; intent: string; dependsOn?: string[] }>): ScriptedResponse {
    return { content: JSON.stringify({ steps }), stopReason: "end" };
  },
  reflection(progress: string, notes = "", confidence = 0.9): ScriptedResponse {
    return { content: JSON.stringify({ progress, notes, confidence }), stopReason: "end" };
  },
  text(content: string): ScriptedResponse {
    return { content, stopReason: "end" };
  },
  toolUse(calls: ToolCall[], content = ""): ScriptedResponse {
    return { content, toolCalls: calls, stopReason: "tool_use" };
  },
};

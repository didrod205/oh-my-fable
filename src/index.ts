import type { Goal, RunConfig, RunResult, RunContext, Provider } from "./core/types.js";
import { resolveSerializable } from "./config/defaults.js";
import { createContext } from "./run/context.js";
import { FileStore } from "./memory/store.js";
import { ToolRegistry } from "./executor/tools.js";
import { Planner } from "./planner/planner.js";
import { Executor } from "./executor/executor.js";
import { Reflector } from "./reflector/reflector.js";
import { ContextManager } from "./memory/context.js";
import { runLoop, type LoopDeps } from "./core/loop.js";

/**
 * Meter EVERY model call into the run's token budget — planning, reflection,
 * compaction, and JSON repair included, not just step execution. The `maxTokens`
 * ceiling should reflect what the run actually spends.
 */
function meterProvider(provider: Provider, ctx: RunContext): Provider {
  return {
    name: provider.name,
    estimateTokens: (messages) => provider.estimateTokens(messages),
    async complete(req) {
      const res = await provider.complete(req);
      ctx.budget.tokens += res.tokensIn + res.tokensOut;
      return res;
    },
  };
}

function buildDeps(config: RunConfig, ctx: RunContext): LoopDeps {
  const serializable = ctx.config;
  const provider = meterProvider(config.provider, ctx);
  const store = config.store ?? new FileStore(config.runsDir);
  const registry = new ToolRegistry(config.tools ?? []);
  // The exit-check verifier gets hands, but only read-only ones — it can look
  // at real artifacts (read files, list dirs) without being able to change them.
  const verifierTools = new ToolRegistry(registry.readOnlyTools());
  return {
    planner: new Planner(provider, serializable.temperature, registry.schemas()),
    executor: new Executor(provider, registry, { temperature: serializable.temperature, maxStepTokens: serializable.maxStepTokens }),
    reflector: new Reflector(provider, verifierTools),
    contextManager: new ContextManager(provider, serializable),
    store,
    onEvent: config.onEvent ?? (() => {}),
  };
}

/** Run an agent to completion (or to a budget halt). The whole run is checkpointed every step. */
export async function run(goal: Goal | string, config: RunConfig): Promise<RunResult> {
  const g: Goal = typeof goal === "string" ? { description: goal } : goal;
  const ctx = createContext(g, resolveSerializable(config));
  return runLoop(ctx, buildDeps(config, ctx));
}

/** Resume a run from its last checkpoint — same plan, same progress, continues where it died. */
export async function resume(runId: string, config: RunConfig): Promise<RunResult> {
  const store = config.store ?? new FileStore(config.runsDir);
  const ctx = await store.load(runId);
  if (!ctx) throw new Error(`No saved run found for "${runId}".`);
  // A crash is a pause: the downtime since the last checkpoint must not count
  // against the wall-clock budget. Active time survives in budget.elapsedMs.
  ctx.budget.elapsedMs ??= 0;
  ctx.budget.startedAtMs = Date.now();
  // Honor the run's own persisted budgets/limits; only the live deps come from `config`.
  return runLoop(ctx, buildDeps({ ...config, store }, ctx));
}

/** Continue a RunContext you already hold in memory (advanced; same as resume without the store load). */
export async function runWith(ctx: RunContext, config: RunConfig): Promise<RunResult> {
  // Same pause semantics as resume(): time since the context's last checkpoint
  // (however the caller obtained it) is not active runtime.
  ctx.budget.elapsedMs ??= 0;
  ctx.budget.startedAtMs = Date.now();
  return runLoop(ctx, buildDeps(config, ctx));
}

// ── Public surface ───────────────────────────────────────────────────────────
export type * from "./core/types.js";
export { DEFAULT_CONFIG, resolveSerializable } from "./config/defaults.js";
export { createContext, genId, nextPendingStep } from "./run/context.js";
export { checkBudget } from "./run/budget.js";
export { FileStore, MemoryStore } from "./memory/store.js";
export { ContextManager } from "./memory/context.js";
export { ToolRegistry, defineTool } from "./executor/tools.js";
export { fsTools } from "./tools/fs.js";
export { Planner } from "./planner/planner.js";
export { Executor } from "./executor/executor.js";
export { Reflector } from "./reflector/reflector.js";
export { runLoop } from "./core/loop.js";
export type { LoopDeps } from "./core/loop.js";
export { ScriptedProvider, reply, withRetry, estimateTokens } from "./providers/provider.js";
export type { ScriptedResponse } from "./providers/provider.js";
export { AnthropicProvider, modelRejectsSampling, modelSupportsStructuredOutputs } from "./providers/anthropic.js";
export type { AnthropicOptions, Effort } from "./providers/anthropic.js";
export { PLAN_SCHEMA } from "./planner/prompts.js";
export { REFLECTION_SCHEMA } from "./reflector/prompts.js";
export { OpenAICompatProvider, ollama } from "./providers/openai.js";
export type { OpenAICompatOptions } from "./providers/openai.js";
export { CliProvider, claudeCode, codexCli, parseClaudeJson, claudeRequestArgs, DEFAULT_CLAUDE_TOOLS } from "./providers/cli.js";
export type { CliProviderOptions, ClaudeCodeOptions, CodexCliOptions } from "./providers/cli.js";

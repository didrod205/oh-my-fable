// The complete type surface. Everything here is plain data and serializable —
// the harness's one non-negotiable rule is that RunContext is the only source of
// truth, and it must always round-trip through JSON.

// ── Goal & Plan ──────────────────────────────────────────────────────────────

export interface Goal {
  description: string;
  /** "don't do X" style guardrails. */
  constraints?: string[];
  /** Completion criteria the reflector checks against. */
  successCriteria?: string[];
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface Step {
  id: string;
  /** What this step is trying to achieve (natural language). */
  intent: string;
  dependsOn?: string[];
  status: StepStatus;
  attempts: number;
  /** Short summary of what the step produced, once done. */
  result?: string;
}

export type PlanStatus = "active" | "done" | "failed";

export interface Plan {
  goal: string;
  steps: Step[];
  status: PlanStatus;
  /** Bumped on every replan. */
  revision: number;
}

// ── Execution & Reflection ───────────────────────────────────────────────────

export interface Observation {
  stepId: string;
  ok: boolean;
  output: string;
  toolCalls?: ToolCall[];
  error?: string;
  tokensUsed: number;
}

export type Progress = "on_track" | "needs_replan" | "blocked" | "goal_met";

export interface Reflection {
  progress: Progress;
  notes: string;
  confidence?: number;
}

// ── Model calls ──────────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  /**
   * Provider hint: the stable prompt prefix ends at this message. Providers
   * that support prompt caching (Anthropic → `cache_control`) put a cache
   * breakpoint here; providers that don't simply ignore it.
   */
  cache?: boolean;
  /**
   * Tool calls this assistant message made (tool loop). Providers with a native
   * tool wire format render these as structured blocks (Anthropic `tool_use`,
   * OpenAI `tool_calls`); text-only providers fall back to `content`.
   */
  toolCalls?: ToolCall[];
  /**
   * Results for the previous assistant message's tool calls (tool loop).
   * Rendered natively where supported (Anthropic `tool_result`, OpenAI
   * `role: "tool"`); text-only providers fall back to `content`.
   */
  toolResults?: ToolResultBlock[];
}

/** One tool call's outcome, addressed back to the call that requested it. */
export interface ToolResultBlock {
  toolCallId: string;
  ok: boolean;
  /** The tool's output — or its error text when `ok` is false. */
  output: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON-schema object describing the parameters. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface CompletionRequest {
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  /**
   * JSON schema for the expected response (with `responseFormat: "json"`).
   * Providers that support schema-enforced output use it (Anthropic structured
   * outputs, `claude -p --json-schema`) — guaranteed-valid JSON, no repair
   * round-trip. Others fall back to prompt-instructed JSON + parse repair.
   */
  responseSchema?: Record<string, unknown>;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | "refusal";

export interface CompletionResult {
  content: string;
  toolCalls?: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  stopReason: StopReason;
  /** Provider session id, when the backend exposes one (e.g. `claude -p` --resume). */
  sessionId?: string;
  /** Real spend for this call in USD, when the backend reports it (e.g. claude --output-format json). */
  costUsd?: number;
}

// ── Budget, digest & result ──────────────────────────────────────────────────

export interface BudgetState {
  steps: number;
  tokens: number;
  /** Start of the *current* process session (reset on resume). */
  startedAtMs: number;
  /**
   * Active runtime consumed before `startedAtMs`, folded at each checkpoint.
   * This is what makes a crash a *pause*: the wall-clock budget counts time the
   * agent actually ran, never the downtime between a crash and its resume.
   * Optional so checkpoints written by older versions still load.
   */
  elapsedMs?: number;
  /** Separate counter so a replan storm can't run forever. */
  replans: number;
}

export interface Digest {
  summary: string;
  /** ISO timestamp this digest covers up to. */
  coversUntil: string;
}

// ── RunContext — the heart ───────────────────────────────────────────────────

export interface RunContext {
  runId: string;
  goal: Goal;
  plan: Plan;
  /** Conversation handed to the model (the thing that gets compacted). */
  history: Message[];
  /** Compacted summaries of folded-away history. */
  digests: Digest[];
  budget: BudgetState;
  config: SerializableConfig;
  createdAt: string;
  updatedAt: string;
  /** Extension slot — modules attach state without touching the core. */
  meta: Record<string, unknown>;
}

/** The subset of config that is data (persisted in RunContext). */
export interface SerializableConfig {
  maxSteps: number;
  maxTokens: number;
  maxWallClockMs: number;
  maxStepAttempts: number;
  maxReplans: number;
  contextTokenLimit: number;
  keepRecent: number;
  temperature: number;
  maxStepTokens: number;
}

export type RunStatus = "done" | "halted" | "failed";

export interface RunResult {
  status: RunStatus;
  reason?: string;
  ctx: RunContext;
}

export interface RunSummary {
  runId: string;
  goal: string;
  planStatus: PlanStatus;
  steps: number;
  updatedAt: string;
}

// ── Provider, Store, Tool ────────────────────────────────────────────────────

export interface Provider {
  name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Cheap token estimate (chars/4 is fine) — only used to decide compaction. */
  estimateTokens(messages: Message[]): number;
}

export interface Store {
  save(ctx: RunContext): Promise<void>;
  load(runId: string): Promise<RunContext | null>;
  list(): Promise<RunSummary[]>;
}

export interface Tool {
  name: string;
  description: string;
  schema: ToolSchema;
  handler(input: unknown): Promise<ToolResult> | ToolResult;
  /**
   * True for tools that only inspect state and never mutate it (read a file,
   * list a directory). Only these are handed to the exit-check verifier, so it
   * can look at real artifacts without being able to change them.
   */
  readOnly?: boolean;
}

// ── Observability ────────────────────────────────────────────────────────────

export type RunEvent =
  | { type: "plan_created"; plan: Plan }
  | { type: "step_start"; step: Step }
  | { type: "step_done"; step: Step; observation: Observation }
  | { type: "reflection"; reflection: Reflection; step: Step }
  | { type: "replan"; revision: number; reason: string }
  | { type: "compaction"; foldedMessages: number; digestChars: number }
  | { type: "checkpoint"; runId: string }
  | { type: "halted"; reason: string }
  | { type: "done"; reason: string }
  | { type: "escalation"; step: Step; notes: string }
  /** The final completion check when the plan runs out of steps (plan exhaustion ≠ goal completion). */
  | { type: "exit_check"; reflection: Reflection };

/** Full run config: data fields + injected dependencies. */
export interface RunConfig extends Partial<SerializableConfig> {
  provider: Provider;
  store?: Store;
  tools?: Tool[];
  /** Where the default FileStore writes. */
  runsDir?: string;
  /** Observe everything the loop does. */
  onEvent?: (event: RunEvent) => void;
}

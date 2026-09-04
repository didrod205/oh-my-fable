import { spawn } from "node:child_process";
import type { Provider, CompletionRequest, CompletionResult, Message, ToolCall, ToolSchema } from "../core/types.js";
import { estimateTokens } from "./provider.js";
import { extractJson, tryParse } from "../core/json.js";

export interface CliProviderOptions {
  /** The executable, e.g. "claude" or "codex". */
  command: string;
  /** Fixed args before the prompt, e.g. ["-p"] for Claude Code print mode. */
  args?: string[];
  /** Pass the prompt as the final arg ("arg", default) or on stdin ("stdin"). */
  promptVia?: "arg" | "stdin";
  /** Extract the assistant text from the command's stdout (text mode). Default: trim. */
  parse?: (stdout: string) => string;
  env?: Record<string, string>;
  timeoutMs?: number;
  label?: string;
  /** Static flags appended after `args` on every call (model, tool, permission flags). */
  extraArgs?: string[];
  /** Per-request flags computed from the request (e.g. --output-format, --append-system-prompt). */
  requestArgs?: (req: CompletionRequest) => string[];
  /**
   * Carry the CLI's own session from one call to the next, so it does not
   * re-discover the workspace every step. Only the calls where the CLI is doing
   * work are continued — see {@link CliProvider.complete}.
   */
  continueSession?: boolean;
  /** Structured stdout parser — takes precedence over `parse`; can return usage/session/cost. */
  parseResult?: (stdout: string) => Partial<CompletionResult>;
  /** Convey system messages inside the prompt (default) or out-of-band via `requestArgs`. */
  systemInPrompt?: boolean;
}

/** Flatten role-structured messages into one prompt for a text-only CLI. */
function flatten(messages: Message[], includeSystem: boolean): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" && !includeSystem) continue;
    if (m.role === "assistant") parts.push(`Assistant: ${m.content}`);
    else parts.push(m.content); // system + user read as plain instructions/content
  }
  return parts.join("\n\n");
}

// ── harness tools over a text protocol ───────────────────────────────────────
// An agentic CLI has no tools API to hand a schema to, so the tools the harness
// owns have to travel in the prompt and come back out of the text. Without this
// a CLI provider silently ignores `tools`: the model is never told they exist,
// invents a workaround, and the run quietly produces nothing.

const TOOL_SENTINEL = "oh-my-fable:tool_calls";

function toolManifest(tools: ToolSchema[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return (
    `\n\n## Tools available to you\n\n${list}\n\n` +
    `To call one or more of them, reply with ONLY this JSON and nothing else:\n` +
    `{"${TOOL_SENTINEL}": [{"name": "<tool>", "input": { ... }}]}\n` +
    `You will be given the results and can then continue. When you are done and ` +
    `no longer need a tool, reply normally with your answer instead.`
  );
}

/**
 * Every complete `{...}` object in `s`, skipping any trailing one that is cut
 * off. Quotes and escapes are tracked so a brace inside a string is not counted.
 */
function completeObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function asCall(entry: unknown, i: number): ToolCall | null {
  const e = entry as { name?: unknown; input?: unknown };
  if (typeof e?.name !== "string") return null;
  return { id: `cli_${Date.now().toString(36)}_${i}`, name: e.name, input: e.input ?? {} };
}

/**
 * Read back a tool-call block the model emitted, if it emitted one.
 *
 * A CLI answer can be cut off by a token cap mid-object, which leaves the whole
 * block unparseable. Dropping it silently loses the calls that WERE complete —
 * the model does the work, the harness records nothing, and the run reports
 * success. So fall back to salvaging every intact object out of the wreckage.
 */
function parseTextToolCalls(content: string): ToolCall[] | null {
  if (!content.includes(TOOL_SENTINEL)) return null;
  const block = extractJson(content);

  const parsed = tryParse<Record<string, unknown>>(block);
  const raw = parsed?.[TOOL_SENTINEL];
  if (Array.isArray(raw)) {
    const calls = raw.map(asCall).filter((c): c is ToolCall => c !== null);
    return calls.length ? calls : null;
  }

  // Truncated: take the complete entries that survive. Start scanning at the
  // array bracket, not right after the sentinel — the character following it is
  // the key's own closing quote, which would flip the scanner into "in string"
  // and make it read every brace after that as text.
  const arrayStart = block.indexOf("[", block.indexOf(TOOL_SENTINEL));
  if (arrayStart === -1) return null;
  const salvaged = completeObjects(block.slice(arrayStart))
    .map((o) => asCall(tryParse<unknown>(o), 0))
    .filter((c): c is ToolCall => c !== null)
    .map((c, i) => ({ ...c, id: `${c.id}_${i}` }));
  return salvaged.length ? salvaged : null;
}

/**
 * A missing CLI is the most common first failure, and "not on your PATH" alone
 * is a dead end — say what to do about it. The desktop Claude Code app in
 * particular is a paid install whose binary never lands on PATH.
 */
function notFound(command: string): string {
  const base = `"${command}" is not installed or not on your PATH.`;
  if (!/(^|\/)claude$/.test(command)) return base;
  return (
    base +
    "\n  If you use the Claude Code desktop app, its binary is inside the .app bundle:" +
    "\n    OMF_CLAUDE_BIN=\"$CLAUDE_CODE_EXECPATH\" oh-my-fable run ... --provider claude" +
    "\n  Otherwise install the CLI:  npm i -g @anthropic-ai/claude-code  (then `claude` and /login)"
  );
}

function runCli(command: string, args: string[], input: string | null, timeoutMs: number, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env: { ...process.env, ...env } });
    } catch (e) {
      return reject(e);
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(notFound(command)) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    // A child that exits before reading stdin makes this write emit EPIPE. An
    // unhandled 'error' on the stream takes the whole process down, turning a
    // misbehaving CLI into a crash of the harness driving it. The close/error
    // handlers above already report what actually went wrong.
    child.stdin!.on("error", () => {});
    if (input !== null) child.stdin!.write(input);
    child.stdin!.end();
  });
}

/**
 * Drives an agentic CLI (Claude Code, Codex, …) in non-interactive mode: every
 * model call shells out to the command and captures its stdout. This means
 * people who use those CLIs via a **subscription login use oh-my-fable with no
 * separate API key** — it rides whatever auth the CLI already has.
 */
export class CliProvider implements Provider {
  readonly name: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly promptVia: "arg" | "stdin";
  private readonly parse: (s: string) => string;
  private readonly env?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly requestArgs?: (req: CompletionRequest) => string[];
  private readonly parseResult?: (stdout: string) => Partial<CompletionResult>;
  private readonly systemInPrompt: boolean;
  private readonly continueSession: boolean;
  /** The CLI session to continue, once the CLI has told us one exists. */
  private sessionId?: string;

  constructor(opts: CliProviderOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.promptVia = opts.promptVia ?? "arg";
    this.parse = opts.parse ?? ((s) => s.trim());
    this.env = opts.env;
    // An agentic CLI step is not a chat completion: it reads files, runs tests,
    // and thinks. Two minutes SIGKILLs it mid-work, and the harness reports a
    // timeout for a step that was progressing fine.
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.name = opts.label ?? `cli:${opts.command}`;
    this.extraArgs = opts.extraArgs ?? [];
    this.requestArgs = opts.requestArgs;
    this.parseResult = opts.parseResult;
    this.systemInPrompt = opts.systemInPrompt ?? true;
    this.continueSession = opts.continueSession ?? false;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Tools the harness owns only reach an agentic CLI through the prompt.
    const harnessTools = req.tools ?? [];
    const prompt = flatten(req.messages, this.systemInPrompt) + (harnessTools.length ? toolManifest(harnessTools) : "");
    const reqArgs = this.requestArgs ? this.requestArgs(req) : [];
    const argv = [...this.args, ...this.extraArgs, ...reqArgs];

    // Continue the CLI's session for work calls only. Planning and reflection
    // must not inherit the executor's conversation: a reflector that remembers
    // doing the work is not an independent check of it, and the exit check
    // least of all. Those are the calls that ask for JSON, so they stay fresh.
    const isWorkCall = req.responseFormat !== "json";
    const resuming = this.continueSession && isWorkCall && this.sessionId ? this.sessionId : undefined;
    const withSession = resuming ? [...argv, "--resume", resuming] : argv;
    const finalArgs = this.promptVia === "arg" ? [...withSession, prompt] : withSession;

    let stdout: string;
    try {
      stdout = await runCli(this.command, finalArgs, this.promptVia === "stdin" ? prompt : null, this.timeoutMs, this.env);
    } catch (err) {
      // A session the CLI no longer knows about must not strand the run: drop it
      // and take the cold start we were trying to avoid.
      if (!resuming) throw err;
      this.sessionId = undefined;
      const cold = this.promptVia === "arg" ? [...argv, prompt] : argv;
      stdout = await runCli(this.command, cold, this.promptVia === "stdin" ? prompt : null, this.timeoutMs, this.env);
    }

    if (this.parseResult) {
      const r = this.parseResult(stdout);
      if (this.continueSession && isWorkCall && r.sessionId) this.sessionId = r.sessionId;
      const content = r.content ?? "";
      const textCalls = harnessTools.length && !r.toolCalls?.length ? parseTextToolCalls(content) : null;
      const toolCalls = r.toolCalls?.length ? r.toolCalls : (textCalls ?? undefined);
      return {
        content,
        toolCalls,
        tokensIn: r.tokensIn ?? estimateTokens(req.messages),
        tokensOut: r.tokensOut ?? Math.ceil(content.length / 4),
        stopReason: toolCalls?.length ? "tool_use" : (r.stopReason ?? "end"),
        sessionId: r.sessionId,
        costUsd: r.costUsd,
      };
    }

    const content = this.parse(stdout);
    const toolCalls = harnessTools.length ? (parseTextToolCalls(content) ?? undefined) : undefined;
    return {
      content,
      toolCalls,
      tokensIn: estimateTokens(req.messages),
      tokensOut: Math.ceil(content.length / 4),
      stopReason: toolCalls?.length ? "tool_use" : "end",
    };
  }
}

// ── Claude Code (`claude -p`) ────────────────────────────────────────────────

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/**
 * Parse the JSON object printed by `claude -p --output-format json`. Pulls the
 * real result text (or `structured_output` when `--json-schema` was used), the
 * session id (for `--resume`), the real cost, and token usage — replacing the
 * crude `length / 4` estimate the text path has to fall back to.
 */
export function parseClaudeJson(stdout: string): Partial<CompletionResult> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { content: stdout.trim() };
  }
  let content: string;
  if (data["structured_output"] !== undefined) {
    const so = data["structured_output"];
    content = typeof so === "string" ? so : JSON.stringify(so);
  } else {
    content = typeof data["result"] === "string" ? (data["result"] as string) : stdout.trim();
  }
  const usage = (data["usage"] as Record<string, unknown> | undefined) ?? {};
  const tokensIn = num(usage["input_tokens"]) + num(usage["cache_read_input_tokens"]) + num(usage["cache_creation_input_tokens"]);
  const tokensOut = num(usage["output_tokens"]);
  const out: Partial<CompletionResult> = { content };
  if (tokensIn) out.tokensIn = tokensIn;
  if (tokensOut) out.tokensOut = tokensOut;
  if (typeof data["session_id"] === "string") out.sessionId = data["session_id"] as string;
  if (typeof data["total_cost_usd"] === "number") out.costUsd = data["total_cost_usd"] as number;
  return out;
}

/** Per-request flags for `claude -p`: structured output, system prompt, optional schema. */
export function claudeRequestArgs(
  req: CompletionRequest,
  opts: { json: boolean; appendSystem: boolean; jsonSchema?: Record<string, unknown> },
): string[] {
  const args: string[] = [];
  if (opts.json) args.push("--output-format", "json");
  // A static option schema wins; otherwise the request's own schema (the
  // harness passes one for plans and reflections) is enforced per call.
  const schema = req.responseFormat === "json" ? (opts.jsonSchema ?? req.responseSchema) : undefined;
  if (opts.appendSystem) {
    let sys = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    if (req.responseFormat === "json" && !schema) sys = (sys ? sys + "\n\n" : "") + "Output ONLY valid JSON. No prose, no code fences.";
    if (sys) args.push("--append-system-prompt", sys);
  }
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  return args;
}

/** A safe default tool allowlist when you let Claude do the work itself — files, no raw shell. */
export const DEFAULT_CLAUDE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

export interface ClaudeCodeOptions {
  /** Model alias or id, e.g. "opus" / "sonnet" / "claude-opus-4-8". */
  model?: string;
  /** Use `--output-format json` for reliable extraction + real cost/usage/session. Default true. */
  json?: boolean;
  /** Pass system messages via `--append-system-prompt` instead of inlining. Default true. */
  appendSystem?: boolean;
  /** When set and a call asks for JSON, enforce it with `--json-schema` and read `structured_output`. */
  jsonSchema?: Record<string, unknown>;
  /**
   * Let Claude run its OWN tools (Read/Write/Edit/Bash…) during each step — a
   * durable, tool-using agent on your subscription, no API key. `true` uses a
   * safe file-only allowlist; pass an array to choose (e.g. ["Read","Edit","Bash(npm test)"]).
   */
  tools?: boolean | string[];
  /** Permission mode for unattended runs: "acceptEdits" (default when tools on) | "dontAsk" | "plan". */
  permissionMode?: string;
  /** Extra directories Claude may touch (`--add-dir`). */
  addDirs?: string[];
  /** Continue a prior `claude` session id (`--resume`) — preserves its context + cache. */
  resumeSessionId?: string;
  /**
   * Keep the CLI's own session across steps instead of starting cold each time.
   * Applies to work calls only; planning and reflection stay independent, since
   * a reflector that remembers doing the work is not a check on it.
   *
   * Measure before trusting it. Resuming means every later turn re-sends the
   * accumulated transcript, and that can grow faster than the cache saves.
   * Turning it on partway through a long build — at step 11, inheriting the
   * largest session there had been — cost 86% more tokens per step over the
   * next four steps (931k → 1.73M) and ran slower. It may still pay off on a
   * session kept small from the first step; that case is untested. Off by
   * default for this reason.
   */
  continueSession?: boolean;
  /**
   * Path to the `claude` binary. Defaults to whatever resolution order
   * {@link resolveClaudeCommand} uses — needed when Claude Code is installed as
   * the desktop app, whose binary lives inside the .app bundle and is not on PATH.
   */
  command?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  label?: string;
}

/**
 * Find the `claude` binary. Paying for Claude Code does not guarantee a `claude`
 * on PATH: the desktop app ships its own binary inside the .app bundle, and
 * exports its location as CLAUDE_CODE_EXECPATH. Look there before giving up.
 *
 * Order: explicit argument → OMF_CLAUDE_BIN → CLAUDE_CODE_EXECPATH → "claude".
 */
export function resolveClaudeCommand(explicit?: string): string {
  return explicit || process.env["OMF_CLAUDE_BIN"] || process.env["CLAUDE_CODE_EXECPATH"] || "claude";
}

/** Claude Code in print mode — uses your existing `claude` auth (subscription or key). */
export function claudeCode(opts: ClaudeCodeOptions = {}): CliProvider {
  const json = opts.json ?? true;
  const appendSystem = opts.appendSystem ?? true;
  const extra: string[] = [];
  if (opts.model) extra.push("--model", opts.model);
  if (opts.tools) {
    const allow = Array.isArray(opts.tools) ? opts.tools : DEFAULT_CLAUDE_TOOLS;
    extra.push("--allowedTools", allow.join(","), "--permission-mode", opts.permissionMode ?? "acceptEdits");
  } else if (opts.permissionMode) {
    extra.push("--permission-mode", opts.permissionMode);
  }
  for (const d of opts.addDirs ?? []) extra.push("--add-dir", d);
  if (opts.resumeSessionId) extra.push("--resume", opts.resumeSessionId);
  return new CliProvider({
    command: resolveClaudeCommand(opts.command),
    args: ["-p"],
    continueSession: opts.continueSession,
    promptVia: "arg",
    label: "claude-code",
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    extraArgs: extra,
    requestArgs: (req) => claudeRequestArgs(req, { json, appendSystem, jsonSchema: opts.jsonSchema }),
    parseResult: json ? parseClaudeJson : undefined,
    systemInPrompt: !appendSystem,
  });
}

// ── OpenAI Codex (`codex exec`) ──────────────────────────────────────────────

export interface CodexCliOptions {
  model?: string;
  /** Sandbox for tool execution: "read-only" (default) | "workspace-write" | "danger-full-access". */
  sandbox?: string;
  /** Approval policy: "untrusted" | "on-request" | "never". */
  approval?: string;
  /** Convenience: let Codex edit the workspace unattended (workspace-write + never-ask). */
  tools?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  label?: string;
}

/** OpenAI Codex CLI in non-interactive exec mode — uses your existing `codex` auth. */
export function codexCli(opts: CodexCliOptions = {}): CliProvider {
  const extra: string[] = [];
  if (opts.model) extra.push("--model", opts.model);
  const sandbox = opts.sandbox ?? (opts.tools ? "workspace-write" : undefined);
  if (sandbox) extra.push("--sandbox", sandbox);
  const approval = opts.approval ?? (opts.tools ? "never" : undefined);
  if (approval) extra.push("--ask-for-approval", approval);
  return new CliProvider({
    command: "codex",
    args: ["exec"],
    promptVia: "arg",
    label: "codex",
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    extraArgs: extra,
  });
}

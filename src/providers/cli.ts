import { spawn } from "node:child_process";
import type { Provider, CompletionRequest, CompletionResult, Message } from "../core/types.js";
import { estimateTokens } from "./provider.js";

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
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`"${command}" is not installed or not on your PATH.`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
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

  constructor(opts: CliProviderOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.promptVia = opts.promptVia ?? "arg";
    this.parse = opts.parse ?? ((s) => s.trim());
    this.env = opts.env;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.name = opts.label ?? `cli:${opts.command}`;
    this.extraArgs = opts.extraArgs ?? [];
    this.requestArgs = opts.requestArgs;
    this.parseResult = opts.parseResult;
    this.systemInPrompt = opts.systemInPrompt ?? true;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const prompt = flatten(req.messages, this.systemInPrompt);
    const reqArgs = this.requestArgs ? this.requestArgs(req) : [];
    const argv = [...this.args, ...this.extraArgs, ...reqArgs];
    const finalArgs = this.promptVia === "arg" ? [...argv, prompt] : argv;
    const stdout = await runCli(this.command, finalArgs, this.promptVia === "stdin" ? prompt : null, this.timeoutMs, this.env);

    if (this.parseResult) {
      const r = this.parseResult(stdout);
      const content = r.content ?? "";
      return {
        content,
        toolCalls: r.toolCalls,
        tokensIn: r.tokensIn ?? estimateTokens(req.messages),
        tokensOut: r.tokensOut ?? Math.ceil(content.length / 4),
        stopReason: r.stopReason ?? "end",
        sessionId: r.sessionId,
        costUsd: r.costUsd,
      };
    }

    const content = this.parse(stdout);
    return {
      content,
      tokensIn: estimateTokens(req.messages),
      tokensOut: Math.ceil(content.length / 4),
      stopReason: "end",
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
  timeoutMs?: number;
  env?: Record<string, string>;
  label?: string;
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
    command: "claude",
    args: ["-p"],
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

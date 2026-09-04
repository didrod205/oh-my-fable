#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createContext } from "./run/context.js";
import { resolveSerializable } from "./config/defaults.js";
import { runWith, resume } from "./index.js";
import { FileStore } from "./memory/store.js";
import { fsTools } from "./tools/fs.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatProvider, ollama } from "./providers/openai.js";
import { claudeCode, codexCli } from "./providers/cli.js";
import { ScriptedProvider, reply } from "./providers/provider.js";
import type { RunEvent, Goal, RunConfig, Provider } from "./core/types.js";
import { invocationOf, withRemembered, describeInvocation, restoredPermissions, positiveFlag, handsLabel, type Invocation } from "./config/invocation.js";

/** `positiveFlag`, reported the way the CLI reports every other usage error. */
function budget(v: string | boolean | undefined, name: string): number | undefined {
  try {
    return positiveFlag(v, name);
  } catch (err) {
    fail((err as Error).message);
  }
}

const VERSION = "0.4.3";

// ── tiny zero-dep arg + color helpers ────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const cyan = c("36"), dim = c("2"), green = c("32"), red = c("31"), bold = c("1"), yellow = c("33"), mag = c("35");

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function fail(msg: string): never {
  process.stderr.write(`\noh-my-fable: ${msg}\n\n`);
  process.exit(2);
}

/** Stored timestamps are ISO/UTC — show them on the reader's own clock. */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── live event renderer ──────────────────────────────────────────────────────
function renderer(): (e: RunEvent) => void {
  return (e) => {
    switch (e.type) {
      case "plan_created":
        process.stdout.write(`  ${cyan("📋 plan")}  ${e.plan.steps.map((s) => s.intent).join(dim(" → "))}\n`);
        break;
      case "step_start":
        process.stdout.write(`  ${bold("▶")}  ${e.step.intent}\n`);
        break;
      case "step_done":
        process.stdout.write(`     ${dim("→ " + e.observation.output.replace(/\s+/g, " ").slice(0, 100))}\n`);
        break;
      case "reflection": {
        const col = e.reflection.progress === "goal_met" ? green : e.reflection.progress === "blocked" ? red : e.reflection.progress === "needs_replan" ? yellow : dim;
        process.stdout.write(`     ${col("⟲ " + e.reflection.progress)}\n`);
        break;
      }
      case "replan":
        process.stdout.write(`  ${yellow("🔁 replan")} ${dim("rev " + e.revision)}\n`);
        break;
      case "exit_check": {
        const met = e.reflection.progress === "goal_met";
        process.stdout.write(`  ${met ? green("🔎 exit check — criteria met") : yellow("🔎 exit check — not done yet")}${e.reflection.notes ? dim(" — " + e.reflection.notes) : ""}\n`);
        break;
      }
      case "compaction":
        process.stdout.write(`  ${dim("🗜  compacted " + e.foldedMessages + " messages")}\n`);
        break;
      case "done":
        process.stdout.write(`  ${green("✅ done")} ${dim("— " + e.reason)}\n`);
        break;
      case "halted":
        process.stdout.write(`  ${red("⛔ halted")} ${dim("— " + e.reason)}\n`);
        break;
      default:
        break;
    }
  };
}

function makeProvider(flags: Args["flags"]): Provider {
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const model = str("model");
  const provider = str("provider");
  const baseUrl = str("base-url");
  const apiKey = str("api-key");
  const permissionMode = str("permission-mode");
  const allowList = typeof flags["allow"] === "string" ? (flags["allow"] as string).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const cliTools = flags["cli-tools"] === true;
  const toolsOpt = allowList ?? (cliTools ? true : undefined);
  try {
    if (provider === "claude" || provider === "claude-code") {
      return claudeCode({ model, tools: toolsOpt, permissionMode, continueSession: flags["continue-session"] === true });
    }
    if (provider === "codex") {
      // `codex exec` has no per-tool allowlist — only a sandbox and an approval
      // policy. Treating --allow as "tools on" turned a request to NARROW access
      // into workspace-write with approvals never, which is the opposite of what
      // the operator typed. Say it is unsupported rather than widening silently.
      if (allowList) fail("--allow is a claude-only flag; codex has no per-tool allowlist.\n  For codex tool access use --cli-tools (workspace-write, approvals off).");
      return codexCli({ model, tools: cliTools });
    }
    if (provider === "ollama") return ollama(model ?? "llama3.1", baseUrl ? { baseUrl } : {});
    if (provider === "openai") {
      return new OpenAICompatProvider({ baseUrl: baseUrl ?? "https://api.openai.com/v1", apiKey: apiKey ?? process.env["OPENAI_API_KEY"], model: model ?? "gpt-4o-mini", label: "openai" });
    }
    if (baseUrl) {
      if (!model) fail("--base-url needs --model too.");
      return new OpenAICompatProvider({ baseUrl, apiKey: apiKey ?? process.env["OPENAI_API_KEY"], model });
    }
    return new AnthropicProvider({ model });
  } catch (err) {
    fail(
      (err as Error).message +
        "\n\nNo API key needed — pick one:" +
        "\n  --provider claude                    (your Claude Code login)" +
        "\n  --provider ollama --model llama3.1   (a local model)" +
        "\nOr just watch the mechanics:  oh-my-fable demo",
    );
  }
}

/**
 * A run halted on a budget is already past that ceiling, so a bare `resume`
 * halts again immediately. Name the flag that lifts the one it actually hit.
 */
function resumeHint(runId: string, reason?: string): string {
  const base = `oh-my-fable resume ${runId}`;
  if (!reason) return base;
  if (reason.includes("wall-clock")) return `${base} --max-minutes 120`;
  if (reason.includes("token budget")) return `${base} --max-tokens 20000000`;
  if (reason.includes("step budget")) return `${base} --max-steps 50`;
  return base;
}

/** Where checkpoints live — `--runs-dir`, or `runs/` beside the caller. */
function runsDirOf(flags: Args["flags"]): string {
  return typeof flags["runs-dir"] === "string" ? (flags["runs-dir"] as string) : "runs";
}

function commonConfig(flags: Args["flags"], provider: Provider): RunConfig {
  const tools = flags["tools"] === "fs" ? fsTools() : [];
  return {
    provider,
    store: new FileStore(runsDirOf(flags)),
    tools,
    onEvent: flags["quiet"] ? undefined : renderer(),
    maxSteps: budget(flags["max-steps"], "max-steps"),
    maxTokens: budget(flags["max-tokens"], "max-tokens"),
    maxWallClockMs: budget(flags["max-minutes"], "max-minutes") ? budget(flags["max-minutes"], "max-minutes")! * 60_000 : undefined,
  };
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdRun(args: Args): Promise<void> {
  const description = args._.join(" ").trim();
  if (!description) fail('Give a goal: oh-my-fable run "research X and write a summary to out.md"');
  const goal: Goal = {
    description,
    successCriteria: typeof args.flags["success"] === "string" ? (args.flags["success"] as string).split(";").map((s) => s.trim()) : undefined,
  };
  const provider = makeProvider(args.flags);
  const config = commonConfig(args.flags, provider);
  const ctx = createContext(goal, resolveSerializable(config));
  ctx.meta["cli"] = invocationOf(args.flags); // so `resume` can rebuild this same agent
  const runsDir = runsDirOf(args.flags);
  const freshDir = !existsSync(runsDir); // the store creates it (self-ignoring) on the first checkpoint
  process.stdout.write(`\n  ${dim("run")} ${mag(ctx.runId)}  ${dim(handsLabel(args.flags))}\n`);
  if (freshDir) process.stdout.write(`  ${dim(`checkpoints → ${runsDir}/  (created here, and git-ignored)`)}\n`);
  process.stdout.write("\n");
  try {
    const result = await runWith(ctx, config);
    const how = resumeHint(ctx.runId, result.reason);
    process.stdout.write(`\n  ${bold(result.status === "done" ? green("finished") : yellow(result.status))}  ${dim(`· ${result.ctx.budget.steps} steps · resume with:`)} ${cyan(how)}\n\n`);
    process.exit(result.status === "done" ? 0 : 1);
  } catch (err) {
    // Only point at `resume` if there is actually something to resume from: a
    // run that died before its first checkpoint (bad flag, missing CLI, no key)
    // has nothing on disk, and sending the user there is a dead end.
    const checkpointed = config.store ? await config.store.load(ctx.runId).catch(() => null) : null;
    const next = checkpointed
      ? `\n  ${dim("resume from the last checkpoint:")} ${cyan(`oh-my-fable resume ${ctx.runId}`)}`
      : `\n  ${dim("nothing was checkpointed yet — fix the above and run it again.")}`;
    process.stdout.write(`\n  ${red("crashed")} ${dim("— " + (err as Error).message)}${next}\n\n`);
    process.exit(1);
  }
}

async function cmdResume(args: Args): Promise<void> {
  const runId = args._[0];
  if (!runId) fail("Give a run id: oh-my-fable resume <runId>   (see `oh-my-fable list`)");
  const store = new FileStore(runsDirOf(args.flags));
  const ctx = await store.load(runId);
  if (!ctx) fail(`No saved run found for "${runId}".   (see \`oh-my-fable list\`)`);
  // Resume as the SAME agent: the provider and tools the run started with are
  // read back from the checkpoint. Flags typed now override them.
  const granted = restoredPermissions(ctx, args.flags);
  const flags = withRemembered(ctx, args.flags);
  const provider = makeProvider(flags);
  ctx.meta["cli"] = invocationOf(flags); // remember any override for the next resume
  const as = describeInvocation(ctx.meta["cli"] as Invocation);
  process.stdout.write(`\n  ${dim("resuming")} ${mag(runId)}${as ? dim(`  (${as})`) : ""}\n`);
  // Tool access restored from a file on disk, not from this command line: say so.
  if (granted.length) {
    process.stdout.write(
      `  ${yellow("!")} ${dim(`tool access (${granted.map((g) => "--" + g).join(", ")}) came from the checkpoint, not this command`)}\n` +
        `    ${dim(`re-run with the flags you want to pin them, or inspect ${runsDirOf(args.flags)}/${runId}.json`)}\n`,
    );
  }
  process.stdout.write("\n");
  const result = await runWith(ctx, { ...commonConfig(flags, provider), store });
  process.stdout.write(`\n  ${bold(result.status === "done" ? green("finished") : yellow(result.status))}\n\n`);
  process.exit(result.status === "done" ? 0 : 1);
}

async function cmdList(args: Args): Promise<void> {
  const store = new FileStore(runsDirOf(args.flags));
  const runs = await store.list();
  if (runs.length === 0) {
    process.stdout.write(`\n  no saved runs in ${runsDirOf(args.flags)}/.\n\n`);
    return;
  }
  process.stdout.write("\n");
  for (const r of runs) {
    const st = r.planStatus === "done" ? green("done ") : r.planStatus === "failed" ? red("failed") : yellow("active");
    process.stdout.write(`  ${st}  ${mag(r.runId)}  ${dim(localTime(r.updatedAt))}  ${r.goal.slice(0, 60)}\n`);
  }
  process.stdout.write("\n");
}

async function cmdShow(args: Args): Promise<void> {
  const runId = args._[0];
  if (!runId) fail("Give a run id: oh-my-fable show <runId>   (see `oh-my-fable list`)");
  const store = new FileStore(runsDirOf(args.flags));
  const ctx = await store.load(runId);
  if (!ctx) fail(`no run ${runId} — try \`oh-my-fable list\``);

  const icon: Record<string, string> = { done: green("✔"), failed: red("✗"), running: yellow("▶"), skipped: dim("–"), pending: dim("·") };
  const p = ctx.plan;
  const planColor = p.status === "done" ? green : p.status === "failed" ? red : yellow;
  process.stdout.write(`\n  ${dim("── run")} ${mag(ctx.runId)} ${dim("──")}\n`);
  process.stdout.write(`  ${bold("goal")}  ${ctx.goal.description}\n`);
  if (ctx.goal.successCriteria?.length) process.stdout.write(`  ${dim("done when")}  ${dim(ctx.goal.successCriteria.join("; "))}\n`);
  process.stdout.write(`  ${bold("plan")}  ${planColor(p.status)} ${dim(`· rev ${p.revision} · ${p.steps.length} steps`)}\n\n`);

  for (const s of p.steps) {
    process.stdout.write(`  ${icon[s.status] ?? "·"} ${s.intent}${s.attempts > 1 ? dim(`  ×${s.attempts}`) : ""}\n`);
    if (s.result) process.stdout.write(`     ${dim("↳ " + s.result.replace(/\s+/g, " ").slice(0, 120))}\n`);
  }

  const b = ctx.budget;
  const mins = Math.max(0, Math.round((Date.parse(ctx.updatedAt) - Date.parse(ctx.createdAt)) / 60000));
  process.stdout.write(`\n  ${dim(`budget: ${b.steps} steps · ${b.tokens.toLocaleString()} tokens · ${b.replans} replans · ~${mins}m`)}\n`);
  if (ctx.digests.length) process.stdout.write(`  ${dim(`compacted: ${ctx.digests.length} digest${ctx.digests.length === 1 ? "" : "s"}`)}\n`);
  if (p.status !== "done") process.stdout.write(`  ${dim("resume:")} ${cyan(`oh-my-fable resume ${ctx.runId}`)}\n`);
  process.stdout.write("\n");
}

async function cmdDemo(): Promise<void> {
  // The crash → resume story, scripted (no API key).
  const { MemoryStore } = await import("./memory/store.js");
  const store = new MemoryStore();
  const goal: Goal = { description: "Publish a short blog post", successCriteria: ["an edited post exists"] };
  const ctx = createContext(goal, resolveSerializable({}));
  const onEvent = renderer();

  class CrashAt implements Provider {
    name = "crash";
    private inner: ScriptedProvider;
    private n = 0;
    constructor(r: ConstructorParameters<typeof ScriptedProvider>[0], private at: number) {
      this.inner = new ScriptedProvider(r);
    }
    async complete(req: Parameters<Provider["complete"]>[0]) {
      if (++this.n === this.at) throw new Error("the process just died");
      return this.inner.complete(req);
    }
    estimateTokens(m: Parameters<Provider["estimateTokens"]>[0]) {
      return this.inner.estimateTokens(m);
    }
  }

  process.stdout.write(`\n  ${dim("(scripted — no API key. shows the one thing most frameworks can't: surviving a crash.)")}\n\n`);
  const crashing = new CrashAt(
    [
      reply.plan([{ id: "s1", intent: "Write an outline" }, { id: "s2", intent: "Write the draft", dependsOn: ["s1"] }, { id: "s3", intent: "Edit and finalize", dependsOn: ["s2"] }]),
      reply.text("outline: intro, body, conclusion"),
      reply.reflection("on_track"),
      reply.text("draft written"),
    ],
    5,
  );
  try {
    await runWith(ctx, { provider: crashing, store, onEvent });
  } catch (e) {
    process.stdout.write(`  ${red("💥 " + (e as Error).message)}\n`);
  }
  process.stdout.write(`\n  ${dim("── resuming from the last checkpoint ──")}\n\n`);
  const finishing = new ScriptedProvider([
    reply.text("draft written (again)"),
    reply.reflection("on_track"),
    reply.text("edited: tightened intro"),
    reply.reflection("goal_met", "post is written and edited"),
  ]);
  const result = await resume(ctx.runId, { provider: finishing, store, onEvent });
  process.stdout.write(`\n  ${green("finished")} ${dim("— every step done, nothing lost.")}\n\n`);
  process.exit(result.status === "done" ? 0 : 1);
}

function help(): void {
  process.stdout.write(`
${bold("oh-my-fable")} ${dim("v" + VERSION)} — give an agent a goal; it plans, self-corrects, and survives crashes.

${bold("Usage")}
  oh-my-fable run "<goal>"        run an agent on a goal
  oh-my-fable resume <runId>      continue a crashed/halted run from its checkpoint
  oh-my-fable show <runId>        print a run's plan, steps, and budget as a timeline
  oh-my-fable list                list saved runs
  oh-my-fable demo                watch crash → resume, scripted (no API key)

${bold("Model")} ${dim("— no API key needed; ride a CLI login you already have")}
  --provider claude                         drive your Claude Code login — NO separate API key
  --provider claude --cli-tools             …and let Claude edit files / run tools itself (durable agent on your sub)
  --provider codex  --cli-tools             drive your Codex login, workspace-write
  --provider ollama --model llama3.1        a LOCAL model — no API key, no cost
  --provider openai --model gpt-4o-mini     OpenAI (OPENAI_API_KEY)
  --base-url <url> --model <id> [--api-key] any OpenAI-compatible server (LM Studio, OpenRouter, Groq, …)
  ${dim("(default: Anthropic API, needs ANTHROPIC_API_KEY)")}

${bold("Options for run")}
  --model <id>          model/alias for the chosen provider (e.g. opus, sonnet, llama3.1)
  --cli-tools           let a CLI provider run its own tools (claude/codex); pairs with --permission-mode
  --permission-mode <m> claude: acceptEdits (default) | dontAsk | plan
  --allow "Read,Edit"   claude: exact tool allowlist instead of the file-only default
  --continue-session    claude: keep the CLI's session between steps, so it stops
                        re-reading the whole workspace every time
  --success "a; b"      success criteria (semicolon-separated)
  --tools fs            give the harness sandboxed read_file/write_file/list_dir (API providers)
  --max-steps <n>       step budget          --max-tokens <n>   token budget
  --max-minutes <n>     active runtime budget (default 30; a --cli-tools step
                        takes minutes, so raise this for agentic CLI runs)
  --runs-dir <dir>      where checkpoints live (default: runs/)
  --quiet               no live event stream

${bold("Examples")}
  oh-my-fable run "refactor utils.ts and run the tests" --provider claude --cli-tools   ${dim("# no API key")}
  oh-my-fable run "outline a talk on durable agents" --provider ollama --model llama3.1
  oh-my-fable show run_abc123                                          ${dim("# inspect any saved run")}
  oh-my-fable demo                                                    ${dim("# no key at all")}

${dim("It's also a library: import { run, AnthropicProvider } from \"oh-my-fable\".")}
`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return help();
  if (cmd === "--version" || cmd === "-v") return void process.stdout.write(VERSION + "\n");
  switch (cmd) {
    case "run":
      return cmdRun(args);
    case "resume":
      return cmdResume(args);
    case "list":
      return cmdList(args);
    case "show":
      return cmdShow(args);
    case "demo":
      return cmdDemo();
    default:
      // treat `oh-my-fable "<goal>"` as run
      return cmdRun(parseArgs(process.argv.slice(2)));
  }
}

main().catch((err) => fail((err as Error).message));

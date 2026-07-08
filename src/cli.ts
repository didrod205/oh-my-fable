#!/usr/bin/env node
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

const VERSION = "0.4.0";

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
    if (provider === "claude" || provider === "claude-code") return claudeCode({ model, tools: toolsOpt, permissionMode });
    if (provider === "codex") return codexCli({ model, tools: cliTools || !!allowList });
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

function commonConfig(flags: Args["flags"], provider: Provider): RunConfig {
  const tools = flags["tools"] === "fs" ? fsTools() : [];
  return {
    provider,
    store: new FileStore(typeof flags["runs-dir"] === "string" ? (flags["runs-dir"] as string) : "runs"),
    tools,
    onEvent: flags["quiet"] ? undefined : renderer(),
    maxSteps: flags["max-steps"] ? Number(flags["max-steps"]) : undefined,
    maxTokens: flags["max-tokens"] ? Number(flags["max-tokens"]) : undefined,
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
  process.stdout.write(`\n  ${dim("run")} ${mag(ctx.runId)}  ${dim(args.flags["tools"] === "fs" ? "(fs tools on)" : "(no tools — pure reasoning)")}\n\n`);
  try {
    const result = await runWith(ctx, config);
    process.stdout.write(`\n  ${bold(result.status === "done" ? green("finished") : yellow(result.status))}  ${dim(`· ${result.ctx.budget.steps} steps · resume with:`)} ${cyan(`oh-my-fable resume ${ctx.runId}`)}\n\n`);
    process.exit(result.status === "done" ? 0 : 1);
  } catch (err) {
    process.stdout.write(`\n  ${red("crashed")} ${dim("— " + (err as Error).message)}\n  ${dim("resume from the last checkpoint:")} ${cyan(`oh-my-fable resume ${ctx.runId}`)}\n\n`);
    process.exit(1);
  }
}

async function cmdResume(args: Args): Promise<void> {
  const runId = args._[0];
  if (!runId) fail("Give a run id: oh-my-fable resume <runId>   (see `oh-my-fable list`)");
  const provider = makeProvider(args.flags);
  process.stdout.write(`\n  ${dim("resuming")} ${mag(runId)}\n\n`);
  const result = await resume(runId, commonConfig(args.flags, provider));
  process.stdout.write(`\n  ${bold(result.status === "done" ? green("finished") : yellow(result.status))}\n\n`);
  process.exit(result.status === "done" ? 0 : 1);
}

async function cmdList(args: Args): Promise<void> {
  const store = new FileStore(typeof args.flags["runs-dir"] === "string" ? (args.flags["runs-dir"] as string) : "runs");
  const runs = await store.list();
  if (runs.length === 0) {
    process.stdout.write("\n  no saved runs.\n\n");
    return;
  }
  process.stdout.write("\n");
  for (const r of runs) {
    const st = r.planStatus === "done" ? green("done ") : r.planStatus === "failed" ? red("failed") : yellow("active");
    process.stdout.write(`  ${st}  ${mag(r.runId)}  ${dim(r.updatedAt.slice(0, 16).replace("T", " "))}  ${r.goal.slice(0, 60)}\n`);
  }
  process.stdout.write("\n");
}

async function cmdShow(args: Args): Promise<void> {
  const runId = args._[0];
  if (!runId) fail("Give a run id: oh-my-fable show <runId>   (see `oh-my-fable list`)");
  const store = new FileStore(typeof args.flags["runs-dir"] === "string" ? (args.flags["runs-dir"] as string) : "runs");
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
  --success "a; b"      success criteria (semicolon-separated)
  --tools fs            give the harness sandboxed read_file/write_file/list_dir (API providers)
  --max-steps <n>       step budget          --max-tokens <n>   token budget
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

<div align="center">

# oh-my-fable

### Fable 5's way of working a long task — plan first, self-correct every step, never lose the thread — as a model-agnostic agent harness.

<sub>The <i>fable</i> is <b>Fable 5</b>'s way of thinking; the <code>oh-my-</code> is because, like <code>oh-my-zsh</code>, you just want the good defaults. The mindset is the model's — the engine is any provider.</sub>

[![npm version](https://img.shields.io/npm/v/oh-my-fable.svg?color=success)](https://www.npmjs.com/package/oh-my-fable)
[![CI](https://github.com/didrod205/oh-my-fable/actions/workflows/ci.yml/badge.svg)](https://github.com/didrod205/oh-my-fable/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/oh-my-fable.svg)](https://www.npmjs.com/package/oh-my-fable)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/oh-my-fable?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/oh-my-fable.svg)](./LICENSE)

```bash
npm i oh-my-fable
```

</div>

The demos are magical. Then you point an agent at a *real* multi-hour task and it
loops on the same step, loses the plan somewhere in a 40-message chat history, and
— when your process restarts — forgets everything and starts over.

**oh-my-fable** encodes the way a strong reasoning model works a long task — the
*mindset*, not the model — into a harness: plan first, self-correct every step,
keep the thread, and finish. It's built around two mechanisms and one rule:

> The whole run lives in a single **`RunContext`** — the only source of truth, and
> always serializable. It's checkpointed after **every** step.

From that one rule you get the thing nobody else gives you: **a crash is a pause.**

<sub>The name is about the *thinking*, not a model lock-in — the mindset is Fable 5's, the
engine is whatever `Provider` you hand it (Anthropic, OpenAI-compatible, local, …).</sub>

```
── run run_mqf… ──
  📋 planned 3 steps: outline → draft → edit
  ▶  outline
     → outlined
     💾 checkpoint saved
  ▶  draft
  💥 the process just died (power outage, OOM, deploy, whatever)

── resuming from the last checkpoint ──
  ▶  draft                ← picks up exactly where it died
     💾 checkpoint saved
  ▶  edit
  ✅ done

  steps: outline [done], draft [done], edit [done]
```

```ts
const result = await run(goal, { provider, store });   // crashes at step 2
// ...process restarts...
await resume(result.runId, { provider, store });        // finishes from step 2
```

That's `examples/scripted-run.mjs` — run it with `npm run example`, no API key needed.

## The three things it does that most frameworks don't

### 1. It survives crashes (resumable by construction)

State doesn't live in memory or in a chat transcript — it lives in `RunContext`,
saved to disk after every step. Kill the process at step 47 of 60 and `resume()`
continues from step 47, plan and progress intact. Swap the `FileStore` for
SQLite/Redis by implementing one interface.

### 2. It plans first, then self-corrects (plan ≠ history)

The **plan** is structured data that lives *outside* the conversation, so the model
never loses track of "where am I" in a wall of text. After every step a **reflector**
checks the result against the goal and routes:

| verdict | meaning | what happens |
| --- | --- | --- |
| `on_track` | normal progress | next step |
| `needs_replan` | the result changed the plan's assumptions | replan |
| `blocked` | same obstacle keeps recurring | replan around it / escalate |
| `goal_met` | success criteria satisfied | stop (even with steps left — no busywork) |

And it works in both directions: stopping early when the goal is met, **and
refusing to stop when it isn't** — when the plan runs out of steps but the
goal has `successCriteria`, a final **exit check** verifies them against the
recorded evidence and sends the run back to work if something is missing.
Plan exhaustion and goal completion are different events.

Replanning **accumulates**: finished steps are preserved verbatim; only the
remaining work is regenerated. Long tasks move forward instead of restarting.

### 3. It's deterministically testable (genuinely rare for an agent framework)

Because every model call is stateless, you can script the model and assert the
loop's behavior — no network, no flakiness:

```ts
import { run, ScriptedProvider, reply, MemoryStore } from "oh-my-fable";

const provider = new ScriptedProvider([
  reply.plan([{ id: "s1", intent: "do the thing" }]),
  reply.text("did it"),
  reply.reflection("goal_met"),
]);

const { status } = await run("do the thing", { provider, store: new MemoryStore() });
expect(status).toBe("done"); // fully deterministic
```

The whole harness is tested this way — crash-recovery, replan-accumulation,
budget halts, the tool loop — all without a single API call.

## Quick start

```ts
import { run, AnthropicProvider } from "oh-my-fable";

const result = await run(
  {
    description: "Research the top 3 Rust web frameworks and write a comparison table",
    successCriteria: ["a markdown table comparing 3 frameworks exists"],
    constraints: ["only use information you can verify"],
  },
  { provider: new AnthropicProvider() }, // reads ANTHROPIC_API_KEY
);

console.log(result.status); // "done" | "halted" | "failed"
console.log(result.ctx.plan.steps);
```

```bash
npm i oh-my-fable        # zero runtime dependencies
```

Node ≥ 18. Ships with `AnthropicProvider` and `OpenAICompatProvider` (works with
OpenAI, Ollama, LM Studio, OpenRouter, Groq… — `ollama("llama3.1")` for a local
model with no key), both over `fetch`, no SDK. Or bring any model by implementing
the `Provider` interface (three methods).

`AnthropicProvider` defaults to `claude-sonnet-5` and works with every current
flagship model (`claude-opus-4-8`, `claude-fable-5`) out of the box — it drops
the `temperature` parameter they reject, routes safety refusals to the
reflector instead of recording them as success, and on Fable-tier models opts
into the **server-side refusal fallback** (a classifier false-positive is
re-served by `claude-opus-4-8` instead of failing the step). It
**prompt-caches both the system+tools prefix and the replayed history** by
default, so a long durable run re-reads its context at ~0.1× instead of full
price every step. Opt into `{ thinking: "adaptive", effort: "high" }` for
harder planning. The `claude` provider can return real `--output-format json`
cost/usage and run Claude's own tools
(`{ tools: true, permissionMode: "acceptEdits" }`).

## Or use it from the terminal

Don't want to write code? It ships a CLI (zero extra deps):

```bash
npx oh-my-fable demo                       # watch crash → resume, no API key

# ⭐ already pay for Claude Code? drive it as a DURABLE, TOOL-USING agent — your
#    login, no separate API key, $0 per token. Claude edits files & runs commands:
npx oh-my-fable run "refactor utils.ts and run the tests" --provider claude --cli-tools

# pure-reasoning over the same login (no tools):
npx oh-my-fable run "outline a talk on durable agents" --provider claude

# or a LOCAL model (Ollama / LM Studio), also no key:
npx oh-my-fable run "outline a talk on durable agents" --provider ollama --model llama3.1

# or any hosted model:
export ANTHROPIC_API_KEY=sk-...
npx oh-my-fable run "summarize README.md into SUMMARY.md" --tools fs

npx oh-my-fable list                       # your saved runs
npx oh-my-fable show  run_abc123           # the run's plan, steps & budget as a timeline
npx oh-my-fable resume run_abc123          # continue one from its checkpoint
```

**You don't need an Anthropic API key.** Pick how it talks to a model:

| `--provider` | uses | key? | tools? |
| --- | --- | --- | --- |
| `claude` | your Claude Code login | **none** | `--cli-tools` → Claude runs Read/Write/Edit/Bash itself |
| `codex` | your Codex CLI login | **none** | `--cli-tools` → workspace-write |
| `ollama` | a local Ollama model | **none** | `--tools fs` (harness-run) |
| `--base-url <url>` | LM Studio / OpenRouter / Groq / any OpenAI-compatible | per that server | `--tools fs` |
| `openai` | OpenAI | `OPENAI_API_KEY` | `--tools fs` |
| *(default)* | Anthropic | `ANTHROPIC_API_KEY` | `--tools fs` |

**Two ways to give an agent hands:**

- `--cli-tools` (claude/codex) — the CLI runs its **own** tools (file edits, shell)
  on your subscription. oh-my-fable stays the durable planner/reflector around it:
  it plans, checkpoints every step, and reflects — Claude does the work. Tune with
  `--permission-mode acceptEdits|dontAsk|plan` and `--allow "Read,Edit,Bash(npm test)"`.
- `--tools fs` (API providers) — the harness gives the agent a sandboxed
  `read_file`/`write_file`/`list_dir`, confined to the working directory.

You watch the plan form and each step get reflected on, live. Every run is
checkpointed, so `resume <runId>` always works — and `show <runId>` prints the
whole run (plan, steps, budget) from its serialized `RunContext`.

## Tools

```ts
import { run, defineTool, AnthropicProvider } from "oh-my-fable";

const search = defineTool(
  "web_search",
  "Search the web and return results.",
  { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async ({ query }) => ({ ok: true, output: await fetchResults(query) }),
  { readOnly: true }, // inspection-only tools may also be used by the exit check
);

await run(goal, { provider: new AnthropicProvider(), tools: [search] });
```

A tool that throws becomes an `Observation`, not a crash — the reflector decides
what to do about it. Tool calls travel in each provider's **native wire format**
(Anthropic `tool_use`/`tool_result` blocks, OpenAI `tool_calls`/`role: "tool"`),
with text flattening as the fallback.

Tools marked `{ readOnly: true }` (the fs toolset marks `read_file`/`list_dir`)
are also handed to the **exit-check verifier**, so before declaring the goal met
it can open the actual files the success criteria talk about — evidence over
log. Write tools are structurally withheld from it.

## Watch it work

```ts
await run(goal, {
  provider,
  onEvent: (e) => console.log(e.type, e),
  // plan_created · step_start · step_done · reflection · replan · compaction · checkpoint · exit_check · done · halted
});
```

## It can't run away

Three hard ceilings, checked at the top of every loop turn, plus two recovery
caps — exceed any and it halts cleanly, preserving all work:

```ts
await run(goal, {
  provider,
  maxSteps: 50,            // total step budget
  maxTokens: 2_000_000,    // cumulative token budget — EVERY model call counts (planning, reflection, compaction, repair)
  maxWallClockMs: 1_800_000, // ACTIVE runtime only — downtime between crash and resume never counts
  maxStepAttempts: 3,      // a single step retried this many times → blocked
  maxReplans: 12,          // replan storm → halted
});
```

## How it's built

A `planner ↔ executor ↔ reflector` loop over a serializable `RunContext`:

```
plan → [ budget? → next step → compact? → execute → reflect → checkpoint → route ] → exit check → done
```

- **planner** — goal → ordered steps, grounded in the tools the executor
  actually has; `replan` accumulates instead of resetting.
- **executor** — runs one step, including a provider-agnostic tool mini-loop.
- **reflector** — heuristics first (cheap, certain), then the model, with
  schema-enforced JSON where the model supports it (self-repair as the
  fallback) and a conservative default (a wrong early exit is worse than one
  more loop). When the plan runs out of steps, it runs the final **exit check**
  against the success criteria — with read-only tools, it inspects the actual
  artifacts. Plan exhaustion is not goal completion.
- **contextManager** — folds old turns into digests so long runs stay inside the
  window; the plan is never compacted.
- **store / budget** — checkpoint after every step; guard against runaways.

Every piece is an interface you can replace without touching the core. The full
architecture writeup is in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Roadmap

- A web dashboard that tails a run's events and lets you resume from any checkpoint (`show <runId>` is the CLI version of this today).
- More providers in-repo (OpenAI-compatible, local) — though it's a 3-method interface.
- Parallel step execution for independent branches of the plan DAG.
- Human-in-the-loop: pause for approval as a first-class step status.

## 💖 Sponsor

Free, MIT, zero-dependency, built in spare time. If it saved your agent from
starting over:

- ⭐ **Star the repo** — it's how the next person building an agent finds it.
- 🍋 **[Sponsor via Lemon Squeezy](https://elab-studio.lemonsqueezy.com/checkout/buy/5d059b89-51d0-456b-b33a-ed56994f7010)** — one-time or recurring.

## License

[MIT](./LICENSE) © oh-my-fable contributors

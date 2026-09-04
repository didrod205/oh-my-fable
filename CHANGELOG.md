# Changelog

All notable changes to oh-my-fable are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4] — 2026-09-05

Found by driving a real build through `--provider claude --cli-tools` — an agent
writing a web service from scratch, 19 steps over an hour. Two of these stopped
that build dead.

### Fixed

- **The wall-clock ceiling had no flag.** `--max-steps` and `--max-tokens` were
  settable; the 30-minute default was not. An agentic CLI step takes minutes, so
  anyone using `--cli-tools` hits it — the build halted at 8 of 19 steps and the
  only way past was editing the checkpoint by hand. Added `--max-minutes`.
- **A run halted on a budget could not be resumed.** `resume` honored the run's
  persisted budgets, and a halted run is already past one of them, so it halted
  again the instant it resumed — while the halt message told you to resume.
  Budgets the caller names now replace the persisted ones; unnamed ones are left
  alone, so a run's own limits still stand by default.
- **The halt message names the flag that lifts the ceiling it hit**, instead of
  pointing at a bare `resume` that cannot work:
  `resume with: oh-my-fable resume run_x --max-steps 50`

### Added

- **`continueSession` for `CliProvider`.** The CLI reports a session id; the
  harness captured it and threw it away, so every step was a cold start that
  re-read the whole workspace. It can now carry that session between *work*
  calls — planning and reflection deliberately stay out of it, since a reflector
  that remembers doing the work is not a check on it. A session the CLI no
  longer knows about falls back to a cold start rather than stranding the run.

  **Off by default, and measured:** turning it on partway through that same
  build cost 86% more tokens per step over the next four steps (931k → 1.73M)
  and ran slower, because resuming re-sends a transcript that grows faster than
  the cache saves. It may pay off on a session kept small from the first step;
  that case is untested.

## [0.4.3] — 2026-09-04

### Fixed

Findings from an autonomous audit of this repository, each verified against the
code before being acted on.

- **A step cut off by the tool-hop limit is no longer filed as a success.**
  Leaving the loop still asking for tools keeps `stopReason` at `"tool_use"`,
  which passes the ok test — and a tool-calling turn carries no text, so the
  step was recorded as a clean success that "produced no text output". The
  reflector now sees that the work is unfinished.
- **The `--tools fs` sandbox is actually confined to its root.** The check was
  lexical, so a symlink inside the root pointing anywhere else passed it and the
  read followed it straight out. Symlinks are now resolved — for writes too, via
  the nearest existing parent.
- **`read_file` says when it truncated.** It cut at 100k characters silently, so
  the agent reasoned about a partial file as if it had seen all of it.
- **HTTP provider calls have a deadline.** Neither provider passed a signal to
  `fetch`, so a stalled connection hung the run forever: no step finished, so no
  budget was ever consumed to stop it. Both default to 300s, configurable.
- **An error returned in a 200 body is no longer a successful empty step.** The
  OpenAI-compatible provider declared the `error` field and never read it; some
  gateways report failure that way, leaving empty `choices` and blank content.
- **Token estimates count tool payloads.** Only `content` was measured, so a
  tool-using run — the case the harness exists for — under-reported by most of
  its size and compaction never triggered.
- **An agentic CLI step gets 10 minutes, not 2.** The default SIGKILLed Claude
  mid-file-read and reported a timeout for a step that was progressing.
- Writing to a child's stdin can no longer take the harness down with an
  unhandled EPIPE when that child has already exited.

## [0.4.2] — 2026-09-04

### Fixed

- **The harness's tools now reach an agentic CLI.** `CliProvider` never looked
  at `req.tools`, so `run(goal, { provider: claudeCode(), tools: [...] })` ran
  to completion having called nothing — the model was never told the tools
  existed, invented a workaround, and the run reported `done` with no work done.
  The README's Tools section shows exactly that call shape. Tools now travel in
  the prompt and come back as real `ToolCall`s, driven by the existing tool loop.
- **A truncated answer no longer throws away the calls that were complete.** A
  step capped by `maxStepTokens` can be cut mid-object, which left the whole
  block unparseable; every intact call went out with it. Complete objects are
  now salvaged, and prose that merely mentions a tool is still not read as a call.
- **`--provider claude` finds the desktop app's binary.** Claude Code installed
  as the desktop app never puts `claude` on PATH, so people paying for it were
  told it was "not installed". Resolution is now explicit → `OMF_CLAUDE_BIN` →
  `CLAUDE_CODE_EXECPATH` → `claude`, and the error says how to fix it.
- **A non-numeric budget flag stops the run instead of removing the ceiling.**
  `--max-steps abc` became `NaN`, every `used >= NaN` is false, and the runaway
  guard silently stopped existing.
- **`--allow` no longer widens access on codex.** `codex exec` has no per-tool
  allowlist, and the flag was mapped to "tools on" — a restrictive list became
  `--sandbox workspace-write --ask-for-approval never`. It is now refused there.
- **`resume` says when tool access came from the checkpoint** rather than from
  the command line, since that file decides what a later resume spawns.
- **The run header no longer calls a `--cli-tools` run "pure reasoning"** while
  the CLI edits files on its own permissions.

## [0.4.1] — 2026-09-04

### Fixed

- **`resume <runId>` now comes back as the same agent.** The provider and
  toolset a run started with are recorded in its checkpoint (`meta.cli`) and
  restored on resume; flags typed on the resume command still win. Previously a
  bare `resume` — the command the CLI itself prints after a crash — rebuilt the
  *default* Anthropic provider, so any run started with `--provider claude`,
  `--provider ollama` or `--base-url` died on a missing API key. Worse,
  `--tools fs` was dropped in silence: the run continued with no tools at all
  and still reported `done`. `--api-key` is deliberately not recorded — a
  checkpoint is a file on disk, not a secret store. Checkpoints written by
  earlier versions carry no record and behave exactly as before.
- **The crash hint no longer points at a checkpoint that does not exist.** A run
  that dies before its first checkpoint (missing CLI, bad flag, no API key) now
  says so instead of suggesting `oh-my-fable resume <runId>`, which could only
  answer "No saved run found".
- **`list` shows timestamps on your own clock.** It printed the stored ISO
  string, which is UTC, with nothing to say so — a run started at 15:01 local
  was listed as `06:01`.

### Changed

- **The `runs/` directory the store creates now ignores itself.** A checkpoint
  carries the run's whole history, including whatever the tools read out of
  your files; running an agent inside a repo used to leave that sitting in
  `git status`. A directory the store creates gets a `.gitignore` containing
  `*`, and the CLI says where checkpoints went on the run that creates it. A
  directory you made yourself is never touched.

## [0.4.0] — 2026-07-08

### Added

- **Native tool wire formats.** The executor's tool loop now sends structured
  tool messages — `AnthropicProvider` renders real `tool_use` / `tool_result`
  blocks (with `is_error` on failures) and `OpenAICompatProvider` renders
  `tool_calls` + `role: "tool"` messages — instead of flattening everything to
  text. `Message` gains `toolCalls` / `toolResults`; the flattened text remains
  as the fallback for text-only providers.
- **Schema-enforced structured outputs.** `CompletionRequest.responseSchema` +
  new `PLAN_SCHEMA` / `REFLECTION_SCHEMA`: on models that support it,
  `AnthropicProvider` enforces plans and reflections via
  `output_config.format` (guaranteed-valid JSON — the repair round-trip never
  fires), and `claudeCode()` enforces them per-request via `--json-schema`.
  Prompt-instructed JSON + parse-repair remains the fallback everywhere else.
- **The exit-check verifier has hands.** Tools can be marked
  `readOnly` (`defineTool(..., { readOnly: true })`); the fs toolset marks
  `read_file` / `list_dir`. The final goal check can now *inspect the actual
  artifacts* (read the files, list the directories) with a bounded read-only
  tool loop before judging — evidence over log — while write tools are
  structurally withheld from it.

### Fixed

- `npm pkg fix` applied (bin path normalization) — silences the publish warning.

## [0.3.0] — 2026-07-08

The "does it actually think the way it claims to?" release: an outside review of
the harness against the mindset it encodes found two places where the loop's own
principles were only half-implemented, plus real money left on the table. All
fixed, with tests.

### Fixed

- **Plan exhaustion ≠ goal completion — now enforced, not just documented.**
  Previously, running out of steps returned `done` without ever checking the
  success criteria. Now, when the plan is exhausted and the goal has
  `successCriteria`, the reflector runs a final **exit check** against the
  recorded evidence; if the criteria aren't met, the run replans and keeps
  working (bounded by `maxReplans`). New `exit_check` event. Goals without
  criteria behave exactly as before.
- **A blocked plan is no longer a false "done".** If pending steps can never run
  (their dependencies failed or don't exist), the loop used to report
  "all steps complete". It now replans around the stranded steps.
- **A crash is a pause — including for the wall-clock budget.** Downtime between
  a crash and its `resume()` no longer counts against `maxWallClockMs`; the
  budget now measures *active* runtime only (`BudgetState.elapsedMs`, folded at
  every checkpoint). Previously, resuming after an outage longer than the budget
  halted instantly.
- **`AnthropicProvider` no longer sends `temperature` to Claude Sonnet 5**
  (which rejects non-default sampling params — previously HTTP 400), and no
  longer records a safety refusal or a context-window overflow as a successful
  step: `refusal` is a first-class `StopReason` the reflector can route on
  (OpenAI-compat maps `content_filter` the same way).

### Added

- **The replayed history is now actually prompt-cached.** The executor sends
  stable content first (system → append-only history) and volatile content last
  (plan state + current step), and flags the last history message as a cache
  breakpoint via the new `Message.cache` hint — `AnthropicProvider` turns it
  into `cache_control`. Long runs re-read their history at ~0.1× instead of
  full price every step; other providers ignore the hint.
- **Refusal fallback on Fable-tier models by default.** On `claude-fable-5` /
  `claude-mythos-5`, the provider opts into the server-side fallback beta so a
  classifier false-positive is transparently re-served by `claude-opus-4-8`
  instead of failing the step. Override or disable with `fallbackModel`.
- **The planner now knows what the executor can do.** Plan and replan prompts
  list the registered tools (or state that there are none), so plans are
  grounded in real capabilities instead of hypothetical ones.
- **Every model call is budgeted.** Planning, reflection, compaction, and JSON
  repair now count toward `maxTokens` — previously only step execution did, so
  the ceiling under-measured real spend.
- The reflector sees the goal's `constraints`; a `max_tokens`-truncated step
  result is annotated (`[note: … truncated]`) instead of recorded as a clean
  success.

### Changed

- **Default model: `claude-sonnet-4-6` → `claude-sonnet-5`** (current Sonnet
  line; adaptive thinking on by default, near-Opus agentic quality). Default
  `maxTokens` per call 4096 → 8192 and `maxStepTokens` 4096 → 8192, leaving room
  for thinking in the same budget.

## [0.2.0] — 2026-06-22

### Added

- **CLI providers are now first-class, not text-only.** `claudeCode()` /
  `--provider claude` gains:
  - `--output-format json` parsing → **real cost (`costUsd`), token usage, and a
    `session_id`** on the result, instead of a `length / 4` estimate.
  - **Tool execution on your subscription** — `{ tools: true }` / `--cli-tools`
    lets Claude run its own Read/Write/Edit/Bash during a step, with
    `permissionMode` (`acceptEdits` default) and a custom `--allow` allowlist. A
    durable, tool-using agent with **no API key**; oh-my-fable stays the
    planner/reflector around it.
  - `--model` / `model` passthrough, `--append-system-prompt` for clean prompts,
    opt-in `--json-schema` (`jsonSchema`) for validated structured output, and a
    `resumeSessionId` to continue a prior `claude` session.
  - `codexCli()` gains `model`, `--sandbox`, and `--ask-for-approval` (`tools: true`
    → workspace-write, unattended).
  - New exported helpers `parseClaudeJson`, `claudeRequestArgs`,
    `DEFAULT_CLAUDE_TOOLS`; `CompletionResult` gains optional `sessionId` / `costUsd`.
- **`oh-my-fable show <runId>`** — print a saved run's plan, per-step results, and
  budget as a timeline, straight from its serialized `RunContext`.

### Fixed

- **`AnthropicProvider` now works with the flagship models.** It no longer sends
  `temperature` to models that reject it (Opus 4.7/4.8, Fable 5, Mythos 5) — those
  requests previously failed with **HTTP 400**. `temperature` is still sent to
  models that accept it (e.g. Sonnet 4.6).

### Changed

- **`AnthropicProvider` prompt-caches the system + tools prefix by default**
  (`cache_control: ephemeral`), so a long durable run pays ~10× less on the prefix
  it replays every step. `tokensIn` now includes cache-read + cache-write tokens
  (true context size). Disable with `{ cache: false }`.
- Opt-in `{ thinking: "adaptive", effort }` on `AnthropicProvider` for harder
  planning/reflection on 4.7+/Fable.

## [0.1.2] — 2026-06-16

### Added

- **`CliProvider`** (+ `claudeCode()` / `codexCli()`) — drives an agentic CLI
  (Claude Code, Codex) in non-interactive mode by shelling out to it, so people who
  use those tools via a **subscription login can run agents with no separate API
  key** — it rides whatever auth the CLI already has. CLI: `--provider claude` /
  `--provider codex`. (Text-only: pure-reasoning, no `--tools`.)
- **`OpenAICompatProvider`** (+ an `ollama()` helper) — talks the OpenAI
  chat-completions format, so it works with **local models (Ollama, LM Studio) with
  no API key at all**, plus OpenAI, OpenRouter, Groq, Together, llama.cpp, and more.
  The CLI selects it via `--provider ollama|openai` or `--base-url <url>`, so you no
  longer need an Anthropic key to use it from the terminal.

## [0.1.1] — 2026-06-16

### Added

- A zero-dependency **CLI** (`oh-my-fable` / `omf`) so you can drive an agent from
  the terminal without writing code: `run "<goal>"`, `resume <runId>`, `list`, and
  a no-API-key `demo` — with a live event stream of the plan and per-step
  reflections.
- An opt-in, sandboxed **`fs` toolset** (`--tools fs` / `fsTools()`):
  `read_file` / `write_file` / `list_dir`, confined to the working directory, so a
  terminal run can produce real artifacts. Also exported for library use.

## [0.1.0] — 2026-06-15

### Added

- First public release.
- The `planner ↔ executor ↔ reflector` loop over a single serializable
  `RunContext`, checkpointed after every step.
- `run(goal, config)`, `resume(runId, config)`, and `runWith(ctx, config)` —
  crash recovery by construction.
- Planner with **accumulating** replan (completed steps preserved; only remaining
  work regenerated) and JSON-schema prompting with self-repair.
- Reflector with a heuristic + model hybrid (forced `blocked` after
  `maxStepAttempts` without a model call), four verdicts including early
  `goal_met`, and a conservative parse fallback.
- Executor with a provider-agnostic tool mini-loop; thrown tools become
  observations, not crashes.
- ContextManager that folds old turns into digests (and meta-compacts digests),
  never touching the plan.
- `FileStore` (atomic write-then-rename) and `MemoryStore`.
- Budget guards: `maxSteps`, `maxTokens`, `maxWallClockMs`, `maxStepAttempts`,
  `maxReplans` — clean `halted` with all work preserved.
- `Provider` abstraction with `AnthropicProvider` (via `fetch`, no SDK) and a
  `ScriptedProvider` that makes agents **deterministically testable**.
- Observable via an `onEvent` stream.
- Zero runtime dependencies. 20 tests covering crash-resume, replan accumulation,
  self-correction, budgets, tools, and JSON defense.

[0.4.4]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.4.4
[0.4.3]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.4.3
[0.4.2]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.4.2
[0.4.1]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.4.1
[0.4.0]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.4.0
[0.3.0]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.3.0
[0.2.0]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.2.0
[0.1.2]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.1.2
[0.1.1]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.1.1
[0.1.0]: https://github.com/didrod205/oh-my-fable/releases/tag/v0.1.0

import type { Goal, RunContext, SerializableConfig, Message, Step, Observation } from "../core/types.js";

/** A short, sortable, dependency-free id. */
export function genId(prefix = "run"): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, "0");
  return `${prefix}_${t}${r}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Create a fresh, fully-initialized (and serializable) RunContext. */
export function createContext(goal: Goal, config: SerializableConfig): RunContext {
  const ts = nowIso();
  return {
    runId: genId(),
    goal,
    plan: { goal: goal.description, steps: [], status: "active", revision: 0 },
    history: [],
    digests: [],
    budget: { steps: 0, tokens: 0, startedAtMs: Date.now(), elapsedMs: 0, replans: 0 },
    config,
    createdAt: ts,
    updatedAt: ts,
    meta: {},
  };
}

export function touch(ctx: RunContext): void {
  ctx.updatedAt = nowIso();
}

export function pushHistory(ctx: RunContext, ...messages: Message[]): void {
  ctx.history.push(...messages);
}

/** The next pending step whose dependencies are all satisfied. */
export function nextPendingStep(ctx: RunContext): Step | null {
  const done = new Set(ctx.plan.steps.filter((s) => s.status === "done").map((s) => s.id));
  for (const step of ctx.plan.steps) {
    if (step.status !== "pending") continue;
    const deps = step.dependsOn ?? [];
    if (deps.every((d) => done.has(d))) return step;
  }
  return null;
}

/** True when no step can make progress (none pending, or all remaining are blocked by deps). */
export function isPlanComplete(ctx: RunContext): boolean {
  return !ctx.plan.steps.some((s) => s.status === "pending" || s.status === "running");
}

export function findStep(ctx: RunContext, id: string): Step | undefined {
  return ctx.plan.steps.find((s) => s.id === id);
}

/** Apply an observation's outcome to the step (status + result). */
export function recordObservation(ctx: RunContext, step: Step, obs: Observation): void {
  if (obs.ok) {
    step.status = "done";
    step.result = obs.output.slice(0, 600);
  } else {
    step.status = "failed";
  }
  ctx.budget.tokens += obs.tokensUsed;
  ctx.budget.steps += 1;
}

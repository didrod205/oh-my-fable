import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Planner,
  Reflector,
  FileStore,
  ScriptedProvider,
  createContext,
  resolveSerializable,
  nextPendingStep,
  checkBudget,
  reply,
  resume,
} from "../src/index.js";
import type { RunContext, Observation } from "../src/index.js";
import { extractJson, tryParse } from "../src/core/json.js";

describe("JSON defense", () => {
  it("extracts JSON from fences and prose", () => {
    expect(tryParse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParse('Sure! Here you go: {"x": [1,2]} hope that helps')).toEqual({ x: [1, 2] });
    expect(extractJson('text {"k": "}"} tail')).toBe('{"k": "}"}'); // brace inside a string
    expect(tryParse("not json")).toBeNull();
  });
});

describe("Planner", () => {
  it("falls back to a single goal-step when the plan can't be parsed", async () => {
    const provider = new ScriptedProvider([reply.text("total garbage"), reply.text("still garbage")]);
    const plan = await new Planner(provider, 0).plan({ description: "do the thing" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.intent).toBe("do the thing");
  });

  it("coerces and de-duplicates ids", async () => {
    const provider = new ScriptedProvider([
      reply.plan([{ id: "x", intent: "a" }, { id: "x", intent: "b" }, { id: "", intent: "c" }]),
    ]);
    const plan = await new Planner(provider, 0).plan({ description: "g" });
    const ids = plan.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(plan.steps.map((s) => s.intent)).toEqual(["a", "b", "c"]);
  });
});

describe("Reflector", () => {
  it("falls back to needs_replan when the verdict can't be parsed", async () => {
    const provider = new ScriptedProvider([reply.text("garbage"), reply.text("garbage")]);
    const ctx = createContext({ description: "g" }, resolveSerializable({}));
    ctx.plan = { goal: "g", steps: [{ id: "s1", intent: "x", status: "running", attempts: 0 }], status: "active", revision: 0 };
    const obs: Observation = { stepId: "s1", ok: true, output: "did x", tokensUsed: 10 };
    const r = await new Reflector(provider).reflect(ctx.plan, obs, ctx);
    expect(r.progress).toBe("needs_replan");
  });

  it("forces blocked after maxStepAttempts without a model call", async () => {
    const provider = new ScriptedProvider([]); // must NOT be called
    const ctx = createContext({ description: "g" }, resolveSerializable({ maxStepAttempts: 2 }));
    const step = { id: "s1", intent: "x", status: "running" as const, attempts: 1 };
    ctx.plan = { goal: "g", steps: [step], status: "active", revision: 0 };
    const obs: Observation = { stepId: "s1", ok: false, output: "", error: "nope", tokensUsed: 0 };
    const r = await new Reflector(provider).reflect(ctx.plan, obs, ctx);
    expect(r.progress).toBe("blocked");
    expect(step.attempts).toBe(2);
  });
});

describe("nextPendingStep respects dependsOn", () => {
  it("returns a dependency before its dependent, regardless of array order", () => {
    const ctx = createContext({ description: "g" }, resolveSerializable({}));
    ctx.plan.steps = [
      { id: "s2", intent: "second", dependsOn: ["s1"], status: "pending", attempts: 0 },
      { id: "s1", intent: "first", status: "pending", attempts: 0 },
    ];
    expect(nextPendingStep(ctx)!.id).toBe("s1");
    ctx.plan.steps[1]!.status = "done";
    expect(nextPendingStep(ctx)!.id).toBe("s2");
  });
});

describe("budget", () => {
  it("flags each exhausted axis", () => {
    const base = createContext({ description: "g" }, resolveSerializable({ maxSteps: 5, maxTokens: 100, maxReplans: 2 }));
    expect(checkBudget(base).exceeded).toBe(false);
    expect(checkBudget({ ...base, budget: { ...base.budget, steps: 5 } }).reason).toMatch(/step/);
    expect(checkBudget({ ...base, budget: { ...base.budget, tokens: 100 } }).reason).toMatch(/token/);
    expect(checkBudget({ ...base, budget: { ...base.budget, replans: 2 } }).reason).toMatch(/replan/);
  });
});

describe("FileStore round-trips RunContext", () => {
  it("saves, loads, and lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-"));
    try {
      const store = new FileStore(dir);
      const ctx: RunContext = createContext({ description: "persist me" }, resolveSerializable({}));
      ctx.plan.steps = [{ id: "s1", intent: "x", status: "done", attempts: 1, result: "ok" }];
      await store.save(ctx);
      const loaded = await store.load(ctx.runId);
      expect(loaded).toEqual(ctx);
      const list = await store.list();
      expect(list[0]!.runId).toBe(ctx.runId);
      expect(list[0]!.goal).toBe("persist me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes a directory it creates ignore itself", async () => {
    // A checkpoint holds the whole history, tool output included. Running an
    // agent inside a repo must not quietly stage that for commit.
    const base = mkdtempSync(join(tmpdir(), "af-"));
    try {
      const dir = join(base, "runs"); // does not exist yet — the store creates it
      const store = new FileStore(dir);
      await store.save(createContext({ description: "g" }, resolveSerializable({})));
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
      expect((await store.list()).length).toBe(1); // the marker is not mistaken for a run
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves a directory the user already set up exactly as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-")); // pre-existing
    try {
      writeFileSync(join(dir, "NOTES.md"), "mine\n", "utf8");
      await new FileStore(dir).save(createContext({ description: "g" }, resolveSerializable({})));
      expect(existsSync(join(dir, ".gitignore"))).toBe(false);
      expect(readFileSync(join(dir, "NOTES.md"), "utf8")).toBe("mine\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still creates nested directories that do not exist", async () => {
    const base = mkdtempSync(join(tmpdir(), "af-"));
    try {
      const store = new FileStore(join(base, "a", "b", "runs"));
      const ctx = createContext({ description: "deep" }, resolveSerializable({}));
      await store.save(ctx);
      expect((await store.load(ctx.runId))!.runId).toBe(ctx.runId);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("a budget halt can be lifted on resume", () => {
  it("takes a raised ceiling from the caller and keeps the rest", async () => {
    // Without this a run halted on a budget halts again the instant it resumes,
    // while the halt message tells you to resume — the ceiling it is sitting on
    // is the one thing you cannot change.
    const dir = mkdtempSync(join(tmpdir(), "af-"));
    try {
      const store = new FileStore(dir);
      const ctx = createContext({ description: "g" }, resolveSerializable({ maxSteps: 4, maxTokens: 1000 }));
      ctx.plan.steps = [{ id: "s1", intent: "x", status: "done", attempts: 1, result: "ok" }];
      ctx.budget.tokens = 5000; // already past the token ceiling
      await store.save(ctx);

      const provider = new ScriptedProvider([reply.reflection("goal_met")]);
      const r = await resume(ctx.runId, { provider, store, maxTokens: 9_000_000 });
      expect(r.ctx.config.maxTokens).toBe(9_000_000);
      expect(r.ctx.config.maxSteps).toBe(4); // untouched
      expect(r.status).not.toBe("halted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves every budget alone when the caller names none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-"));
    try {
      const store = new FileStore(dir);
      const ctx = createContext({ description: "g" }, resolveSerializable({ maxSteps: 7, maxTokens: 1234 }));
      await store.save(ctx);
      const provider = new ScriptedProvider([reply.plan([{ id: "s1", intent: "x" }]), reply.text("ok"), reply.reflection("goal_met")]);
      const r = await resume(ctx.runId, { provider, store });
      expect(r.ctx.config.maxSteps).toBe(7);
      expect(r.ctx.config.maxTokens).toBe(1234);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

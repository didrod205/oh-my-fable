import { describe, it, expect } from "vitest";
import { reply, resume, createContext, resolveSerializable, MemoryStore, ScriptedProvider, runScripted } from "./helpers.js";
import { checkBudget } from "../src/index.js";

// The behaviors that make the harness think like the model it's named after:
// plan exhaustion ≠ goal completion, a stranded plan is blocked (not done),
// a crash is a pause (not spent wall-clock), and every model call is budgeted.

describe("exit check — plan exhaustion ≠ goal completion", () => {
  it("verifies the success criteria when the plan runs out, then finishes", async () => {
    const { result, events } = await runScripted(
      { description: "write the report", successCriteria: ["a finished report exists"] },
      [
        reply.plan([{ id: "s1", intent: "draft the report" }]),
        reply.text("drafted"),
        reply.reflection("on_track"),
        reply.reflection("goal_met", "report exists and is complete"), // exit check
      ],
    );
    expect(result.status).toBe("done");
    const check = events.find((e) => e.type === "exit_check");
    expect(check?.type === "exit_check" && check.reflection.progress).toBe("goal_met");
  });

  it("goes back to work when the exit check says the criteria are NOT met", async () => {
    const { result, events } = await runScripted(
      { description: "write the report", successCriteria: ["report includes a summary section"] },
      [
        reply.plan([{ id: "s1", intent: "draft the report" }]),
        reply.text("drafted, no summary"),
        reply.reflection("on_track"),
        reply.reflection("needs_replan", "the summary section is missing"), // exit check → not done
        reply.plan([{ id: "f1", intent: "add the summary section" }]), // replan
        reply.text("summary added"),
        reply.reflection("on_track"),
        reply.reflection("goal_met", "all criteria met"), // second exit check
      ],
    );
    expect(result.status).toBe("done");
    expect(result.ctx.plan.revision).toBe(1);
    expect(result.ctx.budget.replans).toBe(1);
    expect(events.filter((e) => e.type === "exit_check")).toHaveLength(2);
    expect(result.ctx.plan.steps.some((s) => s.intent === "add the summary section" && s.status === "done")).toBe(true);
  });

  it("skips the exit check when the goal has no success criteria (no extra calls)", async () => {
    const { result, provider } = await runScripted("just do it", [
      reply.plan([{ id: "s1", intent: "do it" }]),
      reply.text("did it"),
      reply.reflection("on_track"),
    ]);
    expect(result.status).toBe("done");
    expect(provider.requests).toHaveLength(3); // plan + execute + reflect — nothing more
  });
});

describe("stranded dependencies — a blocked plan is not a finished plan", () => {
  it("replans instead of declaring a false done when pending steps can never run", async () => {
    const { result, events } = await runScripted("g", [
      reply.plan([
        { id: "s1", intent: "the possible part" },
        { id: "s2", intent: "depends on a ghost", dependsOn: ["ghost"] },
      ]),
      reply.text("possible part done"),
      reply.reflection("on_track"),
      reply.plan([{ id: "r1", intent: "the part without the ghost" }]), // stranded → replan (no reflect call)
      reply.text("done without the ghost"),
      reply.reflection("on_track"),
    ]);
    expect(result.status).toBe("done");
    expect(result.ctx.budget.replans).toBe(1);
    expect(events.some((e) => e.type === "replan")).toBe(true);
    // the stranded step was replaced, not silently marked complete
    expect(result.ctx.plan.steps.some((s) => s.id === "s2")).toBe(false);
    expect(result.ctx.plan.steps.some((s) => s.intent === "the part without the ghost" && s.status === "done")).toBe(true);
  });
});

describe("a crash is a pause — wall-clock counts active time only", () => {
  it("resumes cleanly even after the process was dead longer than maxWallClockMs", async () => {
    const store = new MemoryStore();
    const ctx = createContext({ description: "g" }, resolveSerializable({ maxWallClockMs: 60_000 }));
    ctx.plan = { goal: "g", steps: [{ id: "s1", intent: "x", status: "pending", attempts: 0 }], status: "active", revision: 0 };
    ctx.budget.startedAtMs = Date.now() - 3_600_000; // checkpointed an hour ago, then the process died
    await store.save(ctx);

    const result = await resume(ctx.runId, {
      provider: new ScriptedProvider([reply.text("x done"), reply.reflection("goal_met")]),
      store,
    });
    expect(result.status).toBe("done"); // the dead hour did not burn the budget
  });

  it("still counts ACTIVE time accumulated across sessions", () => {
    const ctx = createContext({ description: "g" }, resolveSerializable({ maxWallClockMs: 60_000 }));
    ctx.budget.elapsedMs = 120_000; // two minutes of real runtime already folded in
    expect(checkBudget(ctx).exceeded).toBe(true);
    expect(checkBudget(ctx).reason).toMatch(/wall-clock/);
  });
});

describe("token metering — every model call counts", () => {
  it("budgets planner and reflector calls, not just step execution", async () => {
    const { result, events } = await runScripted("g", [
      reply.plan([{ id: "s1", intent: "a" }]),
      reply.text("a done"),
      reply.reflection("on_track"),
    ]);
    // The budget must exceed what execution alone consumed — planning and
    // reflection are real spend too.
    const executionTokens = events
      .filter((e) => e.type === "step_done")
      .reduce((n, e) => n + (e.type === "step_done" ? e.observation.tokensUsed : 0), 0);
    expect(executionTokens).toBeGreaterThan(0);
    expect(result.ctx.budget.tokens).toBeGreaterThan(executionTokens);
  });

  it("halts on maxTokens even when the spend comes from planning/reflection", async () => {
    const responses = [reply.plan([{ id: "s1", intent: "a" }, { id: "s2", intent: "b" }])];
    for (let i = 0; i < 10; i++) {
      responses.push(reply.text("x".repeat(400)));
      responses.push(reply.reflection("on_track"));
    }
    const { result } = await runScripted("g", responses, { maxTokens: 150 });
    expect(result.status).toBe("halted");
    expect(result.reason).toMatch(/token budget/);
  });
});

describe("cache-friendly execution — stable history first, volatile step last", () => {
  it("flags the last history message as a cache breakpoint and keeps the flag out of the checkpoint", async () => {
    const { result, provider } = await runScripted("g", [
      reply.plan([{ id: "s1", intent: "a" }, { id: "s2", intent: "b" }]),
      reply.text("a out"),
      reply.reflection("on_track"),
      reply.text("b out"),
      reply.reflection("on_track"),
    ]);
    // requests: [0]=plan, [1]=exec s1, [2]=reflect s1, [3]=exec s2, [4]=reflect s2
    const firstExec = provider.requests[1]!;
    expect(firstExec.messages.some((m) => m.cache)).toBe(false); // empty history — nothing to cache yet

    const secondExec = provider.requests[3]!;
    const flagged = secondExec.messages.filter((m) => m.cache);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.content).toBe("a out"); // the last history message
    // the volatile instruction (plan state + current step) comes AFTER the breakpoint
    const flagIdx = secondExec.messages.findIndex((m) => m.cache);
    expect(flagIdx).toBeLessThan(secondExec.messages.length - 1);
    expect(secondExec.messages[secondExec.messages.length - 1]!.content).toContain("Now do this step");

    // the persisted history never carries the request-local flag
    expect(result.ctx.history.every((m) => !m.cache)).toBe(true);
  });
});

describe("truncation is a signal, not a silent success", () => {
  it("annotates a max_tokens-truncated step result so the reflector can see it", async () => {
    const { result } = await runScripted("g", [
      reply.plan([{ id: "s1", intent: "a" }]),
      { content: "partial output", stopReason: "max_tokens" as const },
      reply.reflection("on_track"),
    ]);
    expect(result.ctx.plan.steps[0]!.result).toContain("truncated");
  });
});

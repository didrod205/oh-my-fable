import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, ScriptedProvider, reply, MemoryStore, defineTool, fsTools, CliProvider } from "../src/index.js";
import { estimateTokens } from "../src/providers/provider.js";

/** Findings from an autonomous audit of this repo. Each one is reproduced here. */

describe("a step cut off mid-tool-loop is not a clean success", () => {
  it("says the hop limit stopped it, so the reflector can route", async () => {
    // stopReason stays "tool_use", which passes the ok test, and a tool-calling
    // turn carries no text — so the step used to be filed as a silent success.
    const echo = defineTool("echo", "echo", { type: "object" }, async () => ({ ok: true, output: "ok" }));
    const provider = new ScriptedProvider([
      reply.plan([{ id: "s1", intent: "loop forever" }]),
      // more tool-use turns than MAX_TOOL_HOPS (8)
      ...Array.from({ length: 12 }, () => reply.toolUse([{ id: "t", name: "echo", input: {} }])),
      reply.reflection("goal_met"),
    ]);
    const r = await run("x", { provider, store: new MemoryStore(), tools: [echo], maxSteps: 2 });
    const step = r.ctx.plan.steps[0]!;
    expect(step.result).toMatch(/hop limit|unfinished/i);
  });
});

describe("the fs toolset stays inside the working directory", () => {
  it("refuses a symlink that points out of the sandbox", async () => {
    // A lexical path check passes for a link whose target is elsewhere, and the
    // read follows it — the README calls this toolset confined to the cwd.
    const root = mkdtempSync(join(tmpdir(), "omf-fs-"));
    const outside = mkdtempSync(join(tmpdir(), "omf-secret-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n", "utf8");
      mkdirSync(join(root, "sub"));
      symlinkSync(join(outside, "secret.txt"), join(root, "sub", "leak.txt"));
      const read = fsTools(root).find((t) => t.name === "read_file")!;
      const out = await read.handler({ path: "sub/leak.txt" });
      expect(out.ok).toBe(false);
      expect(String(out.output ?? "") + String(out.error ?? "")).not.toContain("TOP SECRET");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("says so when a file was too big to return whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "omf-fs-"));
    try {
      writeFileSync(join(root, "big.txt"), "x".repeat(150_000), "utf8");
      const read = fsTools(root).find((t) => t.name === "read_file")!;
      const out = await read.handler({ path: "big.txt" });
      expect(out.ok).toBe(true);
      expect(out.output).toMatch(/truncated/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("driving an agentic CLI as a subprocess", () => {
  it("survives a child that exits before reading its stdin", async () => {
    // The write emits EPIPE; an unhandled 'error' on the stream would take the
    // harness down with it instead of reporting the child's own failure.
    const p = new CliProvider({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      promptVia: "stdin",
    });
    await expect(p.complete({ messages: [{ role: "user", content: "x".repeat(200_000) }] })).rejects.toThrow(/exited 3/);
  });

  it("gives an agentic CLI step longer than a chat completion", () => {
    // Two minutes SIGKILLs Claude mid-file-read and reports a timeout for a step
    // that was progressing.
    const p = new CliProvider({ command: "true", args: [] }) as unknown as { timeoutMs: number };
    expect(p.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });
});

describe("token estimates on a tool-using run", () => {
  it("counts tool arguments and results, not just the prose", () => {
    // These travel as structured fields; counting only `content` under-reports a
    // tool-heavy run by most of its size, so compaction never triggers.
    const bare = estimateTokens([{ role: "assistant", content: "hi" }]);
    const withTools = estimateTokens([
      {
        role: "assistant",
        content: "hi",
        toolCalls: [{ id: "t1", name: "read_file", input: { path: "a".repeat(400) } }],
      },
      { role: "user", content: "", toolResults: [{ toolCallId: "t1", ok: true, output: "b".repeat(4000) }] },
    ]);
    expect(withTools).toBeGreaterThan(bare * 10);
  });
});

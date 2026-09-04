import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, createContext, resolveSerializable } from "../src/index.js";
import { invocationOf, withRemembered, describeInvocation, positiveFlag, restoredPermissions, handsLabel } from "../src/config/invocation.js";
import type { RunContext } from "../src/core/types.js";

const ctxWith = (cli?: unknown): RunContext => {
  const ctx = createContext({ description: "g" }, resolveSerializable({}));
  if (cli !== undefined) ctx.meta["cli"] = cli;
  return ctx;
};

describe("resume brings back the same agent", () => {
  it("records the agent-shaping flags and nothing else", () => {
    const inv = invocationOf({ provider: "claude", model: "opus", "cli-tools": true, tools: "fs", quiet: true, "max-steps": "9" });
    expect(inv).toEqual({ provider: "claude", model: "opus", "cli-tools": true, tools: "fs" });
  });

  it("never writes the api key into the checkpoint", () => {
    // A checkpoint is a file on disk — a resumed run re-reads the key from the env.
    expect(invocationOf({ "base-url": "https://x/v1", model: "m", "api-key": "sk-secret" })).not.toHaveProperty("api-key");
  });

  it("restores the provider a bare `resume` would otherwise lose", () => {
    // Without this the CLI silently falls back to Anthropic and demands a key.
    const ctx = ctxWith({ "base-url": "http://localhost:1234/v1", model: "local" });
    expect(withRemembered(ctx, {})).toEqual({ "base-url": "http://localhost:1234/v1", model: "local" });
  });

  it("restores the toolset, so a resumed agent keeps its hands", () => {
    // The silent failure: resuming without --tools fs used to continue with no
    // tools at all and still report `done`.
    expect(withRemembered(ctxWith({ provider: "openai", tools: "fs" }), {})["tools"]).toBe("fs");
  });

  it("lets a flag typed on the resume command win over the remembered one", () => {
    const merged = withRemembered(ctxWith({ provider: "ollama", model: "llama3.1" }), { model: "mistral" });
    expect(merged).toEqual({ provider: "ollama", model: "mistral" });
  });

  it("leaves pre-existing checkpoints (no recorded invocation) untouched", () => {
    expect(withRemembered(ctxWith(), { provider: "claude" })).toEqual({ provider: "claude" });
  });

  it("survives a real save/load round-trip through the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omf-inv-"));
    try {
      const store = new FileStore(dir);
      const ctx = ctxWith(invocationOf({ provider: "claude", "cli-tools": true, "api-key": "sk-nope" }));
      await store.save(ctx);
      const loaded = await store.load(ctx.runId);
      expect(withRemembered(loaded!, {})).toEqual({ provider: "claude", "cli-tools": true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says out loud which agent it resumed as", () => {
    expect(describeInvocation({ provider: "claude", "cli-tools": true })).toBe("claude --cli-tools");
    expect(describeInvocation({ "base-url": "http://h/v1", model: "m", tools: "fs" })).toBe("http://h/v1 m --tools fs");
    expect(describeInvocation({})).toBe("");
  });
});

describe("budget flags", () => {
  it("refuses a value that is not a positive number", () => {
    // Number("abc") is NaN, and `used >= NaN` is false forever — a typo used to
    // remove the runaway ceiling instead of rejecting the command.
    for (const bad of ["abc", "0", "-5", "", true as const]) {
      expect(() => positiveFlag(bad, "max-steps")).toThrow(/positive number/);
    }
  });

  it("passes a real budget through, and leaves an absent flag absent", () => {
    expect(positiveFlag("50", "max-steps")).toBe(50);
    expect(positiveFlag("2000000", "max-tokens")).toBe(2_000_000);
    expect(positiveFlag(undefined, "max-steps")).toBeUndefined();
  });
});

describe("tool access restored from a checkpoint", () => {
  // The checkpoint is an ordinary file in the user's runs directory. Restoring
  // the agent from it is the point — but whoever can write there decides what a
  // later resume runs and under which permission mode, so it must not be quiet.
  it("names the permission flags that came from the file", () => {
    const ctx = ctxWith({ provider: "claude", "cli-tools": true, "permission-mode": "dontAsk" });
    expect(restoredPermissions(ctx, {})).toEqual(["cli-tools", "permission-mode"]);
  });

  it("stays quiet when the operator typed those flags themselves", () => {
    const ctx = ctxWith({ provider: "claude", "cli-tools": true, "permission-mode": "dontAsk" });
    expect(restoredPermissions(ctx, { "cli-tools": true, "permission-mode": "acceptEdits" })).toEqual([]);
  });

  it("does not flag a restored provider that grants nothing", () => {
    expect(restoredPermissions(ctxWith({ provider: "ollama", model: "llama3.1" }), {})).toEqual([]);
  });
});

describe("what the run says the agent can touch", () => {
  it("never claims pure reasoning while the CLI holds its own tools", () => {
    expect(handsLabel({ "cli-tools": true })).toBe("(the CLI runs its own tools — acceptEdits)");
    expect(handsLabel({ "cli-tools": true, "permission-mode": "dontAsk" })).toBe("(the CLI runs its own tools — dontAsk)");
    expect(handsLabel({ allow: "Read,Edit" })).toMatch(/runs its own tools/);
  });

  it("still distinguishes harness tools from no tools at all", () => {
    expect(handsLabel({ tools: "fs" })).toBe("(fs tools on)");
    expect(handsLabel({})).toBe("(no tools — pure reasoning)");
    expect(handsLabel({ provider: "ollama" })).toBe("(no tools — pure reasoning)");
  });
});

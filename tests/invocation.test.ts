import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, createContext, resolveSerializable } from "../src/index.js";
import { invocationOf, withRemembered, describeInvocation } from "../src/config/invocation.js";
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

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatProvider, ollama, CliProvider, defineTool } from "../src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch, capturing the request and returning a canned chat-completion. */
function stub(response: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => response, text: async () => "" } as Response;
  }) as typeof fetch;
  return calls;
}

describe("OpenAICompatProvider", () => {
  it("maps messages + tools to the chat-completions request", async () => {
    const calls = stub({ choices: [{ message: { content: "hi back" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
    const p = new OpenAICompatProvider({ baseUrl: "http://host/v1/", apiKey: "secret", model: "m-1" });
    const out = await p.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "sum", description: "add", parameters: { type: "object" } }],
    });

    expect(out.content).toBe("hi back");
    expect(out.tokensIn).toBe(11);
    expect(out.tokensOut).toBe(7);
    expect(out.stopReason).toBe("end");

    const { url, init } = calls[0]!;
    expect(url).toBe("http://host/v1/chat/completions"); // trailing slash normalized
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer secret");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("m-1");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "sum", description: "add", parameters: { type: "object" } } });
  });

  it("parses tool calls and a tool_calls finish reason", async () => {
    stub({ choices: [{ message: { content: "", tool_calls: [{ id: "call_1", function: { name: "sum", arguments: '{"a":2,"b":3}' } }] }, finish_reason: "tool_calls" }] });
    const out = await new OpenAICompatProvider({ baseUrl: "http://h/v1", model: "m" }).complete({ messages: [{ role: "user", content: "x" }] });
    expect(out.stopReason).toBe("tool_use");
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "sum", input: { a: 2, b: 3 } }]);
  });

  it("surfaces server errors", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => "bad model" }) as Response) as typeof fetch;
    await expect(new OpenAICompatProvider({ baseUrl: "http://h/v1", model: "nope", maxRetries: 0 }).complete({ messages: [] })).rejects.toThrow(/400/);
  });
});

describe("CliProvider — drives an agentic CLI via subprocess", () => {
  it("captures stdout from a command (prompt passed as an arg)", async () => {
    // `node -e "<script>" <prompt>` — the script ignores the prompt and prints a result.
    const p = new CliProvider({ command: process.execPath, args: ["-e", "process.stdout.write('CLI RESULT')"], promptVia: "arg" });
    const out = await p.complete({ messages: [{ role: "user", content: "anything" }] });
    expect(out.content).toBe("CLI RESULT");
    expect(out.stopReason).toBe("end");
  });

  it("can pass the prompt on stdin", async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('GOT:'+s))";
    const p = new CliProvider({ command: process.execPath, args: ["-e", script], promptVia: "stdin" });
    const out = await p.complete({ messages: [{ role: "user", content: "hello" }] });
    expect(out.content).toBe("GOT:hello");
  });

  it("surfaces a non-zero exit as an error", async () => {
    const p = new CliProvider({ command: process.execPath, args: ["-e", "process.exit(3)"], promptVia: "arg" });
    await expect(p.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/exited 3/);
  });

  it("reports a missing command clearly", async () => {
    const p = new CliProvider({ command: "definitely-not-a-real-binary-xyz", promptVia: "arg" });
    await expect(p.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/not installed|not on your PATH/);
  });
});

describe("ollama() helper — local, no key", () => {
  it("hits localhost:11434 with no Authorization header", async () => {
    const calls = stub({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    await ollama("llama3.1").complete({ messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });
});

describe("CliProvider — harness tools over the text protocol", () => {
  const finding = defineTool(
    "record_finding",
    "Record one audit finding.",
    { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    async () => ({ ok: true, output: "recorded" }),
  );
  // Echoes whether the tool manifest reached it, and answers in the protocol.
  const script =
    'const c=process.argv[process.argv.length-1];' +
    'if(c.includes("record_finding")) process.stdout.write(JSON.stringify({"oh-my-fable:tool_calls":[{name:"record_finding",input:{title:"hardcoded key"}}]}));' +
    'else process.stdout.write("no tools were offered");';
  const provider = () => new CliProvider({ command: process.execPath, args: ["-e", script], promptVia: "arg" });

  it("tells an agentic CLI which tools it has", async () => {
    // Without this the model is never told the tools exist and invents a
    // workaround, so the run completes having called nothing.
    const r = await provider().complete({ messages: [{ role: "user", content: "audit" }], tools: [finding.schema] });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls?.[0]).toMatchObject({ name: "record_finding", input: { title: "hardcoded key" } });
    expect(r.toolCalls?.[0]!.id).toBeTruthy();
  });

  it("leaves a request with no tools exactly as it was", async () => {
    const r = await provider().complete({ messages: [{ role: "user", content: "audit" }] });
    expect(r.content).toBe("no tools were offered");
    expect(r.stopReason).toBe("end");
    expect(r.toolCalls).toBeUndefined();
  });

  it("salvages the complete calls when the answer was cut off mid-object", async () => {
    // A token cap can cut a CLI answer mid-object, which leaves the whole block
    // unparseable. Dropping it loses the calls that WERE complete: the model
    // does the work, nothing is recorded, and the run still reports success.
    const full = JSON.stringify({
      "oh-my-fable:tool_calls": [
        { name: "record_finding", input: { title: "first", evidence: "a { brace inside a string" } },
        { name: "record_finding", input: { title: "second" } },
      ],
    });
    const cut = full.slice(0, full.length - 30);
    const p = new CliProvider({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(cut)})`],
      promptVia: "arg",
    });
    const r = await p.complete({ messages: [{ role: "user", content: "audit" }], tools: [finding.schema] });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls?.[0]!.input).toMatchObject({ title: "first" });
  });

  it("falls back to text when nothing complete survives the truncation", async () => {
    const p = new CliProvider({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(\'{"oh-my-fable:tool_calls":[{"name":"rec\')'],
      promptVia: "arg",
    });
    const r = await p.complete({ messages: [{ role: "user", content: "audit" }], tools: [finding.schema] });
    expect(r.stopReason).toBe("end");
    expect(r.toolCalls).toBeUndefined();
  });

  it("does not mistake ordinary prose for a tool call", async () => {
    const chatty = new CliProvider({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("I looked and found nothing worth recording.")'],
      promptVia: "arg",
    });
    const r = await chatty.complete({ messages: [{ role: "user", content: "audit" }], tools: [finding.schema] });
    expect(r.stopReason).toBe("end");
    expect(r.toolCalls).toBeUndefined();
  });
});

describe("CliProvider — carrying the CLI's own session", () => {
  // Without this every step is a cold start: the CLI re-reads the whole
  // workspace, and nothing it learned in step 1 exists in step 2.
  //
  // The stub is a real script file rather than `node -e`, because node parses
  // a bare `--resume` as one of its own options and refuses it.
  let dir: string;
  let script: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omf-cli-"));
    script = join(dir, "echo.mjs");
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ result: process.argv.slice(2).join(" "), session_id: "sess-1" }))',
      "utf8",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const provider = (continueSession: boolean) =>
    new CliProvider({
      command: process.execPath,
      args: [script],
      promptVia: "arg",
      continueSession,
      parseResult: (out) => {
        const j = JSON.parse(out) as { result: string; session_id: string };
        return { content: j.result, sessionId: j.session_id };
      },
    });

  it("resumes the session it was given on the next work call", async () => {
    const p = provider(true);
    const first = await p.complete({ messages: [{ role: "user", content: "one" }] });
    expect(first.content).not.toContain("--resume");
    const second = await p.complete({ messages: [{ role: "user", content: "two" }] });
    expect(second.content).toContain("--resume sess-1");
  });

  it("keeps planning and reflection out of that session", async () => {
    // A reflector that remembers doing the work is not an independent check of
    // it. Those calls ask for JSON, so they stay cold.
    const p = provider(true);
    await p.complete({ messages: [{ role: "user", content: "work" }] });
    const judged = await p.complete({ messages: [{ role: "user", content: "judge" }], responseFormat: "json" });
    expect(judged.content).not.toContain("--resume");
  });

  it("does nothing unless asked", async () => {
    const p = provider(false);
    await p.complete({ messages: [{ role: "user", content: "one" }] });
    const second = await p.complete({ messages: [{ role: "user", content: "two" }] });
    expect(second.content).not.toContain("--resume");
  });

  it("falls back to a cold start when the CLI rejects the session", async () => {
    // A session the CLI no longer knows about must not strand the run.
    const picky = join(dir, "picky.mjs");
    writeFileSync(
      picky,
      'if (process.argv.includes("--resume")) { process.stderr.write("unknown session"); process.exit(2); }' +
        'process.stdout.write(JSON.stringify({ result: "cold:" + process.argv.slice(2).join(" "), session_id: "sess-1" }))',
      "utf8",
    );
    const p = new CliProvider({
      command: process.execPath,
      args: [picky],
      promptVia: "arg",
      continueSession: true,
      parseResult: (out) => {
        const j = JSON.parse(out) as { result: string; session_id: string };
        return { content: j.result, sessionId: j.session_id };
      },
    });
    await p.complete({ messages: [{ role: "user", content: "one" }] });
    const second = await p.complete({ messages: [{ role: "user", content: "two" }] });
    expect(second.content).toBe("cold:two");
  });
});

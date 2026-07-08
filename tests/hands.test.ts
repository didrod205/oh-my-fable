import { describe, it, expect, afterEach } from "vitest";
import { AnthropicProvider, OpenAICompatProvider, defineTool, fsTools, reply, claudeRequestArgs, PLAN_SCHEMA } from "../src/index.js";
import type { CompletionRequest, Message } from "../src/index.js";
import { runScripted } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(response: unknown) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string) });
    return { ok: true, status: 200, json: async () => response, text: async () => "" } as Response;
  }) as typeof fetch;
  return calls;
}

const usage = { input_tokens: 10, output_tokens: 5 };
const ok = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage };

const TOOL_LOOP_MESSAGES: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "go" },
  { role: "assistant", content: "let me check", toolCalls: [{ id: "t1", name: "sum", input: { a: 2, b: 3 } }] },
  { role: "user", content: "Tool results:\n- sum: 5", toolResults: [{ toolCallId: "t1", ok: true, output: "5" }] },
];

describe("AnthropicProvider — native tool blocks", () => {
  it("renders toolCalls/toolResults as tool_use/tool_result blocks with matching ids", async () => {
    const calls = stub(ok);
    await new AnthropicProvider({ apiKey: "k" }).complete({ messages: TOOL_LOOP_MESSAGES });
    const msgs = calls[0]!.body["messages"] as Array<{ role: string; content: unknown }>;

    const assistant = msgs[1]!.content as Array<Record<string, unknown>>;
    expect(assistant[0]).toEqual({ type: "text", text: "let me check" });
    expect(assistant[1]).toEqual({ type: "tool_use", id: "t1", name: "sum", input: { a: 2, b: 3 } });

    const user = msgs[2]!.content as Array<Record<string, unknown>>;
    expect(user).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "5" }]); // flattened fallback text dropped
  });

  it("marks a failed tool result with is_error", async () => {
    const calls = stub(ok);
    await new AnthropicProvider({ apiKey: "k" }).complete({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "boom", input: {} }] },
        { role: "user", content: "Tool results:\n- boom: ERROR", toolResults: [{ toolCallId: "t1", ok: false, output: "kaboom" }] },
      ],
    });
    const msgs = calls[0]!.body["messages"] as Array<{ content: unknown }>;
    const user = msgs[2]!.content as Array<Record<string, unknown>>;
    expect(user[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "kaboom", is_error: true });
  });
});

describe("OpenAICompatProvider — native tool wire format", () => {
  it("renders assistant tool_calls and role:'tool' result messages", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(init.body as string) });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), text: async () => "" } as Response;
    }) as typeof fetch;

    await new OpenAICompatProvider({ baseUrl: "http://h/v1", model: "m" }).complete({ messages: TOOL_LOOP_MESSAGES });
    const msgs = calls[0]!.body["messages"] as Array<Record<string, unknown>>;

    const assistant = msgs[2]!;
    expect(assistant["tool_calls"]).toEqual([{ id: "t1", type: "function", function: { name: "sum", arguments: '{"a":2,"b":3}' } }]);
    const toolMsg = msgs[3]!;
    expect(toolMsg["role"]).toBe("tool");
    expect(toolMsg["tool_call_id"]).toBe("t1");
    expect(toolMsg["content"]).toBe("5");
  });
});

describe("AnthropicProvider — structured outputs replace prompt-JSON", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

  it("enforces the schema via output_config.format on supporting models (no JSON nag in system)", async () => {
    const calls = stub(ok);
    await new AnthropicProvider({ apiKey: "k" }).complete({
      messages: [{ role: "system", content: "be a planner" }, { role: "user", content: "x" }],
      responseFormat: "json",
      responseSchema: schema,
    });
    const body = calls[0]!.body;
    expect((body["output_config"] as Record<string, unknown>)["format"]).toEqual({ type: "json_schema", schema });
    const sys = body["system"] as Array<{ text: string }>;
    expect(sys[0]!.text).not.toContain("ONLY valid JSON");
  });

  it("falls back to prompt-JSON on models without structured outputs", async () => {
    const calls = stub(ok);
    await new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" }).complete({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "x" }],
      responseFormat: "json",
      responseSchema: schema,
    });
    const body = calls[0]!.body;
    expect(body).not.toHaveProperty("output_config");
    const sys = body["system"] as Array<{ text: string }>;
    expect(sys[0]!.text).toContain("ONLY valid JSON");
  });

  it("does not combine schema enforcement with tool use", async () => {
    const calls = stub(ok);
    await new AnthropicProvider({ apiKey: "k" }).complete({
      messages: [{ role: "user", content: "x" }],
      responseFormat: "json",
      responseSchema: schema,
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    });
    expect(calls[0]!.body).not.toHaveProperty("output_config");
  });

  it("merges effort and format into one output_config", async () => {
    const calls = stub(ok);
    await new AnthropicProvider({ apiKey: "k", effort: "high" }).complete({
      messages: [{ role: "user", content: "x" }],
      responseFormat: "json",
      responseSchema: schema,
    });
    const oc = calls[0]!.body["output_config"] as Record<string, unknown>;
    expect(oc["effort"]).toBe("high");
    expect(oc["format"]).toEqual({ type: "json_schema", schema });
  });
});

describe("harness wiring — schemas travel with plan/reflect calls", () => {
  it("planner and reflector requests carry their response schemas", async () => {
    const { provider } = await runScripted("g", [
      reply.plan([{ id: "s1", intent: "a" }]),
      reply.text("a done"),
      reply.reflection("on_track"),
    ]);
    expect(provider.requests[0]!.responseSchema).toBe(PLAN_SCHEMA); // plan
    expect(provider.requests[2]!.responseSchema).toBeDefined(); // reflect
    expect(provider.requests[1]!.responseSchema).toBeUndefined(); // execution is free-form
  });

  it("executor's tool loop sends structured tool messages back", async () => {
    const sum = defineTool("sum", "add", { type: "object" }, () => ({ ok: true, output: "5" }));
    const { provider } = await runScripted(
      "add",
      [
        reply.plan([{ id: "s1", intent: "compute" }]),
        reply.toolUse([{ id: "t1", name: "sum", input: { a: 2, b: 3 } }]),
        reply.text("total is 5"),
        reply.reflection("goal_met"),
      ],
      { tools: [sum] },
    );
    // requests: [0] plan, [1] exec (tool_use), [2] exec follow-up, [3] reflect
    const followUp = provider.requests[2]!;
    const assistant = followUp.messages.find((m) => m.toolCalls?.length);
    expect(assistant?.toolCalls).toEqual([{ id: "t1", name: "sum", input: { a: 2, b: 3 } }]);
    const results = followUp.messages.find((m) => m.toolResults?.length);
    expect(results?.toolResults).toEqual([{ toolCallId: "t1", ok: true, output: "5" }]);
  });
});

describe("the verifier has read-only hands", () => {
  it("lets the exit check inspect artifacts with read-only tools before judging", async () => {
    let inspected: unknown = null;
    const check = defineTool(
      "check_report",
      "read the produced report",
      { type: "object", properties: { path: { type: "string" } } },
      (input) => {
        inspected = input;
        return { ok: true, output: "# Report\ncomplete, includes summary" };
      },
      { readOnly: true },
    );
    const writeTool = defineTool("write_report", "write it", { type: "object" }, () => ({ ok: true, output: "wrote" }));

    const { result, events, provider } = await runScripted(
      { description: "produce the report", successCriteria: ["report file exists and has a summary"] },
      [
        reply.plan([{ id: "s1", intent: "write the report" }]),
        reply.text("wrote report.md"),
        reply.reflection("on_track"),
        reply.toolUse([{ id: "v1", name: "check_report", input: { path: "report.md" } }]), // exit check inspects
        reply.reflection("goal_met", "verified the file itself"),
      ],
      { tools: [check, writeTool] },
    );

    expect(result.status).toBe("done");
    expect(inspected).toEqual({ path: "report.md" });
    expect(events.some((e) => e.type === "exit_check")).toBe(true);

    // requests: [0] plan, [1] exec, [2] reflect, [3] verify (tool_use), [4] verify follow-up
    const verifyReq = provider.requests[3]!;
    expect(verifyReq.tools?.map((t) => t.name)).toEqual(["check_report"]); // write tool withheld
    expect(verifyReq.responseSchema).toBeUndefined(); // schema and tools don't mix
    const followUp = provider.requests[4]!;
    expect(followUp.messages.some((m) => m.toolResults?.length)).toBe(true);
  });

  it("marks fs read tools readOnly and write tools not", () => {
    const tools = fsTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
    expect(byName["read_file"]).toBe(true);
    expect(byName["list_dir"]).toBe(true);
    expect(byName["write_file"]).toBeFalsy();
  });
});

describe("claudeRequestArgs — per-request schema", () => {
  it("enforces the request's responseSchema via --json-schema and drops the JSON nag", () => {
    const req: CompletionRequest = {
      messages: [{ role: "system", content: "be terse" }, { role: "user", content: "go" }],
      responseFormat: "json",
      responseSchema: { type: "object" },
    };
    const args = claudeRequestArgs(req, { json: true, appendSystem: true });
    expect(args[args.indexOf("--json-schema") + 1]).toBe(JSON.stringify({ type: "object" }));
    const sys = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(sys).toContain("be terse");
    expect(sys).not.toContain("ONLY valid JSON");
  });
});

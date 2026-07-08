import type { Tool, ToolSchema, ToolResult } from "../core/types.js";

export class ToolRegistry {
  private map = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): void {
    this.map.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.map.get(name);
  }

  schemas(): ToolSchema[] {
    return [...this.map.values()].map((t) => t.schema);
  }

  get size(): number {
    return this.map.size;
  }

  /** The tools that only inspect state — safe to hand to the exit-check verifier. */
  readOnlyTools(): Tool[] {
    return [...this.map.values()].filter((t) => t.readOnly === true);
  }

  /** Run a tool, turning any thrown error into a ToolResult — the loop never dies on a tool. */
  async run(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.map.get(name);
    if (!tool) return { ok: false, output: "", error: `unknown tool: ${name}` };
    try {
      return await tool.handler(input);
    } catch (err) {
      return { ok: false, output: "", error: (err as Error).message ?? "tool threw" };
    }
  }
}

/** Define a tool with less ceremony. Mark inspection-only tools `readOnly` so the exit-check verifier may use them. */
export function defineTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (input: unknown) => Promise<ToolResult> | ToolResult,
  opts: { readOnly?: boolean } = {},
): Tool {
  return { name, description, schema: { name, description, parameters }, handler, readOnly: opts.readOnly };
}

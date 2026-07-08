import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import type { Tool } from "../core/types.js";
import { defineTool } from "../executor/tools.js";

/** Resolve a path and refuse anything that escapes the sandbox root. */
function within(root: string, p: string): string | null {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" ) return abs;
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/**
 * A small, sandboxed filesystem toolset so a terminal run can actually produce
 * artifacts. Every path is confined to `root` (default: the working dir) — the
 * agent can't read or write outside it. Opt-in (`--tools fs`); default is none.
 */
export function fsTools(root: string = process.cwd()): Tool[] {
  const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
  return [
    defineTool(
      "read_file",
      "Read a UTF-8 text file, relative to the working directory.",
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      (input) => {
        const abs = within(root, str((input as { path?: unknown }).path));
        if (!abs) return { ok: false, output: "", error: "path escapes the working directory" };
        if (!existsSync(abs)) return { ok: false, output: "", error: "no such file" };
        try {
          return { ok: true, output: readFileSync(abs, "utf8").slice(0, 100_000) };
        } catch (e) {
          return { ok: false, output: "", error: (e as Error).message };
        }
      },
      { readOnly: true },
    ),
    defineTool(
      "write_file",
      "Write a UTF-8 text file, relative to the working directory. Creates parent dirs.",
      { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      (input) => {
        const { path, content } = input as { path?: unknown; content?: unknown };
        const abs = within(root, str(path));
        if (!abs) return { ok: false, output: "", error: "path escapes the working directory" };
        try {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, str(content), "utf8");
          return { ok: true, output: `wrote ${str(path)} (${str(content).length} chars)` };
        } catch (e) {
          return { ok: false, output: "", error: (e as Error).message };
        }
      },
    ),
    defineTool(
      "list_dir",
      "List entries in a directory, relative to the working directory.",
      { type: "object", properties: { path: { type: "string" } } },
      (input) => {
        const abs = within(root, str((input as { path?: unknown }).path ?? "."));
        if (!abs) return { ok: false, output: "", error: "path escapes the working directory" };
        try {
          return { ok: true, output: readdirSync(abs).join("\n") || "(empty)" };
        } catch (e) {
          return { ok: false, output: "", error: (e as Error).message };
        }
      },
      { readOnly: true },
    ),
  ];
}

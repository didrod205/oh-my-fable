import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import type { Tool } from "../core/types.js";
import { defineTool } from "../executor/tools.js";

/** How much of one file a single read may return. */
const MAX_READ_CHARS = 100_000;

/**
 * Resolve a path and refuse anything that escapes the sandbox root.
 *
 * The lexical check alone is not containment: a symlink sitting inside the root
 * and pointing at /etc passes it, and the read then follows the link straight
 * out of the sandbox. Resolve symlinks — on the path itself when it exists, and
 * otherwise on its nearest existing parent, so a write cannot be aimed through
 * a link either.
 */
function within(root: string, p: string): string | null {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null; // no root to be inside of
  }
  const contained = (target: string): boolean => {
    const r = relative(realRoot, target);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };

  if (existsSync(abs)) return contained(realpathSync(abs)) ? abs : null;

  // A path that does not exist yet (a write): the parent must still be inside.
  let parent = dirname(abs);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  try {
    return contained(realpathSync(parent)) ? abs : null;
  } catch {
    return null;
  }
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
          // Say when the file was cut: otherwise the agent reasons about a
          // partial file as if it had seen the whole thing.
          const text = readFileSync(abs, "utf8");
          if (text.length <= MAX_READ_CHARS) return { ok: true, output: text };
          return {
            ok: true,
            output: `${text.slice(0, MAX_READ_CHARS)}\n\n[truncated: showing the first ${MAX_READ_CHARS} of ${text.length} characters]`,
          };
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

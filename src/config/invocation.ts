import type { RunContext } from "../core/types.js";

/** The parsed `--flag` bag the CLI works with. */
export type FlagBag = Record<string, string | boolean>;

/**
 * The flags that decide *which agent this is* — the provider it talks to and the
 * hands it has. They are recorded in the checkpoint at `run` time so `resume`
 * brings back the same agent instead of silently falling back to the default
 * provider (a hard error) or to no tools at all (a silent one).
 *
 * `--api-key` is deliberately not among them: a checkpoint is a file on disk,
 * not a secret store. A resumed run re-reads the key from the environment.
 */
export const INVOCATION_FLAGS = ["provider", "model", "base-url", "tools", "cli-tools", "permission-mode", "allow"] as const;

export type Invocation = Partial<Record<(typeof INVOCATION_FLAGS)[number], string | boolean>>;

/** Pick the agent-shaping flags out of a full flag bag, to be stored on the context. */
export function invocationOf(flags: FlagBag): Invocation {
  const inv: Invocation = {};
  for (const k of INVOCATION_FLAGS) if (flags[k] !== undefined) inv[k] = flags[k];
  return inv;
}

/** Saved invocation as the baseline; anything typed on the resume command wins. */
export function withRemembered(ctx: RunContext, flags: FlagBag): FlagBag {
  const saved = (ctx.meta["cli"] ?? {}) as Invocation;
  const merged: FlagBag = { ...flags };
  for (const k of INVOCATION_FLAGS) {
    const v = saved[k];
    if (merged[k] === undefined && v !== undefined) merged[k] = v;
  }
  return merged;
}

/**
 * The flags that grant an agent hands. Restoring these from a checkpoint is the
 * point of remembering an invocation — but the checkpoint is an ordinary file
 * in the user's runs directory, so anyone who can write there decides what a
 * later `resume` executes and under which permission mode. That should never
 * happen quietly.
 */
const PERMISSION_FLAGS = ["cli-tools", "allow", "permission-mode"] as const;

/** Which agent-shaping flags this resume took from the checkpoint rather than the command line. */
export function restoredFrom(ctx: RunContext, flags: FlagBag): string[] {
  const saved = (ctx.meta["cli"] ?? {}) as Invocation;
  return INVOCATION_FLAGS.filter((k) => flags[k] === undefined && saved[k] !== undefined);
}

/** Of those, the ones that hand the agent tools or loosen approvals. */
export function restoredPermissions(ctx: RunContext, flags: FlagBag): string[] {
  const restored = new Set(restoredFrom(ctx, flags));
  return PERMISSION_FLAGS.filter((k) => restored.has(k));
}

/** One-line "who am I resuming as", so a restored provider is never invisible. */
export function describeInvocation(inv: Invocation): string {
  const bits: string[] = [];
  if (inv["provider"]) bits.push(String(inv["provider"]));
  else if (inv["base-url"]) bits.push(String(inv["base-url"]));
  if (inv["model"]) bits.push(String(inv["model"]));
  if (inv["cli-tools"] === true || inv["allow"]) bits.push("--cli-tools");
  if (inv["tools"] === "fs") bits.push("--tools fs");
  return bits.join(" ");
}

/**
 * A budget flag that is not a positive number must stop the run, not disable
 * the budget. `Number("abc")` is NaN, every `used >= NaN` comparison is false,
 * and the ceiling that exists to stop a runaway quietly stops existing.
 *
 * Throws rather than exiting so the caller decides how to report it.
 */
export function positiveFlag(v: string | boolean | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number, got "${String(v)}".`);
  return n;
}

/**
 * What the agent can actually touch, for the line printed at the start of a run.
 * Saying "no tools — pure reasoning" while Claude edits files on its own
 * permissions is the one thing this line must never do.
 */
export function handsLabel(flags: FlagBag): string {
  if (flags["cli-tools"] === true || typeof flags["allow"] === "string") {
    const mode = typeof flags["permission-mode"] === "string" ? flags["permission-mode"] : "acceptEdits";
    return `(the CLI runs its own tools — ${mode})`;
  }
  if (flags["tools"] === "fs") return "(fs tools on)";
  return "(no tools — pure reasoning)";
}

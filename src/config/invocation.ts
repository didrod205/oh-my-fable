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

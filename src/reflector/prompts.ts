import type { Plan, Observation, Goal, Step, Message, RunContext } from "../core/types.js";

const REFLECT_SYSTEM = `You are the progress supervisor of an autonomous agent. You just saw the result of one step. Judge what should happen next — pick exactly ONE:

- goal_met     — the goal's success criteria are ALL satisfied. (Allowed even if planned steps remain — don't pad work that's already done.)
- needs_replan — the step worked, but its result changed the assumptions the remaining plan was built on. The plan needs revising.
- blocked      — the same obstacle keeps recurring, or there is no path forward with the current plan.
- on_track     — normal forward progress; continue to the next step.

Respond with ONLY this JSON. No prose, no code fences:
{ "progress": "on_track" | "needs_replan" | "blocked" | "goal_met", "notes": "1-2 sentence reason", "confidence": 0.0 }`;

function planSummary(plan: Plan): string {
  const done = plan.steps.filter((s) => s.status === "done");
  const pending = plan.steps.filter((s) => s.status === "pending");
  const lines: string[] = [];
  if (done.length) lines.push("Done:", ...done.map((s) => `  ✓ ${s.intent}`));
  if (pending.length) lines.push("Remaining:", ...pending.map((s) => `  • ${s.intent}`));
  return lines.join("\n") || "(no steps)";
}

export function reflectPrompt(plan: Plan, obs: Observation, goal: Goal, step: Step | undefined): Message[] {
  return [
    { role: "system", content: REFLECT_SYSTEM },
    {
      role: "user",
      content: [
        `Goal: ${goal.description}`,
        goal.constraints?.length ? `Constraints (must not be violated): ${goal.constraints.join("; ")}` : "",
        goal.successCriteria?.length ? `Done when: ${goal.successCriteria.join("; ")}` : "",
        "",
        "Current plan:",
        planSummary(plan),
        "",
        `Step just run: ${step ? step.intent : obs.stepId}`,
        `Succeeded: ${obs.ok}`,
        `Result: ${obs.error ? `ERROR — ${obs.error}` : obs.output}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

/** Schema for a reflection/verdict response — schema-capable providers enforce it server-side. */
export const REFLECTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    progress: { type: "string", enum: ["on_track", "needs_replan", "blocked", "goal_met"] },
    notes: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["progress", "notes", "confidence"],
  additionalProperties: false,
};

const VERIFY_SYSTEM = `You are the final completion check of an autonomous agent. Every planned step has finished. Judge STRICTLY whether the goal's success criteria are ALL satisfied by the evidence below.

- Judge only from the evidence. If a criterion is not clearly satisfied by it, the criterion is NOT met.
- goal_met      — every success criterion is satisfied.
- needs_replan  — something is still missing; say exactly what, so the next plan can close the gap.

Respond with ONLY this JSON. No prose, no code fences:
{ "progress": "goal_met" | "needs_replan", "notes": "what is missing (or why it is complete)", "confidence": 0.0 }`;

const VERIFY_TOOLS_HINT = `

You have read-only tools. Before judging, INSPECT the actual artifacts the criteria refer to (read the files, list the directories) — check the evidence itself, don't trust the log alone. Then give your verdict.`;

export function verifyPrompt(ctx: RunContext, withTools = false): Message[] {
  const goal = ctx.goal;
  const done = ctx.plan.steps.filter((s) => s.status === "done");
  const failed = ctx.plan.steps.filter((s) => s.status === "failed");
  return [
    { role: "system", content: withTools ? VERIFY_SYSTEM + VERIFY_TOOLS_HINT : VERIFY_SYSTEM },
    {
      role: "user",
      content: [
        `Goal: ${goal.description}`,
        goal.constraints?.length ? `Constraints: ${goal.constraints.join("; ")}` : "",
        `Success criteria: ${(goal.successCriteria ?? []).join("; ")}`,
        "",
        ctx.digests.length ? `Summary of earlier work:\n${ctx.digests.map((d) => `  ${d.summary}`).join("\n")}` : "",
        "Completed steps and their recorded results:",
        done.length ? done.map((s) => `  ✓ ${s.intent}${s.result ? ` → ${s.result}` : ""}`).join("\n") : "  (none)",
        failed.length ? `Failed steps:\n${failed.map((s) => `  ✗ ${s.intent}`).join("\n")}` : "",
        "",
        "Are the success criteria ALL met?",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

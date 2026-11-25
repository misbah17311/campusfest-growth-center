import "server-only";
import OpenAI from "openai";
import { query } from "@/lib/db";
import { TOOL_DEFS, runTool, type Proposal, type ToolContext } from "./tools";

// The copilot's tool loop. The model (on Fireworks, via its OpenAI-compatible
// API) decides which tools to call; every number it may use comes back from a
// tool. Proposals are collected and returned for the user to confirm.

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
// Chosen by evaluation (tests/results): same pass rate as GLM 5.3 on the 64-question set, about 8x cheaper.
export const DEFAULT_MODEL = "accounts/fireworks/models/deepseek-v4p1-flash";
const MAX_STEPS = 8;

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type CopilotEvent =
  | { type: "tool"; name: string; summary: string }
  | { type: "answer"; text: string; proposals: Proposal[]; model: string; steps: number; usage: { prompt: number; completion: number; cached: number } }
  | { type: "error"; message: string };

const TOOL_LABEL: Record<string, string> = {
  get_overview: "Reading the headline funnel", get_campaign_metrics: "Reading campaign metrics", get_trend: "Reading the trend",
  get_funnel_leaks: "Finding where people drop out", get_decisions: "Checking the decision rules",
  get_showup_by_lead_time: "Reading show-up by lead time", get_plan: "Reading the plan versions",
  get_tasks_and_bets: "Reading tasks and bets", get_change_log: "Reading the change log", describe_data: "Checking what the data contains",
  run_sql: "Running a read-only query", calculate: "Calculating", what_if_budget: "Running the budget what-if",
  propose_task: "Preparing a task for you to confirm", propose_task_update: "Preparing a task change for you to confirm",
  propose_campaign_update: "Preparing a campaign change for you to confirm",
};

async function systemPrompt() {
  const [team, campaigns] = await Promise.all([
    query<{ owner_id: string; owner_name: string }>("select owner_id, owner_name from team order by owner_id"),
    query<{ campaign_id: string; campaign_name: string; channel: string; owner_id: string | null; status: string }>(
      "select campaign_id, campaign_name, channel, owner_id, status from campaigns order by campaign_id"),
  ]);
  return `You are the growth analyst copilot inside the CampusFest Growth Center, the command centre a festival marketing team uses to grow verified attendance. The data is CampusFest 2025 (a fictional two-day college festival, 12-13 April 2025; records 15 Jan - 20 Apr 2025), treated as last year's campaign and replayed day by day. The dashboard has a selected "as of" date: treat it as "today" unless the user names another date.

How you work:
1. Every number you state must come from a tool result in this conversation. Never use outside knowledge, memory or estimates for data. If you derive a number (a ratio, difference, share, what-if), compute it with the calculate tool.
2. Always say which date your numbers are as of. If the user asks about a past date, pass it as as_of. Before 12 April 2025 the festival had not happened: there are no visitors and no show-up yet; say so instead of guessing.
3. Use the data's definitions (call describe_data when unsure): a visitor is an external person with an admitted AND verified check-in, counted once; internal, staff and test people never count; statuses are the latest version as of the date; impressions, clicks and reach are anonymous event counts, never unique people.
4. Separate evidence from interpretation. When you explain why something happened, say what the data shows and label anything beyond it as a hypothesis. Correlation is not causation: say so when it matters (e.g. nurture emails had no comparison group).
5. If the data cannot answer, say so plainly in the first sentence, explain why (which field or comparison is missing), and say what data would answer it. Offer the closest question the data can answer. Do not fill the gap with generic advice.
6. Recommendations must cite the numbers behind them and the trade-off. Use get_decisions for the team's pre-committed scale/change/stop thresholds; use what_if_budget for budget moves and state its assumptions.
7. You cannot change data yourself. To act, call propose_task, propose_task_update or propose_campaign_update; the user sees a card and must click Confirm. Afterwards say "I've prepared ... for you to confirm" and never claim it is done. Default a new task's due date to 7 days after the selected date, and pick the owner of the relevant campaign.
8. If a question is ambiguous (which campaign? which date? which metric?), make the most reasonable reading explicit in one line, or ask one short question when the readings would give different answers.
9. Use run_sql only when no other tool answers the question; prefer the *_asof functions inside it, apply the external/verified rules yourself on raw tables, and mention that the figure came from a custom query.
10. Always say which campaign(s) a number covers. Check each tool result's scope: a figure for all campaigns combined must never be presented as one campaign's.
11. If the user names an owner who is not in the team list (e.g. "the intern"), say so explicitly in the first sentence, propose the campaign's owner instead, and ask whether that is right. If the user asks to change a task that does not exist, say clearly that no such task exists before offering to create one.
12. Always end with a written answer for the user, even after many tool calls; if a step failed or the data is incomplete, say what you found and what is missing.

Answer format: lead with the direct answer in one or two sentences. Then short "Evidence" bullets with the numbers (and the date). Add "Assumptions / limits" only when there are any, and a next step only when useful. Use ₹ with Indian digit grouping (₹2,74,000) and percentages to one decimal. Keep it under about 200 words unless the user asks for detail. Markdown is fine; small tables are fine for comparisons.

Team (owner_id: name): ${team.map((t) => `${t.owner_id}: ${t.owner_name}`).join("; ")}.
Campaigns (id: name, channel, owner, status): ${campaigns.map((c) => `${c.campaign_id}: ${c.campaign_name}, ${c.channel}, ${c.owner_id ?? "none"}, ${c.status}`).join("; ")}.`;
}

function summarise(name: string, args: Record<string, unknown>) {
  const label = TOOL_LABEL[name] ?? name;
  if (name === "calculate") return `${label}: ${args.expression}`;
  if (name === "run_sql") return `${label}: ${String(args.purpose ?? "")}`;
  if (typeof args.as_of === "string") return `${label} (as of ${args.as_of})`;
  return label;
}

export async function runCopilot(
  input: { message: string; history: ChatTurn[]; asOf: string; page: string; model?: string },
  emit: (e: CopilotEvent) => void,
) {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) throw new Error("The copilot is not configured: FIREWORKS_API_KEY is missing on the server.");
  const model = input.model || process.env.FIREWORKS_MODEL || DEFAULT_MODEL;
  const client = new OpenAI({ apiKey, baseURL: FIREWORKS_BASE_URL, timeout: 90_000, maxRetries: 1 });
  const ctx: ToolContext = { asOf: input.asOf, proposals: [] };
  const started = Date.now();
  const tools = TOOL_DEFS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> } }));
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: await systemPrompt() },
    ...input.history.slice(-12).map((t) => ({ role: t.role, content: t.content.slice(0, 6000) })),
    { role: "user", content: `[Dashboard context: selected as-of date ${input.asOf} (end of day, India time); page ${input.page}]\n${input.message}` },
  ];
  const usage = { prompt: 0, completion: 0, cached: 0 };
  let nudged = false;
  const toolLog: { name: string; args: unknown; ok: boolean }[] = [];

  for (let step = 1; step <= MAX_STEPS + 1; step++) {
    const lastStep = step > MAX_STEPS;
    const res = await client.chat.completions.create({
      model, messages, tools, tool_choice: lastStep ? "none" : "auto", temperature: 0.2, max_tokens: 8192,
    });
    usage.prompt += res.usage?.prompt_tokens ?? 0;
    usage.completion += res.usage?.completion_tokens ?? 0;
    usage.cached += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const choice = res.choices[0];
    const msg = choice?.message;
    if (!msg) throw new Error("The model returned no message");
    const calls = msg.tool_calls?.filter((c) => c.type === "function") ?? [];
    // A model occasionally emits tool arguments that are not valid JSON. Record the
    // problem, and replace them with "{}" in the stored message: the provider
    // rejects any later request whose history contains invalid tool arguments.
    const badArgs = new Set<string>();
    for (const c of calls) {
      try { JSON.parse(c.function.arguments || "{}"); } catch { badArgs.add(c.id); c.function.arguments = "{}"; }
    }
    // Keep the full message (including any reasoning_content) so reasoning models
    // see their own earlier reasoning within this turn.
    messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    if (calls.length === 0 || lastStep) {
      let text = (msg.content ?? "").trim();
      if (!text && !nudged && !lastStep) {
        // Reasoning models sometimes end a turn with no visible text. Nudge once and
        // keep the loop going WITH tools, so a pending action can still be proposed.
        nudged = true;
        toolLog.push({ name: `(empty reply, finish_reason=${choice.finish_reason}; nudged)`, args: {}, ok: false });
        messages.push({ role: "user", content: "Please continue: call any tools you still need (including propose_* for actions I asked for), then give me your answer." });
        continue;
      }
      text ||= "I could not produce an answer this time. Please ask again, or narrow the question.";
      emit({ type: "answer", text, proposals: ctx.proposals, model, steps: step, usage });
      logRun(input, text, toolLog, model, usage, Date.now() - started);
      return;
    }
    for (const call of calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      let result: unknown;
      try {
        if (badArgs.has(call.id)) throw new Error("The arguments for this call were not valid JSON. Call the tool again with a valid JSON object.");
        args = JSON.parse(call.function.arguments || "{}");
        emit({ type: "tool", name, summary: summarise(name, args) });
        result = await runTool(name, args, ctx);
        toolLog.push({ name, args, ok: true });
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
        toolLog.push({ name, args, ok: false });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 60_000) });
    }
  }
}

function logRun(input: { message: string; asOf: string }, answer: string, tools: unknown, model: string,
  usage: { prompt: number; completion: number; cached: number }, ms: number) {
  query(
    `insert into copilot_log (as_of, question, answer, tools, model, prompt_tokens, completion_tokens, ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.asOf, input.message.slice(0, 4000), answer.slice(0, 8000), JSON.stringify(tools), model, usage.prompt, usage.completion, ms],
  ).catch(() => {});
}

import { z } from "zod";
import { resolveAsOf } from "@/lib/asof";
import { runCopilot, type CopilotEvent } from "@/lib/copilot/run";

export const maxDuration = 120;

const Body = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(40).default([]),
  asOf: z.string().optional(),
  page: z.string().max(200).default("/"),
  model: z.string().max(200).optional(), // honoured only in development (model comparison runs)
});

// Simple per-instance rate limit so a public link cannot run up the model bill.
const hits = new Map<string, number[]>();
function allowed(ip: string) {
  if (process.env.NODE_ENV !== "production") return true; // local testing and evaluation runs
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

// Streams newline-delimited JSON events: tool steps as they happen, then the answer.
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allowed(ip)) return Response.json({ error: "Too many questions in 10 minutes; please wait a little." }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { asOf } = await resolveAsOf(parsed.data.asOf);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: CopilotEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const model = process.env.NODE_ENV === "production" ? undefined : parsed.data.model;
        await runCopilot({ ...parsed.data, asOf, model }, emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

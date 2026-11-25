import { runTool, type ToolContext } from "@/lib/copilot/tools";

// Development only: run one copilot tool directly (no model) to test the tool layer.
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  const { name, args, asOf } = await req.json();
  const ctx: ToolContext = { asOf: asOf ?? "2025-04-20", proposals: [] };
  try {
    return Response.json({ ok: true, result: await runTool(name, args ?? {}, ctx) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

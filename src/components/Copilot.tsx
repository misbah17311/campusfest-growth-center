"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Proposal = Record<string, unknown> & { kind: "create_task" | "update_task" | "update_campaign" };
type Msg = {
  role: "user" | "assistant";
  content: string;
  steps?: string[];
  proposals?: { p: Proposal; state: "pending" | "confirmed" | "dismissed" | "error"; note?: string }[];
  meta?: string;
  error?: boolean;
};

const STARTERS = [
  "Why did we miss the visitor goal, and where did people drop out?",
  "Which campaigns should we scale, change or stop, and why?",
  "As of 15 March, are we on track for the registration goal?",
  "If we move ₹50,000 from Paid Social to Student Referrals, what happens?",
  "Which Pune colleges did our visitors come from?",
];
const STORE = "cf-copilot-v1";


function ProposalCard({ p }: { p: Proposal }) {
  const rows: [string, unknown][] =
    p.kind === "create_task"
      ? [["Task", p.title], ["Owner", p.owner_name ?? p.owner_id ?? "Unassigned"], ["Due", p.due_date ?? "—"],
         ["Priority", p.priority], ["Campaign", p.campaign_id ?? "—"], ["Why", p.evidence]]
      : p.kind === "update_task"
        ? [["Task", `#${p.task_id} ${p.title}`], ["Status", p.status ?? "unchanged"], ["Owner", p.owner_id === undefined ? "unchanged" : (p.owner_name ?? p.owner_id)],
           ["Due", p.due_date === undefined ? "unchanged" : p.due_date], ["Why", p.reason]]
        : [["Campaign", p.campaign_name], ["Status", p.status ?? "unchanged"],
           ["Planned budget", p.planned_budget_inr === undefined ? "unchanged" : `₹${Number(p.planned_budget_inr).toLocaleString("en-IN")}`], ["Why", p.reason]];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (<Fragment key={k}><dt className="text-ink-2">{k}</dt><dd className="text-ink">{String(v)}</dd></Fragment>))}
    </dl>
  );
}

export function Copilot() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string[]>([]);
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const endRef = useRef<HTMLDivElement>(null);
  const asOf = params.get("asof") ?? undefined;

  useEffect(() => {
    try { const s = localStorage.getItem(STORE); if (s) setMsgs(JSON.parse(s)); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(msgs.slice(-30))); } catch { /* ignore */ }
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, live]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: q }]);
    setInput("");
    setBusy(true);
    setLive([]);
    const steps: string[] = [];
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, history, asOf, page: pathname }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
        throw new Error(err.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "tool") { steps.push(ev.summary); setLive([...steps]); }
          if (ev.type === "answer") {
            setMsgs((m) => [...m, { role: "assistant", content: ev.text, steps: [...steps],
              proposals: (ev.proposals as Proposal[]).map((p) => ({ p, state: "pending" as const })),
              meta: `${ev.steps} step${ev.steps === 1 ? "" : "s"} · ${ev.model.split("/").pop()}` }]);
          }
          if (ev.type === "error") throw new Error(ev.message);
        }
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `Sorry, that failed: ${e instanceof Error ? e.message : String(e)}`, error: true }]);
    } finally {
      setBusy(false);
      setLive([]);
    }
  }

  async function decide(mi: number, pi: number, confirm: boolean) {
    const target = msgs[mi].proposals![pi];
    if (!confirm) {
      setMsgs((m) => m.map((x, i) => i !== mi ? x : { ...x, proposals: x.proposals!.map((y, j) => j !== pi ? y : { ...y, state: "dismissed" }) }));
      return;
    }
    const res = await fetch("/api/copilot/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target.p) });
    const out = await res.json().catch(() => ({ ok: false, message: "Failed" }));
    setMsgs((m) => m.map((x, i) => i !== mi ? x : { ...x, proposals: x.proposals!.map((y, j) => j !== pi ? y : { ...y, state: out.ok ? "confirmed" : "error", note: out.message }) }));
    if (out.ok) router.refresh();
  }

  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}
                className="fixed bottom-5 right-5 z-40 rounded-full bg-ink px-4 py-2.5 text-sm text-surface shadow-lg">
          Ask the growth copilot
        </button>
      )}
      {open && (
        <aside aria-label="Growth copilot" className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-2xl sm:w-[440px]">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Growth copilot</div>
              <div className="text-xs text-ink-2">Answers from live data as of {asOf ?? "the latest day"}. Changes need your confirmation.</div>
            </div>
            <div className="flex gap-3 text-xs">
              <button type="button" className="text-ink-2 underline" onClick={() => setMsgs([])}>New chat</button>
              <button type="button" className="text-ink-2" aria-label="Close copilot" onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-ink-2">Ask about performance, problems, budgets or tasks. Try:</p>
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => ask(s)}
                          className="block w-full rounded-md border border-line px-3 py-2 text-left text-xs text-ink hover:bg-grid">{s}</button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "ml-8 rounded-lg bg-grid px-3 py-2" : ""}>
                {m.role === "assistant" ? (
                  <div className="prose-copilot">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : m.content}
                {m.steps && m.steps.length > 0 && (
                  <details className="mt-2 text-xs text-ink-2">
                    <summary className="cursor-pointer">How I got this ({m.steps.length} data step{m.steps.length === 1 ? "" : "s"}{m.meta ? ` · ${m.meta}` : ""})</summary>
                    <ol className="mt-1 list-inside list-decimal space-y-0.5">{m.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
                  </details>
                )}
                {m.proposals?.map((pr, j) => (
                  <div key={j} className="mt-3 rounded-lg border border-line p-3">
                    <div className="mb-2 text-xs font-semibold">
                      {pr.p.kind === "create_task" ? "Proposed task" : pr.p.kind === "update_task" ? "Proposed task change" : "Proposed campaign change"}
                      <span className="ml-1 font-normal text-ink-2">(not saved until you confirm)</span>
                    </div>
                    <ProposalCard p={pr.p} />
                    {pr.state === "pending" ? (
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={() => decide(i, j, true)} className="rounded-md bg-ink px-3 py-1 text-xs text-surface">Confirm</button>
                        <button type="button" onClick={() => decide(i, j, false)} className="rounded-md border border-line px-3 py-1 text-xs">Dismiss</button>
                      </div>
                    ) : (
                      <div role="status" className="mt-2 text-xs">
                        <span aria-hidden className="mr-1 font-bold" style={{ color: pr.state === "confirmed" ? "var(--good)" : pr.state === "error" ? "var(--critical)" : "var(--muted)" }}>
                          {pr.state === "confirmed" ? "✓" : pr.state === "error" ? "✕" : "–"}</span>
                        {pr.state === "dismissed" ? "Dismissed" : pr.note}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {busy && (
              <div className="text-xs text-ink-2" role="status">
                <div>Working…</div>
                <ol className="mt-1 list-inside list-decimal space-y-0.5">{live.map((s, j) => <li key={j}>{s}</li>)}</ol>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} maxLength={2000}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
                      placeholder="Ask a question (Enter to send, Shift+Enter for a new line)"
                      className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink" />
            <div className="mt-1 flex justify-between text-xs text-muted">
              <span>Numbers come from the data via tools; check “How I got this”.</span>
              <button type="submit" disabled={busy || !input.trim()} className="rounded-md bg-ink px-3 py-1 text-surface disabled:opacity-40">Send</button>
            </div>
          </form>
        </aside>
      )}
    </>
  );
}

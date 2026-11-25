"use client";

import { useActionState, type ReactNode } from "react";
import type { ActionResult } from "@/app/actions";

// A form bound to a server action that returns { ok, message }; shows the
// result next to the submit button so every save is confirmed or explained.
export function ActionForm({ action, children, submitLabel, className = "" }: {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending}
                className="rounded-md bg-ink px-3 py-1.5 text-sm text-surface disabled:opacity-50">
          {pending ? "Saving…" : submitLabel}
        </button>
        {state && (
          <span role="status" className="text-xs text-ink">
            <span aria-hidden className="mr-1 font-bold" style={{ color: state.ok ? "var(--good)" : "var(--critical)" }}>
              {state.ok ? "✓" : "✕"}
            </span>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}

export const inputCls = "w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink";
export const labelCls = "flex flex-col gap-1 text-xs text-ink-2";

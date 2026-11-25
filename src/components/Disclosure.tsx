"use client";

import { useState, type ReactNode } from "react";

// A collapsible section whose open state lives in React (not only in the DOM),
// so it stays open across the refresh that follows a save and the save
// confirmation inside it remains visible.
export function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-sm font-medium text-ink">
        <span aria-hidden className="mr-1.5 inline-block w-3">{open ? "▾" : "▸"}</span>{label}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

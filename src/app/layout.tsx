import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import "./globals.css";
import { HeaderControls } from "@/components/HeaderControls";
import { Copilot } from "@/components/Copilot";
import { getEvent } from "@/lib/asof";
import { dataDiffersFromOriginal } from "@/lib/metrics";

export const metadata: Metadata = {
  title: "CampusFest Growth Center",
  description: "Attendee growth command centre: funnel analytics, campaign and task management, and an AI growth analyst.",
};

async function Controls() {
  await connection(); // request time only: never read the database during the build
  const e = await getEvent();
  return <HeaderControls min={e.history_start} max={e.history_end} />;
}

async function ModifiedBanner() {
  await connection();
  if (!(await dataDiffersFromOriginal())) return null;
  return (
    <div role="status" className="border-b border-line bg-surface px-6 py-2 text-sm text-ink">
      <span aria-hidden className="mr-1.5 font-bold" style={{ color: "var(--warning)" }}>!</span>
      The working data differs from the original workbook (someone has edited it). Every number below reflects the
      edits. See <Link className="underline" href="/execute#changes">Execute → Change log</Link> to review or reset.
    </div>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-4">
            <div className="flex items-baseline justify-between gap-4">
              <Link href="/" className="text-lg font-semibold text-ink">CampusFest Growth Center</Link>
              <span className="text-xs text-muted">Attendee growth · replaying the 2025 campaign data</span>
            </div>
            <Suspense fallback={<div className="h-16" />}>
              <Controls />
            </Suspense>
          </div>
        </header>
        <Suspense fallback={null}>
          <ModifiedBanner />
        </Suspense>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">{children}</main>
        <Suspense fallback={null}>
          <Copilot />
        </Suspense>
      </body>
    </html>
  );
}

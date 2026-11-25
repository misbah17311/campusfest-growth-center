// Server-rendered heatmap as an HTML table: the table IS the accessible view,
// colour only reinforces the printed numbers, and each cell has a title tooltip.

const BLUE = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
const ORANGE = ["#fde3d6", "#fbd0bb", "#f8bd9f", "#f5a983", "#f19467", "#ee804c", "#eb6834", "#d95926", "#c24d1f", "#a8421b", "#8e3817", "#752e13", "#5c240f"];

export function sequentialColor(value: number | null, max: number, hue: "blue" | "orange" = "blue") {
  if (value == null || max <= 0 || value <= 0) return { bg: "transparent", fg: "var(--ink-2)" };
  const ramp = hue === "blue" ? BLUE : ORANGE;
  const i = Math.min(ramp.length - 1, Math.round((value / max) * (ramp.length - 1)));
  return { bg: ramp[i], fg: i >= 7 ? "#ffffff" : "#0b0b0b" };
}

// Diverging: blue = better than the reference, red = worse, gray = about the same.
const DIV_POS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf"];
const DIV_NEG = ["#fbdada", "#f5b3b2", "#ee8a89", "#e34948", "#c23a39"];
export function divergingColor(delta: number | null, scale: number) {
  if (delta == null || !Number.isFinite(delta)) return { bg: "transparent", fg: "var(--ink-2)" };
  const t = Math.min(1, Math.abs(delta) / scale);
  if (t < 0.1) return { bg: "var(--mid)", fg: "var(--ink)" };
  const i = Math.min(4, Math.floor(t * 5));
  return delta > 0 ? { bg: DIV_POS[i], fg: i >= 3 ? "#ffffff" : "#0b0b0b" } : { bg: DIV_NEG[i], fg: i >= 3 ? "#ffffff" : "#0b0b0b" };
}

export function HeatCell({ text, bg, fg, title }: { text: string; bg: string; fg: string; title: string }) {
  return (
    <td title={title} className="num border-2 border-surface px-1.5 py-1 text-center text-xs" style={{ background: bg, color: fg }}>
      {text}
    </td>
  );
}

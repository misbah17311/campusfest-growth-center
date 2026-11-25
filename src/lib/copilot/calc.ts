// A small, safe arithmetic evaluator for the copilot's `calculate` tool.
// Supports numbers, + - * / ^, parentheses, unary minus, and the functions
// min, max, round(x, digits), abs, sqrt. No variables and no code execution:
// it is a recursive-descent parser, never eval().

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "id"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const s = src; // numbers must be written without thousands separators (commas separate function arguments)
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.eE]/.test(s[j])) {
        if ((s[j] === "e" || s[j] === "E") && /[+-]/.test(s[j + 1] ?? "")) j++;
        j++;
      }
      const v = Number(s.slice(i, j));
      if (!Number.isFinite(v)) throw new Error(`Bad number "${s.slice(i, j)}"`);
      out.push({ t: "num", v });
      i = j;
      continue;
    }
    if (/[a-z]/i.test(c)) {
      let j = i;
      while (j < s.length && /[a-z]/i.test(s[j])) j++;
      out.push({ t: "id", v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/^(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  round: (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
};

export function calculate(expression: string): number {
  if (expression.length > 500) throw new Error("Expression too long");
  const toks = tokenize(expression);
  let p = 0;
  const peek = () => toks[p];
  const take = (v?: string) => {
    const tok = toks[p];
    if (!tok || (v && tok.v !== v)) throw new Error(`Expected "${v ?? "a value"}"`);
    p++;
    return tok;
  };
  const expr = (): number => {
    let v = term();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) v = take().v === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = take().v;
      const r = power();
      if (op === "/" && r === 0) throw new Error("Division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const power = (): number => {
    const b = unary();
    if (peek()?.t === "op" && peek().v === "^") { take(); return b ** power(); }
    return b;
  };
  const unary = (): number => {
    if (peek()?.t === "op" && peek().v === "-") { take(); return -unary(); }
    if (peek()?.t === "op" && peek().v === "+") { take(); return unary(); }
    return atom();
  };
  const atom = (): number => {
    const tok = peek();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.t === "num") { p++; return tok.v; }
    if (tok.t === "id") {
      const f = FUNCS[tok.v];
      if (!f) throw new Error(`Unknown function "${tok.v}"`);
      p++;
      take("(");
      const args = [expr()];
      while (peek()?.v === ",") { take(","); args.push(expr()); }
      take(")");
      return f(...args);
    }
    if (tok.v === "(") { take("("); const v = expr(); take(")"); return v; }
    throw new Error(`Unexpected "${tok.v}"`);
  };
  const v = expr();
  if (p !== toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  if (!Number.isFinite(v)) throw new Error("Result is not a finite number");
  return v;
}

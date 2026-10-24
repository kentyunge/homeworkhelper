import { compile, parse, type EvalFunction, type MathNode } from "mathjs";

/**
 * Checks whether one line of a student's math follows from the line before it, without AI.
 *
 * Two equations "follow" when they have the same solutions. We test that numerically: an equation
 * A = B becomes f = A − B, and the next line's g must be a constant multiple of f (moving terms,
 * distributing, dividing both sides by 2 all keep that true). For one-variable linear equations we
 * also compare the solution directly. Two expressions follow when they're equal everywhere.
 *
 * The answer is "same", "different", or "unknown". Unknown (inequalities, word problems, square roots
 * on both sides, anything we can't read) goes to the tutor instead; we never guess.
 */
export type Verdict = "same" | "different" | "unknown";

type Parsed = { kind: "equation"; f: EvalFunction; vars: string[]; lhs: string; rhs: string } | { kind: "expression"; f: EvalFunction; vars: string[] };

const FUNCTIONS = ["sqrt", "nthRoot", "abs"];
const CONSTANTS = ["pi"];

/** Turn the reader's LaTeX into math.js syntax, or null if it uses something we don't handle. */
export function latexToMath(latex: string): string | null {
  let s = latex.trim();
  if (!s) return null;
  s = s
    .replace(/\\left|\\right|\\displaystyle/g, "")
    .replace(/\\[,;:! ]|\\quad|\\qquad|~/g, " ")
    .replace(/\\cdot|\\times|×|·/g, "*")
    .replace(/\\div|÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\\pi/g, "pi")
    .replace(/\\\{|\\\}/g, "");
  // \frac{a}{b}, innermost first.
  for (let i = 0; i < 20 && /\\[dt]?frac/.test(s); i++) {
    const before = s;
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "(($1)/($2))");
    if (s === before) return null;
  }
  for (let i = 0; i < 20 && /\\sqrt/.test(s); i++) {
    const before = s;
    s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, "nthRoot(($2),($1))").replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)");
    if (s === before) return null;
  }
  s = s.replace(/\{/g, "(").replace(/\}/g, ")");
  if (/\\|[<>≤≥≠]|\bto\b/.test(s)) return null; // inequalities, \text, other commands
  if (/[^0-9a-zA-Z+\-*/^().=, ]/.test(s)) return null;
  // Implicit multiplication math.js reads differently: "2xy" -> "2x*y", "x(x+1)" -> "x*(x+1)".
  const keep: string[] = [];
  s = s.replace(new RegExp(`\\b(${[...FUNCTIONS, ...CONSTANTS].join("|")})\\b`, "g"), (m) => {
    keep.push(m);
    return `\u0000${keep.length - 1}\u0000`;
  });
  s = s.replace(/([a-zA-Z])(?=[a-zA-Z])/g, "$1*");
  s = s.replace(/([a-zA-Z0-9)])\s*\(/g, "$1*(");
  s = s.replace(/\u0000(\d+)\u0000\*?/g, (_m, i) => keep[Number(i)]);
  return s;
}

function variables(node: MathNode): string[] | null {
  const names = new Set<string>();
  let bad = false;
  node.traverse((n: MathNode, _path: string, parent: MathNode | null) => {
    if (n.type !== "SymbolNode") return;
    const name = (n as unknown as { name: string }).name;
    const isCall = parent?.type === "FunctionNode" && (parent as unknown as { fn: unknown }).fn === n;
    if (isCall) {
      if (!FUNCTIONS.includes(name)) bad = true;
    } else if (CONSTANTS.includes(name)) {
      // fine
    } else if (/^[a-zA-Z]$/.test(name)) names.add(name);
    else bad = true;
  });
  return bad ? null : [...names].sort();
}

export function parseLine(latex: string): Parsed | null {
  const s = latexToMath(latex);
  if (!s) return null;
  const parts = s.split("=");
  try {
    if (parts.length === 1) {
      const node = parse(parts[0]);
      const vars = variables(node);
      return vars ? { kind: "expression", f: compile(parts[0]), vars } : null;
    }
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      const expr = `(${parts[0]})-(${parts[1]})`;
      const vars = variables(parse(expr));
      return vars ? { kind: "equation", f: compile(expr), vars, lhs: parts[0].trim(), rhs: parts[1].trim() } : null;
    }
  } catch {
    return null;
  }
  return null; // "a = b = c" chains and the like
}

/** Fixed, awkward sample points, so results are repeatable and unlikely to hit special values. */
const SAMPLES = [-3.71, -1.29, 0.57, 1.83, 2.41, 4.93, 7.17, 11.31, -6.13, 0.23];

function evaluate(p: Parsed, vars: string[], k: number): number | null {
  const scope: Record<string, number> = {};
  vars.forEach((v, j) => (scope[v] = SAMPLES[(k + 3 * j) % SAMPLES.length] + j * 0.37));
  try {
    const v = p.f.evaluate(scope);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

const close = (a: number, b: number, tol = 1e-7) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/** Fit f(x) = m*x + c through sampled points; null if f isn't linear in its one variable. */
function linear(p: Parsed): { m: number; c: number } | null {
  if (p.vars.length !== 1) return null;
  const pts: [number, number][] = [];
  for (let k = 0; k < SAMPLES.length; k++) {
    const y = evaluate(p, p.vars, k);
    if (y !== null) pts.push([SAMPLES[k], y]);
  }
  if (pts.length < 4) return null;
  const [[x0, y0], [x1, y1]] = pts;
  const m = (y1 - y0) / (x1 - x0);
  const c = y0 - m * x0;
  return pts.every(([x, y]) => close(y, m * x + c, 1e-6)) ? { m, c } : null;
}

export function compareLines(prevLatex: string, nextLatex: string): Verdict {
  const a = parseLine(prevLatex);
  const b = parseLine(nextLatex);
  if (!a || !b || a.kind !== b.kind) return "unknown";
  const vars = [...new Set([...a.vars, ...b.vars])].sort();
  const pairs: [number, number][] = [];
  for (let k = 0; k < SAMPLES.length; k++) {
    const va = evaluate(a, vars, k);
    const vb = evaluate(b, vars, k);
    if (va !== null && vb !== null) pairs.push([va, vb]);
  }
  if (pairs.length < 5) return "unknown";

  if (a.kind === "expression") {
    if (pairs.every(([x, y]) => close(x, y))) return "same";
    // Very nearly equal (rounding, e.g. 0.33 for 1/3): let the tutor judge.
    if (pairs.every(([x, y]) => close(x, y, 0.01))) return "unknown";
    return "different";
  }

  // Equations: g must be a nonzero constant multiple of f.
  const scale = Math.max(1, ...pairs.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
  const tiny = 1e-9 * scale;
  const nonzero = pairs.filter(([x]) => Math.abs(x) > tiny);
  if (nonzero.length === 0) {
    // f is 0 everywhere (an identity like 0 = 0); g must be too.
    return pairs.every(([, y]) => Math.abs(y) <= tiny) ? "same" : "unknown";
  }
  // A line with no variable left (like "1 = 2" or "0 = 0") means no solution or every solution:
  // worth a word from the tutor rather than a quiet check mark.
  const constant = (i: 0 | 1) => pairs.every((p) => close(p[i], pairs[0][i], 1e-9));
  if (constant(0) || constant(1)) return "unknown";
  const r0 = nonzero[0][1] / nonzero[0][0];
  if (Math.abs(r0) > 1e-12 && pairs.every(([x, y]) => close(y, r0 * x, 1e-7))) return "same";

  // One-variable linear equations have one solution each: compare them.
  const la = linear(a);
  const lb = linear(b);
  if (la && lb && vars.length === 1) {
    if (Math.abs(la.m) < 1e-12 || Math.abs(lb.m) < 1e-12) return "unknown"; // "no solution" cases: tutor
    const ra = -la.c / la.m;
    const rb = -lb.c / lb.m;
    if (close(ra, rb)) return "same";
    if (close(ra, rb, 0.01)) return "unknown"; // rounding
    return "different";
  }
  return "unknown";
}

/** "x = 5" (or "5 = x"): the line gives a value for its one variable. */
export function isSolutionLine(latex: string): boolean {
  const p = parseLine(latex);
  if (!p || p.kind !== "equation" || p.vars.length !== 1) return false;
  const v = p.vars[0];
  const constant = (side: string) => {
    try {
      const n = parse(side);
      return variables(n)?.length === 0;
    } catch {
      return false;
    }
  };
  return (p.lhs === v && constant(p.rhs)) || (p.rhs === v && constant(p.lhs));
}

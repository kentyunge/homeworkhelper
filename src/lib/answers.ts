import { evaluate } from "mathjs";

/** Normalize a typed answer: lowercase, no spaces, unicode minus to "-", drop a leading "x =". */
function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^[a-z]=/, "")
    .replace(/\$/g, "");
}

function numeric(s: string): number | null {
  if (!/^[0-9+\-*/().^]+$/.test(s)) return null;
  try {
    const v = evaluate(s);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Is the student's answer to a practice problem the same as the expected one? "0.5", "1/2" and "x = 1/2" all match "1/2". */
export function sameAnswer(given: string, expected: string): boolean {
  const g = normalize(given);
  const e = normalize(expected);
  if (!g) return false;
  if (g === e) return true;
  const gn = numeric(g);
  const en = numeric(e);
  return gn !== null && en !== null && Math.abs(gn - en) < 1e-9 * Math.max(1, Math.abs(en));
}

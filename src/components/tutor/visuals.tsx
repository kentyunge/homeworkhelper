"use client";

import { useMemo } from "react";
import { compile } from "mathjs";
import type { TutorBlock } from "@/lib/tutor-reply";

type NumberLine = Extract<TutorBlock, { type: "numberLine" }>;
type FractionBars = Extract<TutorBlock, { type: "fractionBars" }>;
type Graph = Extract<TutorBlock, { type: "graph" }>;

const COLORS = ["oklch(0.82 0.14 205)", "oklch(0.8 0.16 80)", "oklch(0.75 0.18 330)", "oklch(0.78 0.16 155)"];

function ticks(min: number, max: number, target = 10) {
  const span = max - min || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function NumberLineView({ block }: { block: NumberLine }) {
  const W = 600;
  const pad = 30;
  const min = Math.min(block.min, block.max);
  const max = Math.max(block.min, block.max, min + 1);
  const x = (v: number) => pad + ((v - min) / (max - min)) * (W - 2 * pad);
  const y = 70;
  return (
    <svg viewBox={`0 0 ${W} 110`} className="w-full" role="img" aria-label="Number line">
      <defs>
        <marker id="nl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="currentColor" />
        </marker>
        <marker id="nl-jump" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill={COLORS[1]} />
        </marker>
      </defs>
      <line x1={pad - 18} x2={W - pad + 18} y1={y} y2={y} stroke="currentColor" strokeWidth={2} markerStart="url(#nl-arrow)" markerEnd="url(#nl-arrow)" className="text-muted-foreground" />
      {ticks(min, max, 12).map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={y - 6} y2={y + 6} stroke="currentColor" className="text-muted-foreground" />
          <text x={x(t)} y={y + 24} textAnchor="middle" fontSize={14} fill="currentColor" className="text-muted-foreground">
            {t}
          </text>
        </g>
      ))}
      {block.segments.map((s, i) => {
        const x1 = x(s.from);
        const x2 = x(s.to);
        const mid = (x1 + x2) / 2;
        return (
          <g key={`s${i}`}>
            <path d={`M${x1} ${y - 4} Q${mid} ${y - 50} ${x2} ${y - 4}`} fill="none" stroke={COLORS[1]} strokeWidth={2.5} markerEnd="url(#nl-jump)" />
            <text x={mid} y={y - 34} textAnchor="middle" fontSize={15} fontWeight={600} fill={COLORS[1]}>
              {s.label}
            </text>
          </g>
        );
      })}
      {block.points.map((p, i) => (
        <g key={`p${i}`}>
          <circle cx={x(p.value)} cy={y} r={7} fill={COLORS[0]} />
          <text x={x(p.value)} y={y + 42} textAnchor="middle" fontSize={13} fontWeight={600} fill={COLORS[0]}>
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function FractionBarsView({ block }: { block: FractionBars }) {
  return (
    <div className="space-y-3">
      {block.bars.map((b, i) => {
        const d = Math.max(1, Math.min(48, Math.abs(b.denominator)));
        const n = Math.max(0, Math.min(d * 3, b.numerator));
        const wholes = Math.max(1, Math.ceil(n / d));
        return (
          <div key={i} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-right font-mono text-sm font-semibold" style={{ color: COLORS[i % COLORS.length] }}>
              {b.label}
            </span>
            <div className="flex flex-1 gap-1.5">
              {Array.from({ length: wholes }, (_, w) => (
                <div key={w} className="border-border flex h-9 flex-1 overflow-hidden rounded-md border">
                  {Array.from({ length: d }, (_, k) => {
                    const filled = w * d + k < n;
                    return (
                      <div
                        key={k}
                        className="border-background/60 flex-1 border-r last:border-r-0"
                        style={{ background: filled ? COLORS[i % COLORS.length] : "transparent", opacity: filled ? 0.85 : 1 }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function GraphView({ block }: { block: Graph }) {
  const W = 560;
  const H = 400;
  const pad = 34;
  const xMin = Math.min(block.xMin, block.xMax);
  const xMax = Math.max(block.xMax, xMin + 1);
  const yMin = Math.min(block.yMin, block.yMax);
  const yMax = Math.max(block.yMax, yMin + 1);
  const sx = (v: number) => pad + ((v - xMin) / (xMax - xMin)) * (W - 2 * pad);
  const sy = (v: number) => H - pad - ((v - yMin) / (yMax - yMin)) * (H - 2 * pad);

  const paths = useMemo(
    () =>
      block.functions.map((f) => {
        try {
          const fn = compile(f.expression);
          const segs: string[] = [];
          let pen = false;
          const N = 400;
          for (let i = 0; i <= N; i++) {
            const xv = xMin + ((xMax - xMin) * i) / N;
            const yv = Number(fn.evaluate({ x: xv }));
            if (!Number.isFinite(yv) || yv < yMin - (yMax - yMin) || yv > yMax + (yMax - yMin)) {
              pen = false;
              continue;
            }
            segs.push(`${pen ? "L" : "M"}${sx(xv).toFixed(1)} ${sy(yv).toFixed(1)}`);
            pen = true;
          }
          return { d: segs.join(""), ok: true };
        } catch {
          return { d: "", ok: false };
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block],
  );

  const xt = ticks(xMin, xMax);
  const yt = ticks(yMin, yMax);
  const x0 = xMin <= 0 && xMax >= 0 ? sx(0) : null;
  const y0 = yMin <= 0 && yMax >= 0 ? sy(0) : null;

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Graph">
        <defs>
          <clipPath id="plot">
            <rect x={pad} y={pad} width={W - 2 * pad} height={H - 2 * pad} />
          </clipPath>
        </defs>
        {xt.map((t) => (
          <line key={`gx${t}`} x1={sx(t)} x2={sx(t)} y1={pad} y2={H - pad} stroke="currentColor" className="text-border" />
        ))}
        {yt.map((t) => (
          <line key={`gy${t}`} y1={sy(t)} y2={sy(t)} x1={pad} x2={W - pad} stroke="currentColor" className="text-border" />
        ))}
        {x0 !== null && <line x1={x0} x2={x0} y1={pad} y2={H - pad} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />}
        {y0 !== null && <line y1={y0} y2={y0} x1={pad} x2={W - pad} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />}
        {xt.map((t) => (
          <text key={`lx${t}`} x={sx(t)} y={(y0 ?? H - pad) + 16} textAnchor="middle" fontSize={12} fill="currentColor" className="text-muted-foreground">
            {t === 0 ? "" : t}
          </text>
        ))}
        {yt.map((t) => (
          <text key={`ly${t}`} x={(x0 ?? pad) - 6} y={sy(t) + 4} textAnchor="end" fontSize={12} fill="currentColor" className="text-muted-foreground">
            {t === 0 ? "" : t}
          </text>
        ))}
        <g clipPath="url(#plot)">
          {paths.map((p, i) => (
            <path key={i} d={p.d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={3} strokeLinecap="round" />
          ))}
          {block.points.map((p, i) => (
            <g key={`pt${i}`}>
              <circle cx={sx(p.x)} cy={sy(p.y)} r={6} fill="white" stroke={COLORS[0]} strokeWidth={3} />
              <text x={sx(p.x) + 10} y={sy(p.y) - 10} fontSize={13} fontWeight={600} fill="white">
                {p.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {block.functions.map((f, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="inline-block h-1 w-5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="font-mono">y = {f.expression}</span>
            {f.label && <span className="text-muted-foreground">({f.label})</span>}
            {!paths[i]?.ok && <span className="text-destructive">couldn&apos;t draw</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

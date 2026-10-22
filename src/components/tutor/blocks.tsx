"use client";

import { useState } from "react";
import { Check, ChevronRight, CircleAlert, Eye, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sameAnswer } from "@/lib/answers";
import type { TutorBlock } from "@/lib/tutor-reply";
import { cn } from "@/lib/utils";
import { Markdown, TeX } from "./markdown";
import { FractionBarsView, GraphView, NumberLineView } from "./visuals";

function Panel({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("bg-card/70 border-border rounded-xl border p-4 backdrop-blur", className)}>
      {title && <p className="text-glow mb-3 text-xs font-semibold tracking-widest uppercase">{title}</p>}
      {children}
    </div>
  );
}

function Steps({ block }: { block: Extract<TutorBlock, { type: "steps" }> }) {
  const [shown, setShown] = useState(block.revealOneAtATime ? 1 : block.steps.length);
  const done = shown >= block.steps.length;
  return (
    <Panel title={block.title}>
      <ol className="space-y-3">
        {block.steps.slice(0, shown).map((s, i) => (
          <li key={i} className="animate-in fade-in slide-in-from-bottom-1 flex gap-3">
            <span className="bg-primary/15 text-primary flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1">
              {s.math && <TeX math={s.math} display />}
              <Markdown className="text-muted-foreground text-sm">{s.note}</Markdown>
            </div>
          </li>
        ))}
      </ol>
      {block.revealOneAtATime && (
        <div className="mt-3 flex gap-2">
          {!done ? (
            <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + 1)}>
              What&apos;s next? <ChevronRight />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setShown(1)}>
              <RotateCcw /> Start over
            </Button>
          )}
          {!done && <span className="text-muted-foreground self-center text-xs">Guess the next step before you tap.</span>}
        </div>
      )}
    </Panel>
  );
}

function Practice({ block }: { block: Extract<TutorBlock, { type: "practice" }> }) {
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<null | boolean>(null);
  const [tries, setTries] = useState(0);
  const [revealed, setRevealed] = useState(false);

  function check(e: React.FormEvent) {
    e.preventDefault();
    const ok = sameAnswer(answer, block.answer);
    setResult(ok);
    setTries((t) => t + 1);
  }

  return (
    <Panel title="Your turn">
      <Markdown>{block.prompt}</Markdown>
      <form onSubmit={check} className="mt-3 flex gap-2">
        <Input
          value={answer}
          onChange={(e) => {
            setAnswer(e.target.value);
            setResult(null);
          }}
          placeholder="Your answer"
          className="max-w-48 font-mono"
          aria-label="Your answer"
        />
        <Button type="submit" disabled={!answer.trim()}>
          Check
        </Button>
      </form>
      {result === true && (
        <div className="text-ok mt-3 space-y-2">
          <p className="flex items-center gap-1.5 font-semibold">
            <Check className="size-4" /> That&apos;s it!
          </p>
          <Markdown className="text-muted-foreground text-sm">{block.explanation}</Markdown>
        </div>
      )}
      {result === false && (
        <p className="text-warn mt-3 flex items-center gap-1.5 text-sm">
          <CircleAlert className="size-4" /> Not quite. Check your steps and try again{tries >= 2 ? ", or ask for a hint" : ""}.
        </p>
      )}
      {tries >= 3 && result !== true && !revealed && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setRevealed(true)}>
          <Eye /> Show the solution
        </Button>
      )}
      {revealed && result !== true && (
        <div className="mt-2 text-sm">
          <Markdown className="text-muted-foreground">{`**Answer:** ${block.answer}\n\n${block.explanation}`}</Markdown>
        </div>
      )}
    </Panel>
  );
}

function WorkReview({ block }: { block: Extract<TutorBlock, { type: "workReview" }> }) {
  return (
    <Panel title="Your work">
      <ol className="space-y-2">
        {block.lines.map((l, i) => (
          <li
            key={i}
            className={cn(
              "rounded-lg border px-3 py-2",
              l.status === "ok" && "border-ok/30 bg-ok/5",
              l.status === "look_here" && "border-warn/60 bg-warn/10 ring-warn/30 ring-2",
              l.status === "not_checked" && "border-border opacity-60",
            )}
          >
            <div className="flex items-center gap-2">
              {l.status === "ok" && <Check className="text-ok size-4 shrink-0" aria-label="Looks right" />}
              {l.status === "look_here" && <CircleAlert className="text-warn size-4 shrink-0" aria-label="Look here" />}
              {l.status === "not_checked" && <span className="size-4 shrink-0" />}
              <div className="min-w-0 flex-1 overflow-x-auto">
                <TeX math={l.math} />
              </div>
            </div>
            {l.note && <p className={cn("mt-1 pl-6 text-sm", l.status === "look_here" ? "text-warn" : "text-muted-foreground")}>{l.note}</p>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function TutorBlocks({ blocks }: { blocks: TutorBlock[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return (
              <Panel key={i}>
                <Markdown>{b.markdown}</Markdown>
              </Panel>
            );
          case "steps":
            return <Steps key={i} block={b} />;
          case "practice":
            return <Practice key={i} block={b} />;
          case "numberLine":
            return (
              <Panel key={i} title="Number line">
                <NumberLineView block={b} />
              </Panel>
            );
          case "fractionBars":
            return (
              <Panel key={i} title="Fraction bars">
                <FractionBarsView block={b} />
              </Panel>
            );
          case "graph":
            return (
              <Panel key={i} title="Graph">
                <GraphView block={b} />
              </Panel>
            );
          case "workReview":
            return <WorkReview key={i} block={b} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

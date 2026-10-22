import { cn } from "@/lib/utils";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

/** The assistant's on-screen presence. Pulses while listening, swirls while thinking, bounces while talking. */
export function Orb({ state, size = 56, className }: { state: OrbState; size?: number; className?: string }) {
  return (
    <div
      className={cn("orb relative shrink-0", className)}
      data-state={state}
      style={{ width: size, height: size }}
      role="img"
      aria-label={state === "idle" ? "Assistant" : `Assistant is ${state}`}
    >
      <div className="orb-ring border-glow/60 absolute inset-0 rounded-full border-2 opacity-0" />
      <div className="orb-core absolute inset-0 rounded-full" />
      <div
        className="orb-swirl absolute inset-[18%] rounded-full opacity-70"
        style={{ background: "conic-gradient(from 0deg, transparent 0 60%, oklch(0.97 0.05 200 / 70%) 75%, transparent 90%)" }}
      />
    </div>
  );
}

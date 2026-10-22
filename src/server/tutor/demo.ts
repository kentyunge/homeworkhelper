import type { TutorReply } from "@/lib/tutor-reply";
import type { TutorEngine, TutorResult } from "./engine";

/**
 * Canned replies used when ANTHROPIC_API_KEY isn't set, so the app can be clicked through
 * (and every visual tool previewed) before connecting Claude.
 */
const SCRIPT: TutorReply[] = [
  {
    say: "Demo mode here. I'm not connected to Claude yet, but I can show you how I'll help. Here's a problem like the one I'd read from your photo. Did I get it right?",
    title: "Two-step equations (demo)",
    hintLevel: 0,
    show: [
      {
        type: "text",
        markdown:
          "**Here's what I see:**\n\n$$3(x - 4) = 2x + 5$$\n\nIs that the problem you're working on? And what have you tried so far?",
      },
    ],
  },
  {
    say: "Good start. What's the very first thing you'd do with that three outside the parentheses?",
    title: null,
    hintLevel: 1,
    show: [
      { type: "text", markdown: "The left side has $3(x-4)$. What does the $3$ do to **each** thing inside the parentheses?" },
    ],
  },
  {
    say: "Let's try one with different numbers together. Tap each step, but guess what comes next before you do.",
    title: null,
    hintLevel: 4,
    show: [
      {
        type: "steps",
        title: "A similar problem, worked through",
        revealOneAtATime: true,
        steps: [
          { math: "2(x + 3) = x + 10", note: "Start here." },
          { math: "2x + 6 = x + 10", note: "Distribute: the $2$ multiplies both $x$ and $3$." },
          { math: "x + 6 = 10", note: "Subtract $x$ from both sides to get the $x$'s together." },
          { math: "x = 4", note: "Subtract $6$ from both sides." },
        ],
      },
    ],
  },
  {
    say: "Here's a picture of what subtracting a negative looks like. Watch which way we move.",
    title: null,
    hintLevel: 2,
    show: [
      { type: "text", markdown: "$-2 - (-5)$ means: start at $-2$, then **undo** a move of $-5$, so we go **right** 5." },
      { type: "numberLine", min: -6, max: 6, points: [{ value: -2, label: "start" }, { value: 3, label: "end" }], segments: [{ from: -2, to: 3, label: "+5" }] },
    ],
  },
  {
    say: "Your turn. Try this practice problem and type your answer in the box.",
    title: null,
    hintLevel: 0,
    show: [
      {
        type: "practice",
        prompt: "Solve for $x$: $\\;4(x - 1) = 2x + 6$",
        answer: "5",
        explanation: "$4x - 4 = 2x + 6 \\Rightarrow 2x = 10 \\Rightarrow x = 5$",
      },
    ],
  },
  {
    say: "Here are both sides graphed as lines. Where they cross is where the two sides are equal.",
    title: null,
    hintLevel: 2,
    show: [
      {
        type: "graph",
        xMin: -2,
        xMax: 8,
        yMin: -4,
        yMax: 20,
        functions: [
          { expression: "4*(x - 1)", label: "left side" },
          { expression: "2*x + 6", label: "right side" },
        ],
        points: [{ x: 5, y: 16, label: "they meet here" }],
      },
    ],
  },
  {
    say: "Fractions are easier to compare when you can see them. Which bar is longer?",
    title: null,
    hintLevel: 2,
    show: [
      {
        type: "fractionBars",
        bars: [
          { numerator: 2, denominator: 3, label: "2/3" },
          { numerator: 3, denominator: 4, label: "3/4" },
        ],
      },
    ],
  },
  {
    say: "I checked your work. The first two lines look great. Take another look at line three.",
    title: null,
    hintLevel: 0,
    show: [
      {
        type: "workReview",
        lines: [
          { math: "3(x - 4) = 2x + 5", status: "ok", note: "" },
          { math: "3x - 12 = 2x + 5", status: "ok", note: "Nice distributing." },
          { math: "x - 12 = 5 \\Rightarrow x = -7", status: "look_here", note: "When you move the 12 to the other side, what happens to its sign?" },
          { math: "\\text{check: } 3(-11) = -9", status: "not_checked", note: "" },
        ],
      },
    ],
  },
];

export class DemoEngine implements TutorEngine {
  readonly demo = true;

  async reply(_system: string, messages: { role: string }[]): Promise<TutorResult> {
    const tutorTurns = messages.filter((m) => m.role === "assistant").length;
    const reply = SCRIPT[tutorTurns % SCRIPT.length];
    await new Promise((r) => setTimeout(r, 600)); // feel like a real reply
    return {
      reply,
      content: [{ type: "text", text: JSON.stringify(reply) }],
      usage: { model: "demo", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  async revealsAnswer() {
    return { revealed: false, usage: null };
  }
}

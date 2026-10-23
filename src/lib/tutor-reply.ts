import { z } from "zod";

/**
 * The shape of every tutor reply. Claude returns this as structured output.
 * `say` is spoken aloud (and shown as a short line); `show` is what appears on screen.
 * Shared by the server (schema sent to Claude) and the browser (rendering).
 */

const md = (what: string) =>
  z.string().describe(`${what}. Markdown; write math as LaTeX inside $...$ (inline) or $$...$$ (display).`);

const TextBlock = z.object({
  type: z.literal("text"),
  markdown: md("Explanation or question for the student"),
});

const StepsBlock = z.object({
  type: z.literal("steps"),
  title: z.string().describe("Short heading, e.g. 'A similar problem, worked through'"),
  revealOneAtATime: z
    .boolean()
    .describe("true = the student taps to reveal each step (use for worked examples so they predict the next step first)"),
  steps: z.array(
    z.object({
      math: z.string().nullable().describe("LaTeX for this step without $ delimiters, or null"),
      note: md("Why this step works, in plain words"),
    }),
  ),
});

const PracticeBlock = z.object({
  type: z.literal("practice"),
  prompt: md("A NEW practice problem like the one being studied (never the student's assigned problem)"),
  answer: z.string().describe("Final answer to the practice problem, e.g. '7', '-3/4', 'x = 2'. Used to check the student's answer."),
  explanation: md("Short solution shown after the student answers"),
});

const NumberLineBlock = z.object({
  type: z.literal("numberLine"),
  min: z.number(),
  max: z.number(),
  points: z.array(z.object({ value: z.number(), label: z.string() })),
  segments: z.array(z.object({ from: z.number(), to: z.number(), label: z.string() })).describe("Jumps or ranges; may be empty"),
});

const FractionBarsBlock = z.object({
  type: z.literal("fractionBars"),
  bars: z.array(z.object({ numerator: z.number().int(), denominator: z.number().int(), label: z.string() })),
});

const GraphBlock = z.object({
  type: z.literal("graph"),
  xMin: z.number(),
  xMax: z.number(),
  yMin: z.number(),
  yMax: z.number(),
  functions: z
    .array(z.object({ expression: z.string().describe("In terms of x, math.js syntax, e.g. '2*x + 1' or 'x^2 - 4'"), label: z.string() }))
    .describe("May be empty"),
  points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string() })).describe("May be empty"),
});

const WorkReviewBlock = z.object({
  type: z.literal("workReview"),
  lines: z
    .array(
      z.object({
        math: z.string().describe("The student's line as LaTeX, without $ delimiters"),
        status: z.enum(["ok", "look_here", "not_checked"]).describe("look_here only on the FIRST line that went wrong; later lines not_checked"),
        note: z.string().describe("Short note; for look_here, a question that points at the issue without fixing it. May be empty."),
        pageLine: z
          .number()
          .int()
          .nullable()
          .describe("For desk camera work: the line number from the desk camera update this line refers to. Otherwise null."),
      }),
    )
    .describe("The student's written work, line by line, as you read it from their photo or text"),
});

export const Block = z.discriminatedUnion("type", [
  TextBlock,
  StepsBlock,
  PracticeBlock,
  NumberLineBlock,
  FractionBarsBlock,
  GraphBlock,
  WorkReviewBlock,
]);

export const TutorReplySchema = z.object({
  say: z
    .string()
    .describe(
      "Spoken aloud in your voice. 1-3 short, natural sentences. No symbols, equations, or LaTeX: talk about the idea and point to the screen ('look at step two'). Empty string only for a desk camera update where staying quiet is best.",
    ),
  show: z.array(Block).describe("What appears on screen under what you say. May be empty for quick back-and-forth."),
  hintLevel: z
    .number()
    .int()
    .describe("Hint ladder rung this reply used: 0 = none (conversation, checking in), 1-5 as defined in the rules"),
  title: z
    .string()
    .nullable()
    .describe("On your FIRST reply only: a 2-5 word title for this problem, e.g. 'Two-step equations'. Otherwise null."),
});

export type TutorReply = z.infer<typeof TutorReplySchema>;
export type TutorBlock = z.infer<typeof Block>;

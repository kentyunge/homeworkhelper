import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { TurnUsage } from "@/db/schema";
import { TutorReplySchema, type TutorReply } from "@/lib/tutor-reply";

type Msg = Anthropic.Beta.BetaMessageParam;

export const TUTOR_MODEL = process.env.TUTOR_MODEL || "claude-opus-5-5";
export const GUARD_MODEL = process.env.GUARD_MODEL || "claude-haiku-5-5";

export class TutorError extends Error {}

export interface TutorResult {
  reply: TutorReply;
  /** Assistant content to store and replay on later turns. */
  content: Anthropic.Beta.BetaContentBlockParam[];
  usage: TurnUsage;
}

/** The two model calls the tutor service makes. Swapped for a fake in tests and demo mode. */
export interface TutorEngine {
  readonly demo: boolean;
  reply(system: string, messages: Msg[]): Promise<TutorResult>;
  /** Does this draft give away the answer to the student's assigned problem? */
  revealsAnswer(context: Msg[], draft: TutorReply): Promise<{ revealed: boolean; usage: TurnUsage | null }>;
}

function usageOf(model: string, u: Anthropic.Beta.BetaUsage): TurnUsage {
  return {
    model,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Assistant content in the form we send back on later turns. Text blocks drop the SDK's parsed copy.
 * After a server-side fallback, model-internal blocks from before the fallback marker are omitted,
 * as the API docs require; everything else is replayed unchanged.
 */
export function echoContent(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  const lastFallback = content.map((b) => b.type as string).lastIndexOf("fallback");
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  content.forEach((block, i) => {
    const type = block.type as string;
    if (type === "fallback") return;
    if (i < lastFallback && ["thinking", "redacted_thinking", "tool_use"].includes(type)) return;
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else out.push(block as unknown as Anthropic.Beta.BetaContentBlockParam);
  });
  return out;
}

function apiError(error: unknown): never {
  if (error instanceof Anthropic.AuthenticationError) throw new TutorError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  if (error instanceof Anthropic.RateLimitError) throw new TutorError("Too many requests right now. Try again in a minute.");
  if (error instanceof Anthropic.APIError) throw new TutorError(`Claude API error ${error.status}: ${error.message}`);
  throw error;
}

const GuardSchema = z.object({
  revealsAnswer: z.boolean(),
  reason: z.string().describe("One short sentence"),
});

const GUARD_SYSTEM = `You review a homework tutor's draft reply before a student sees it. The tutor must not give away the final answer to a problem the student was assigned (their homework, worksheet or test-prep question), and must not complete the last step for them.

Answer revealsAnswer = true if the draft states, shows or makes trivially obvious the final answer to the student's assigned problem, including inside a "worked example" that uses the same numbers.

These are fine (revealsAnswer = false):
- Hints, questions, naming the concept, or showing only the first step of their problem.
- Worked examples with different numbers.
- The answer to a NEW practice problem the tutor made up (the "practice" block's answer field).
- Confirming that an answer the student already stated themselves is right, or pointing at the step where their work went wrong.
- Restating the problem.`;

export class ClaudeEngine implements TutorEngine {
  readonly demo = false;
  private client = new Anthropic();

  async reply(system: string, messages: Msg[]): Promise<TutorResult> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: TUTOR_MODEL,
        max_tokens: 16000,
        // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
        // drop_block: if earlier context ever differs (e.g. an expired photo), drop stale reasoning instead of failing.
        betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort: "medium", format: betaZodOutputFormat(TutorReplySchema) },
        cache_control: { type: "ephemeral" },
        system,
        messages,
      });
    } catch (error) {
      apiError(error);
    }
    if (response.stop_reason === "refusal") throw new TutorError("I couldn't help with that one. Try asking a different way, or flag it for a parent.");
    if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new TutorError("My reply got cut off. Try again.");
    return { reply: response.parsed_output, content: echoContent(response.content), usage: usageOf(response.model, response.usage) };
  }

  async revealsAnswer(context: Msg[], draft: TutorReply) {
    try {
      const response = await this.client.beta.messages.parse({
        model: GUARD_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low", format: betaZodOutputFormat(GuardSchema) },
        system: GUARD_SYSTEM,
        messages: [
          ...context,
          {
            role: "user",
            content: `That was the conversation so far (the tutor's replies are JSON). Here is the tutor's DRAFT next reply:\n\n${JSON.stringify(draft)}\n\nDoes the draft give away the answer?`,
          },
        ],
      });
      const out = response.parsed_output;
      return { revealed: out?.revealsAnswer ?? false, usage: usageOf(response.model, response.usage) };
    } catch (error) {
      // The check is a safety net, not the main line of defense (the tutor's own rules are). Don't block a reply on it.
      console.error("[guard] check failed", error);
      return { revealed: false, usage: null };
    }
  }
}

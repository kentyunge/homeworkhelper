import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { kids, stations, tutorSessions, turns, type KidContent, type TurnUsage } from "@/db/schema";
import type { TutorReply } from "@/lib/tutor-reply";
import { badRequest, notFound } from "../errors";
import { assertKidOwnsUploads, IMAGE_TYPES, loadUploads } from "../uploads";
import { DemoEngine } from "./demo";
import { ClaudeEngine, TUTOR_MODEL, TutorError, type TutorEngine } from "./engine";
import { buildSystemPrompt } from "./prompt";

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;
type TurnRow = typeof turns.$inferSelect;

export { TutorError };

let engineOverride: TutorEngine | null = null;
/** Tests swap in a fake engine. */
export function setEngine(e: TutorEngine | null) {
  engineOverride = e;
}
export function engine(): TutorEngine {
  if (engineOverride) return engineOverride;
  return process.env.ANTHROPIC_API_KEY ? new ClaudeEngine() : new DemoEngine();
}

export const GUARD_NOTE =
  "Note from the app: your previous draft gave away the answer to the student's assigned problem. Write a new reply that stays on the hint ladder and lets the student do the thinking.";

/** Shown if the tutor gives away the answer twice in a row. */
const SAFE_REPLY: TutorReply = {
  say: "Let's slow down so you get to do the thinking. What do you think the next step is?",
  show: [
    {
      type: "text",
      markdown: "Tell me the step you'd try next, even if you're not sure. If you're stuck, ask for a hint, or tap **Flag for a parent** to go over it together.",
    },
  ],
  hintLevel: 0,
  title: null,
};

// ---------- sessions ----------

export async function startSession(kidId: number) {
  const [kid] = await db.select().from(kids).where(eq(kids.id, kidId));
  if (!kid) throw notFound("No kid with that id");
  const e = engine();
  const [s] = await db
    .insert(tutorSessions)
    .values({ kidId, systemPrompt: buildSystemPrompt(kid), model: e.demo ? "demo" : TUTOR_MODEL })
    .returning();
  return s;
}

export async function listSessions(kidId: number, limit = 30) {
  return db
    .select({
      id: tutorSessions.id,
      title: tutorSessions.title,
      lastActivityAt: tutorSessions.lastActivityAt,
      flaggedAt: tutorSessions.flaggedAt,
      flagResolvedAt: tutorSessions.flagResolvedAt,
    })
    .from(tutorSessions)
    .where(eq(tutorSessions.kidId, kidId))
    .orderBy(desc(tutorSessions.lastActivityAt))
    .limit(limit);
}

/** A session as the browser sees it: no system prompt, no raw API content. */
export async function getSession(id: number) {
  const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, id));
  if (!s) throw notFound("That conversation doesn't exist");
  const rows = await db.select().from(turns).where(eq(turns.sessionId, id)).orderBy(asc(turns.id));
  const [station] = await db
    .select({ id: stations.id, name: stations.name, lastSeenAt: stations.lastSeenAt })
    .from(stations)
    .where(eq(stations.activeSessionId, id));
  return {
    /** The desk station watching this conversation, if any. `live` = its screen is on, so it does the talking. */
    deskStation: station ? { id: station.id, name: station.name, live: !!station.lastSeenAt && Date.now() - station.lastSeenAt.getTime() < 45_000 } : null,
    id: s.id,
    kidId: s.kidId,
    title: s.title,
    demo: s.model === "demo",
    flaggedAt: s.flaggedAt,
    flagNote: s.flagNote,
    flagResolvedAt: s.flagResolvedAt,
    desk: s.desk,
    turns: rows.map((t) => ({ id: t.id, role: t.role, kid: t.kid, reply: t.reply, createdAt: t.createdAt })),
    /** True when the last thing in the conversation is the kid's (e.g. the reply failed): offer a retry. */
    awaitingReply: rows.length > 0 && rows[rows.length - 1].role === "kid",
  };
}

export async function flagSession(id: number, note: string | null) {
  await db
    .update(tutorSessions)
    .set({ flaggedAt: new Date(), flagNote: note?.trim() || null, flagResolvedAt: null })
    .where(eq(tutorSessions.id, id));
}

export async function setFlagResolved(id: number, resolved: boolean) {
  await db.update(tutorSessions).set({ flagResolvedAt: resolved ? new Date() : null }).where(eq(tutorSessions.id, id));
}

// ---------- building what Claude sees ----------

async function kidBlocks(content: KidContent, files: Awaited<ReturnType<typeof loadUploads>>): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const id of content.uploadIds) {
    const f = files.get(id);
    if (!f) {
      blocks.push({ type: "text", text: "[The student sent a photo here, but it has since been deleted.]" });
    } else if (IMAGE_TYPES.includes(f.mediaType)) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: f.mediaType as "image/jpeg", data: f.data.toString("base64") },
      });
    } else {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data.toString("base64") } });
    }
  }
  if (content.text.trim()) blocks.push({ type: "text", text: content.text.trim() });
  return blocks;
}

/**
 * The full conversation for Claude, rebuilt from stored turns the same way every time, so each request's
 * history is exactly the previous request's plus the new turns.
 */
export async function buildMessages(rows: TurnRow[]): Promise<Msg[]> {
  const files = await loadUploads(rows.flatMap((t) => t.kid?.uploadIds ?? []));
  const out: Msg[] = [];
  for (const t of rows) {
    if (t.role === "kid" && t.kid) out.push({ role: "user", content: await kidBlocks(t.kid, files) });
    else if (t.role === "tutor" && t.api) out.push(...t.api);
  }
  return out;
}

/** What the answer checker sees: the same conversation, with the tutor's replies as plain JSON. */
async function guardContext(rows: TurnRow[]): Promise<Msg[]> {
  const files = await loadUploads(rows.flatMap((t) => t.kid?.uploadIds ?? []));
  const out: Msg[] = [];
  for (const t of rows) {
    if (t.role === "kid" && t.kid) {
      const blocks = await kidBlocks(t.kid, files);
      out.push({ role: "user", content: [{ type: "text", text: "STUDENT:" }, ...blocks] });
    } else if (t.role === "tutor" && t.reply) {
      out.push({ role: "user", content: `TUTOR: ${JSON.stringify(t.reply)}` });
    }
  }
  return out;
}

// ---------- a turn ----------

export async function sendKidTurn(
  sessionId: number,
  kidId: number,
  input: { text?: string; uploadIds?: number[]; source?: "desk"; snapshotId?: number },
) {
  const content: KidContent = {
    text: (input.text ?? "").slice(0, 8000),
    uploadIds: input.uploadIds ?? [],
    ...(input.source ? { source: input.source } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
  };
  if (!content.text.trim() && content.uploadIds.length === 0) throw badRequest("Type something or add a photo");
  if (content.uploadIds.length > 5) throw badRequest("Up to 5 files at a time");
  await assertKidOwnsUploads(kidId, content.uploadIds);
  await db.insert(turns).values({ sessionId, role: "kid", kid: content });
  await touch(sessionId);
  return respond(sessionId);
}

async function touch(sessionId: number, title?: string | null) {
  await db
    .update(tutorSessions)
    .set({
      lastActivityAt: new Date(),
      ...(title ? { title: sql`case when ${tutorSessions.title} = 'New problem' then ${title.slice(0, 60)} else ${tutorSessions.title} end` } : {}),
    })
    .where(eq(tutorSessions.id, sessionId));
}

/**
 * Get the tutor's reply to the kid's latest message(s). With the answer check on (hint ceiling below 5),
 * a draft that gives the answer away is replaced: first by a new draft written with a note explaining why
 * (the note stays in the history), and if that one also gives it away, by a safe nudge.
 */
export async function respond(sessionId: number) {
  const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
  if (!s) throw notFound("That conversation doesn't exist");
  const [kid] = await db.select().from(kids).where(eq(kids.id, s.kidId));
  const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId)).orderBy(asc(turns.id));
  if (rows.length === 0 || rows[rows.length - 1].role !== "kid") throw badRequest("Nothing to reply to");

  const e = engine();
  const messages = await buildMessages(rows);
  const usage: TurnUsage[] = [];
  const check = kid.answerGuard && kid.hintCeiling < 5 && !e.demo;

  let result = await e.reply(s.systemPrompt, messages);
  usage.push(result.usage);
  let api: Msg[] = [{ role: "assistant", content: result.content }];
  let reply = result.reply;
  const revealed: boolean[] = [];

  if (check) {
    const ctx = await guardContext(rows);
    const first = await e.revealsAnswer(ctx, reply);
    if (first.usage) usage.push(first.usage);
    revealed.push(first.revealed);
    if (first.revealed) {
      const note: Msg = { role: "system", content: GUARD_NOTE };
      result = await e.reply(s.systemPrompt, [...messages, note]);
      usage.push(result.usage);
      const second = await e.revealsAnswer(ctx, result.reply);
      if (second.usage) usage.push(second.usage);
      revealed.push(second.revealed);
      reply = second.revealed ? SAFE_REPLY : result.reply;
      api = [note, { role: "assistant", content: second.revealed ? [{ type: "text", text: JSON.stringify(SAFE_REPLY) }] : result.content }];
    }
  }

  const [t] = await db
    .insert(turns)
    .values({ sessionId, role: "tutor", reply, api, usage, guard: check ? { attempts: revealed.length, revealed } : null })
    .returning();
  await touch(sessionId, reply.title);
  return { id: t.id, role: t.role, kid: null, reply, createdAt: t.createdAt };
}

/** Rough month-to-date spend, for the parent page. Prices per million tokens. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function estimateCost(usage: TurnUsage[]): number {
  return usage.reduce((sum, u) => {
    const p = Object.entries(PRICES).find(([m]) => u.model.startsWith(m))?.[1];
    if (!p) return sum;
    return sum + (u.input * p.input + u.cacheWrite * p.input * 1.25 + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
  }, 0);
}

export async function monthToDateCost(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await db
    .select({ usage: turns.usage })
    .from(turns)
    .where(and(eq(turns.role, "tutor"), sql`${turns.createdAt} >= ${start.toISOString()}`));
  return estimateCost(rows.flatMap((r) => r.usage ?? []));
}

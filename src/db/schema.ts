import { boolean, customType, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type Anthropic from "@anthropic-ai/sdk";
import { user } from "./auth-schema";
import type { TutorReply } from "@/lib/tutor-reply";

export * from "./auth-schema";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});

/** One profile per kid. A kid signs in with their own username + PIN (a Better Auth user with role "kid"). */
export const kids = pgTable("kids", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  grade: integer("grade").notNull(),
  /** Highest rung of the hint ladder the tutor may reach (see src/lib/hints.ts). */
  hintCeiling: integer("hint_ceiling").notNull().default(4),
  /** Second-model check that a reply doesn't give away the answer. */
  answerGuard: boolean("answer_guard").notNull().default(true),
  assistantName: text("assistant_name").notNull().default("Atlas"),
  personaPreset: text("persona_preset").notNull().default("butler"),
  /** Extra personality notes from the parents, added to the preset. */
  personaNotes: text("persona_notes").notNull().default(""),
  voiceProvider: text("voice_provider").notNull().default("browser"),
  /** ElevenLabs voice id, or a browser voice name. Empty = provider default. */
  voiceId: text("voice_id").notNull().default(""),
  ...timestamps,
});

export const tutorSessions = pgTable(
  "tutor_sessions",
  {
    id: serial("id").primaryKey(),
    kidId: integer("kid_id")
      .notNull()
      .references(() => kids.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New problem"),
    subject: text("subject").notNull().default("math"),
    /**
     * The system prompt, frozen when the session starts. The API checks that earlier context is
     * unchanged between turns, so settings changes apply to the next session, not this one.
     */
    systemPrompt: text("system_prompt").notNull(),
    model: text("model").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    flagNote: text("flag_note"),
    flagResolvedAt: timestamp("flag_resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("tutor_sessions_kid_idx").on(t.kidId, t.lastActivityAt)],
);

/** What the kid sent: text and/or uploads. Uploads are referenced by id and inlined when calling Claude. */
export type KidContent = { text: string; uploadIds: number[] };

/** Usage numbers for one Claude call (for cost tracking). */
export type TurnUsage = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

export const turns = pgTable(
  "turns",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => tutorSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["kid", "tutor"] }).notNull(),
    kid: jsonb("kid").$type<KidContent>(),
    reply: jsonb("reply").$type<TutorReply>(),
    /**
     * Exactly what was sent back to Claude for this tutor turn (assistant content, including thinking
     * blocks, plus any system notes added before it). Replayed verbatim so history stays append-only.
     */
    api: jsonb("api").$type<Anthropic.Beta.BetaMessageParam[]>(),
    usage: jsonb("usage").$type<TurnUsage[]>(),
    guard: jsonb("guard").$type<{ attempts: number; revealed: boolean[] }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("turns_session_idx").on(t.sessionId, t.id)],
);

/** Photos, screenshots and PDFs. Stored in Postgres to avoid another service; purged after 30 days. */
export const uploads = pgTable("uploads", {
  id: serial("id").primaryKey(),
  kidId: integer("kid_id")
    .notNull()
    .references(() => kids.id, { onDelete: "cascade" }),
  mediaType: text("media_type").notNull(),
  bytes: integer("bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

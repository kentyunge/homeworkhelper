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
    desk: jsonb("desk").$type<DeskState>(),
    ...timestamps,
  },
  (t) => [index("tutor_sessions_kid_idx").on(t.kidId, t.lastActivityAt)],
);

/**
 * What the kid sent: text and/or uploads. Uploads are referenced by id and inlined when calling Claude.
 * Desk camera updates are sent as text (the lines read from the page); `snapshotId` is the photo they
 * were read from, shown in the app but not sent to the tutor.
 */
export type KidContent = { text: string; uploadIds: number[]; source?: "desk"; snapshotId?: number };

/** One line of handwriting read from the desk camera. Positions are fractions of the photo (0-1). */
export type PageLine = {
  latex: string;
  handwritten: boolean;
  y: number;
  x0: number;
  x1: number;
  /** This line starts a new problem (a new problem number, or a printed problem). */
  newProblem?: boolean;
};
export type LineMark = {
  latex: string;
  status: "ok" | "look_here" | "not_checked";
  note: string;
  /** Who marked it: the math engine (instant, free) or the tutor. */
  by?: "engine" | "tutor";
  /** The line is a finished answer ("x = 5") that follows from the work above. */
  solved?: boolean;
};

/** How long the last photo took to handle, in milliseconds, and what the math checker made of it. */
export type DeskTiming = {
  readMs: number;
  engineMs: number;
  tutorMs: number | null;
  at: string;
  /** New lines the checker found right, found wrong, and couldn't judge (sent to the tutor). */
  check?: { ok: number; wrong: number; unknown: number };
};

/** Lines waiting for the tutor. The tutor runs separately from reading photos, so new photos keep coming. */
export type PendingTutor = {
  lines: { i: number; latex: string }[];
  wrong: { line: number; ref: number }[];
  requested: boolean;
};

/** What the desk camera has seen in a session, and what the tutor has said about it. */
export type DeskState = {
  lines: PageLine[];
  /** Tutor's marks, by line index. Lines past the end haven't been checked yet. */
  marks: LineMark[];
  snapshotId: number | null;
  unreadable: string | null;
  lastTutorAt: string | null;
  timing?: DeskTiming;
  /** The photo `lines` were read from. Newer than snapshotId's lines while a photo is being read. */
  linesSnapshotId?: number | null;
  pendingTutor?: PendingTutor | null;
};

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

export type StationSpeech = { id: number; text: string; provider: "browser" | "elevenlabs"; voiceId: string; at: string };
export type SoundCheckResult = { name: string; ok: boolean; detail: string };
export type SoundCheck = { id: number; requestedAt: string; results: SoundCheckResult[] | null; finishedAt: string | null };

/**
 * A desk station: a Raspberry Pi with a camera above the desk and a small touchscreen. It signs in with
 * its own token (never a kid's login), shown once as a pairing code that a parent approves.
 */
export const stations = pgTable("stations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default("Desk station"),
  tokenHash: text("token_hash").notNull().unique(),
  /** Shown on the station's screen until a parent approves it. */
  pairCode: text("pair_code"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  activeSessionId: integer("active_session_id").references(() => tutorSessions.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  paused: boolean("paused").notNull().default(false),
  /** "Check now" was pressed: the camera should send a photo right away. */
  captureRequested: boolean("capture_requested").notNull().default(false),
  /** Set while a photo is being read or the tutor is replying, so only one runs at a time. */
  busySince: timestamp("busy_since", { withTimezone: true }),
  /** Set while the tutor is checking lines, so only one tutor check runs at a time. */
  tutorBusySince: timestamp("tutor_busy_since", { withTimezone: true }),
  /** Last time new writing appeared. Drives the "want a hint?" nudge and the idle stop. */
  lastChangeAt: timestamp("last_change_at", { withTimezone: true }),
  nudgedAt: timestamp("nudged_at", { withTimezone: true }),
  /** The latest thing the station should say; the Pi plays it (it has working sound, the kiosk browser may not). */
  speech: jsonb("speech").$type<StationSpeech>(),
  /** A sound check asked for on the station's screen, run by the Pi, with its results. */
  soundCheck: jsonb("sound_check").$type<SoundCheck>(),
  /** The camera program couldn't open the camera (reported by the Pi), or null when it's working. */
  cameraError: text("camera_error"),
  /** The last time reading a photo or checking work failed, and why. Shown on the station's screen. */
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  pinFailures: integer("pin_failures").notNull().default(0),
  pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

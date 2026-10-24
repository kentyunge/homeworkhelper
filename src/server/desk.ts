import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/db";
import { account, kids, stations, turns, tutorSessions, type DeskState, type LineMark, type PageLine } from "@/db/schema";
import type { TutorReply } from "@/lib/tutor-reply";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "./errors";
import { compareLines, isSolutionLine } from "@/lib/math-check";
import { getKid } from "./family";
import { engine, flagSession, sendKidTurn, startSession, TutorError } from "./tutor";
import { deleteUpload, getUpload, saveUpload } from "./uploads";

type Station = typeof stations.$inferSelect;

/** Wait at least this long between tutor checks while writing continues, so it isn't chatty (or costly). */
export const MIN_CHECK_GAP_MS = 12_000;
/** No new writing for this long: offer a hint (spoken by the station, no AI cost). */
export const NUDGE_AFTER_MS = 4 * 60_000;
/** No new writing for this long: stop watching. */
export const IDLE_STOP_MS = 15 * 60_000;
/** A kid's session counts as "open" for joining from the station if used this recently. */
const JOIN_RECENT_MS = 30 * 60_000;
const BUSY_TIMEOUT_MS = 120_000;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 60_000;
/** A tutor error is shown on the station for this long after it happens. */
const ERROR_SHOWN_MS = 3 * 60_000;

const emptyDesk = (): DeskState => ({ lines: [], marks: [], snapshotId: null, unreadable: null, lastTutorAt: null });

// ---------- tokens and pairing ----------

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Easy to read off a small screen and type: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function pairCode() {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/**
 * A new station asks to pair. It gets a token (kept on the Pi) and a code to show on its screen;
 * the token works only after a parent enters the code on the parent page.
 */
export async function requestPairing() {
  const cutoff = new Date(Date.now() - 30 * 60_000);
  await db.delete(stations).where(and(isNull(stations.approvedAt), lt(stations.createdAt, cutoff)));
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stations)
    .where(isNull(stations.approvedAt));
  if (n >= 10) throw conflict("Too many stations waiting to be paired. Try again later.");
  const token = randomBytes(32).toString("base64url");
  const code = pairCode();
  await db.insert(stations).values({ tokenHash: hashToken(token), pairCode: code });
  return { token, code };
}

export async function approveStation(code: string, name: string) {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const [s] = await db
    .update(stations)
    .set({ approvedAt: new Date(), pairCode: null, name: name.trim().slice(0, 40) || "Desk station" })
    .where(and(eq(stations.pairCode, clean), isNull(stations.approvedAt)))
    .returning();
  if (!s) throw notFound("No station is showing that code. Check the code on its screen.");
  return publicStation(s);
}

export async function stationForToken(token: string | null): Promise<Station> {
  if (!token) throw unauthorized("Station token missing");
  const [s] = await db.select().from(stations).where(eq(stations.tokenHash, hashToken(token)));
  if (!s) throw unauthorized("This station isn't paired. Restart it to get a new code.");
  if (!s.lastSeenAt || Date.now() - s.lastSeenAt.getTime() > 15_000) {
    await db.update(stations).set({ lastSeenAt: new Date() }).where(eq(stations.id, s.id));
  }
  return s;
}

function requireApproved(s: Station) {
  if (!s.approvedAt) throw forbidden("Waiting for a parent to approve this station");
}

function publicStation(s: Station) {
  return { id: s.id, name: s.name, approved: !!s.approvedAt, lastSeenAt: s.lastSeenAt, activeSessionId: s.activeSessionId };
}

// ---------- parent management ----------

export async function listStations() {
  const rows = await db
    .select({ s: stations, kidName: kids.name })
    .from(stations)
    .leftJoin(tutorSessions, eq(tutorSessions.id, stations.activeSessionId))
    .leftJoin(kids, eq(kids.id, tutorSessions.kidId))
    .where(isNotNull(stations.approvedAt))
    .orderBy(stations.name);
  return rows.map((r) => ({ ...publicStation(r.s), inUseBy: r.kidName, problems: problems(r.s) }));
}

export async function renameStation(id: number, name: string) {
  const clean = name.trim().slice(0, 40);
  if (!clean) throw badRequest("Give the station a name");
  const [s] = await db.update(stations).set({ name: clean }).where(eq(stations.id, id)).returning();
  if (!s) throw notFound("No station with that id");
  return publicStation(s);
}

export async function removeStation(id: number) {
  await db.delete(stations).where(eq(stations.id, id));
}

// ---------- starting and stopping ----------

async function attach(stationId: number, sessionId: number) {
  const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
  if (!s) throw notFound("That conversation doesn't exist");
  if (!s.desk) await db.update(tutorSessions).set({ desk: emptyDesk() }).where(eq(tutorSessions.id, sessionId));
  // A session is watched by one station at a time.
  await db.update(stations).set({ activeSessionId: null }).where(and(eq(stations.activeSessionId, sessionId), sql`${stations.id} <> ${stationId}`));
  const now = new Date();
  await db
    .update(stations)
    .set({ activeSessionId: sessionId, startedAt: now, paused: false, captureRequested: false, lastChangeAt: now, nudgedAt: null, busySince: null })
    .where(eq(stations.id, stationId));
}

async function checkPin(station: Station, kidId: number, pin: string) {
  if (station.pinLockedUntil && station.pinLockedUntil > new Date()) {
    throw forbidden("Too many wrong PINs. Wait a minute and try again.");
  }
  const kid = await getKid(kidId);
  const [acct] = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, kid.userId), eq(account.providerId, "credential")));
  const ok = !!acct?.password && (await verifyPassword({ hash: acct.password, password: pin }));
  if (!ok) {
    const failures = station.pinFailures + 1;
    await db
      .update(stations)
      .set(
        failures >= PIN_MAX_FAILURES
          ? { pinFailures: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) }
          : { pinFailures: failures },
      )
      .where(eq(stations.id, station.id));
    throw forbidden("That PIN didn't match");
  }
  if (station.pinFailures) await db.update(stations).set({ pinFailures: 0 }).where(eq(stations.id, station.id));
  return kid;
}

/**
 * A kid starts at the station with their PIN. If they've used a conversation in the last half hour
 * (e.g. opened on the Chromebook), the camera joins it; otherwise a new one starts.
 */
export async function startAtStation(station: Station, kidId: number, pin: string) {
  requireApproved(station);
  const kid = await checkPin(station, kidId, pin);
  const [recent] = await db
    .select({ id: tutorSessions.id })
    .from(tutorSessions)
    .where(and(eq(tutorSessions.kidId, kid.id), gt(tutorSessions.lastActivityAt, new Date(Date.now() - JOIN_RECENT_MS))))
    .orderBy(desc(tutorSessions.lastActivityAt))
    .limit(1);
  const sessionId = recent?.id ?? (await startSession(kid.id)).id;
  await attach(station.id, sessionId);
  return { sessionId };
}

/** From the Chromebook: "Use desk camera" on an open conversation. */
export async function attachFromApp(stationId: number, sessionId: number) {
  const [s] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!s?.approvedAt) throw notFound("No station with that id");
  await attach(stationId, sessionId);
}

export async function stopWatching(stationId: number) {
  await db
    .update(stations)
    .set({ activeSessionId: null, startedAt: null, paused: false, captureRequested: false, busySince: null })
    .where(eq(stations.id, stationId));
}

export async function stopForSession(sessionId: number) {
  await db
    .update(stations)
    .set({ activeSessionId: null, startedAt: null, paused: false, captureRequested: false, busySince: null })
    .where(eq(stations.activeSessionId, sessionId));
}

export async function setPaused(station: Station, paused: boolean) {
  await db.update(stations).set({ paused, lastChangeAt: new Date(), nudgedAt: null }).where(eq(stations.id, station.id));
}

export async function requestCheck(station: Station) {
  if (!station.activeSessionId) throw badRequest("Nothing is being watched");
  await db.update(stations).set({ captureRequested: true }).where(eq(stations.id, station.id));
}

export async function hint(station: Station) {
  const session = await activeSession(station);
  return sendKidTurn(session.id, session.kidId, { text: "I'd like a hint on what I'm working on." });
}

export async function flagFromStation(station: Station) {
  const session = await activeSession(station);
  await flagSession(session.id, "Flagged from the desk station");
}

async function activeSession(station: Station) {
  requireApproved(station);
  if (!station.activeSessionId) throw badRequest("Nothing is being watched");
  const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, station.activeSessionId));
  if (!s) throw notFound("That conversation doesn't exist");
  return s;
}

// ---------- the busy lock ----------

/** Only one photo read or tutor check runs per station at a time. Returns false if one is running. */
async function lock(stationId: number) {
  const stale = new Date(Date.now() - BUSY_TIMEOUT_MS);
  const rows = await db
    .update(stations)
    .set({ busySince: new Date() })
    .where(and(eq(stations.id, stationId), or(isNull(stations.busySince), lt(stations.busySince, stale))))
    .returning({ id: stations.id });
  return rows.length > 0;
}
async function unlock(stationId: number) {
  await db.update(stations).set({ busySince: null }).where(eq(stations.id, stationId));
}

// ---------- reading the page ----------

/** Handwritten lines that are new or changed since the tutor last looked. */
export function uncheckedLines(desk: DeskState): number[] {
  return desk.lines.flatMap((l, i) => (l.handwritten && desk.marks[i]?.latex !== l.latex ? [i] : []));
}

/** A different page: nothing in common with what was there before. */
export function isNewPage(before: PageLine[], after: PageLine[]) {
  if (!before.length || !after.length) return false;
  const seen = new Set(before.map((l) => l.latex.replace(/\s/g, "")));
  return !after.some((l) => seen.has(l.latex.replace(/\s/g, "")));
}

/**
 * The math engine's first pass over new lines: a quiet ✓ when a line follows from the one above,
 * a ? when it doesn't, and nothing (left for the tutor) when it can't tell. Lines after the first
 * mistake in a problem aren't marked, since they build on it.
 */
export function engineCheck(desk: DeskState, fresh: number[]) {
  const marks: LineMark[] = desk.marks.slice(0, desk.lines.length);
  const forTutor: number[] = [];
  const wrong: { line: number; ref: number }[] = [];
  const problemStart = (i: number) => {
    let start = 0;
    for (let k = 0; k <= i; k++) if (desk.lines[k].newProblem) start = k;
    return start;
  };
  for (const i of [...fresh].sort((a, b) => a - b)) {
    const line = desk.lines[i];
    const mark = (status: LineMark["status"], extra: Partial<LineMark> = {}) =>
      (marks[i] = { latex: line.latex, status, note: "", by: "engine", ...extra });
    const start = problemStart(i);
    if (i === start) {
      mark("not_checked"); // the first line of a problem: nothing above it to compare with
      continue;
    }
    const afterMistake = desk.lines
      .slice(start, i)
      .some((l, k) => marks[start + k]?.status === "look_here" && marks[start + k]?.latex === l.latex);
    if (afterMistake) {
      mark("not_checked");
      continue;
    }
    const verdict = compareLines(desk.lines[i - 1].latex, line.latex);
    if (verdict === "same") mark("ok", isSolutionLine(line.latex) ? { solved: true } : {});
    else if (verdict === "different") {
      mark("look_here");
      wrong.push({ line: i, ref: i - 1 });
      forTutor.push(i);
    } else forTutor.push(i);
  }
  for (let i = 0; i < desk.lines.length; i++) if (!marks[i]) marks[i] = { latex: "", status: "not_checked", note: "" };
  return { marks, forTutor, wrong };
}

/** The message the tutor gets: every line on the page, numbered, with the ones to check marked NEW. */
export function deskMessage(desk: DeskState, fresh: number[], requested: boolean, wrong: { line: number; ref: number }[] = []) {
  const lines = desk.lines.map((l, i) => {
    const m = desk.marks[i];
    if (!l.handwritten) return `${i + 1}. (printed) $${l.latex}$`;
    if (fresh.includes(i)) {
      const w = wrong.find((x) => x.line === i);
      return `${i + 1}. NEW: $${l.latex}$${w ? ` [math checker: does not follow from line ${w.ref + 1}]` : ""}`;
    }
    const checked = m?.by === "engine" && m.status === "ok" && m.latex === l.latex;
    return `${i + 1}. $${l.latex}$${checked ? " [math checker: follows from the line above]" : ""}`;
  });
  return [
    "[Desk camera] The lines on the page now:",
    ...lines,
    requested ? "(The student tapped Check now.)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Copy the tutor's marks (from its workReview block) onto the lines it checked; keep the engine's otherwise. */
export function applyMarks(desk: DeskState, fresh: number[], reply: TutorReply): LineMark[] {
  const marks = desk.marks.slice(0, desk.lines.length);
  const review = reply.show.flatMap((b) => (b.type === "workReview" ? b.lines : []));
  for (const i of fresh) {
    const r = review.find((l) => l.pageLine === i + 1);
    const engine = marks[i]?.by === "engine" && marks[i]?.latex === desk.lines[i].latex ? marks[i] : null;
    marks[i] = r
      ? { latex: desk.lines[i].latex, status: r.status, note: r.note, by: "tutor", ...(engine?.solved && r.status === "ok" ? { solved: true } : {}) }
      : (engine ?? { latex: desk.lines[i].latex, status: "not_checked", note: "" });
  }
  for (let i = 0; i < desk.lines.length; i++) if (!marks[i]) marks[i] = { latex: "", status: "not_checked", note: "" };
  return marks;
}

async function saveDesk(sessionId: number, desk: DeskState) {
  await db.update(tutorSessions).set({ desk }).where(eq(tutorSessions.id, sessionId));
}

/**
 * Check the new lines: the math engine first (instant), then the tutor for mistakes, for lines the
 * engine can't judge (at most every MIN_CHECK_GAP_MS while writing continues), or when the kid tapped
 * Check now. Call while holding the station lock.
 */
async function maybeCheck(sessionId: number, kidId: number, desk: DeskState, requested: boolean) {
  const fresh = uncheckedLines(desk);
  if (!fresh.length && !(requested && desk.lines.length)) return { turn: null, desk, engineMs: 0, tutorMs: null };

  const t0 = Date.now();
  const { marks, forTutor, wrong } = engineCheck(desk, fresh);
  let next: DeskState = { ...desk, marks };
  const engineMs = Date.now() - t0;
  await saveDesk(sessionId, next); // the station shows ✓ and ? right away

  const since = desk.lastTutorAt ? Date.now() - new Date(desk.lastTutorAt).getTime() : Infinity;
  const ask = requested || wrong.length > 0 || (forTutor.length > 0 && since >= MIN_CHECK_GAP_MS);
  if (!ask) return { turn: null, desk: next, engineMs, tutorMs: null };

  const t1 = Date.now();
  const toCheck = requested ? fresh : forTutor;
  const turn = await sendKidTurn(sessionId, kidId, {
    text: deskMessage(next, toCheck, requested, wrong),
    source: "desk",
    snapshotId: desk.snapshotId ?? undefined,
  });
  next = { ...next, marks: applyMarks(next, toCheck, turn.reply), lastTutorAt: new Date().toISOString() };
  await saveDesk(sessionId, next);
  return { turn, desk: next, engineMs, tutorMs: Date.now() - t1 };
}

/**
 * A photo from the station's camera. Reads it, updates what's on the page, and asks the tutor when
 * there's new work. Ignored when nothing is being watched or the station is paused.
 */
export async function handleFrame(station: Station, image: Buffer, mediaType: string, requested: boolean) {
  requireApproved(station);
  if (!station.activeSessionId || station.paused) return { status: "ignored" as const };
  if (!(await lock(station.id))) return { status: "busy" as const };
  try {
    const [session] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, station.activeSessionId));
    if (!session) return { status: "ignored" as const };
    const wasRequested = requested || station.captureRequested;
    if (station.captureRequested) await db.update(stations).set({ captureRequested: false }).where(eq(stations.id, station.id));

    const upload = await saveUpload(session.kidId, mediaType, image);
    const before = session.desk ?? emptyDesk();
    let reading;
    const t0 = Date.now();
    try {
      reading = await engine().readPage(image, mediaType, before.lines);
    } catch (e) {
      // Don't keep photos that couldn't be read; the camera tries again shortly.
      await deleteUpload(upload.id);
      throw e;
    }
    const readMs = Date.now() - t0;

    if (reading.unreadable && reading.lines.length === 0) {
      await saveDesk(session.id, { ...before, unreadable: reading.unreadable });
      return { status: "unreadable" as const, reason: reading.unreadable };
    }
    const newPage = isNewPage(before.lines, reading.lines);
    const changed = newPage || JSON.stringify(before.lines.map((l) => l.latex)) !== JSON.stringify(reading.lines.map((l) => l.latex));
    const desk: DeskState = {
      lines: reading.lines,
      marks: newPage ? [] : before.marks,
      snapshotId: upload.id,
      unreadable: reading.unreadable,
      lastTutorAt: before.lastTutorAt,
    };
    await saveDesk(session.id, desk);
    if (changed) {
      await db.update(stations).set({ lastChangeAt: new Date(), nudgedAt: null }).where(eq(stations.id, station.id));
      await db.update(tutorSessions).set({ lastActivityAt: new Date() }).where(eq(tutorSessions.id, session.id));
    }
    // A partly covered page isn't checked until it can be read clearly.
    const check = reading.unreadable ? null : await maybeCheck(session.id, session.kidId, desk, wasRequested);
    const timing = { readMs, engineMs: check?.engineMs ?? 0, tutorMs: check?.tutorMs ?? null, at: new Date().toISOString() };
    await saveDesk(session.id, { ...(check?.desk ?? desk), timing });
    console.log(`[desk] station ${station.id}: read ${readMs} ms, engine ${timing.engineMs} ms, tutor ${timing.tutorMs ?? "-"} ms`);
    if (station.lastError) await db.update(stations).set({ lastError: null, lastErrorAt: null }).where(eq(stations.id, station.id));
    return { status: "read" as const, lines: desk.lines.length, checked: !!check?.turn, timing };
  } catch (e) {
    await recordError(station.id, e);
    throw e;
  } finally {
    await unlock(station.id);
  }
}

/** Remember a tutor/reader failure so the station's screen (and the parent page) can explain it. */
async function recordError(stationId: number, e: unknown) {
  const message = e instanceof TutorError ? e.message : "Something went wrong reading the page.";
  await db.update(stations).set({ lastError: message, lastErrorAt: new Date() }).where(eq(stations.id, stationId));
}

/** The Pi reports whether it could open the camera. */
export async function reportCamera(station: Station, error: string | null) {
  await db.update(stations).set({ cameraError: error?.slice(0, 300) || null }).where(eq(stations.id, station.id));
}

/** Problems to show on the station's screen and the parent page, in plain words. */
export function problems(s: Station) {
  return {
    camera: s.cameraError,
    tutor: s.lastError && s.lastErrorAt && Date.now() - s.lastErrorAt.getTime() < ERROR_SHOWN_MS ? s.lastError : null,
  };
}

/**
 * Called every few seconds by the station's screen while it's in use. Runs a check that was held back
 * (writing came in too soon after the last one), offers a hint after a quiet spell, and stops watching
 * after a long one.
 */
export async function tick(station: Station) {
  requireApproved(station);
  if (!station.activeSessionId || station.paused) return { nudge: false };
  const now = Date.now();
  const lastChange = station.lastChangeAt?.getTime() ?? now;
  if (now - lastChange > IDLE_STOP_MS) {
    await stopWatching(station.id);
    return { nudge: false, stopped: true };
  }
  let nudge = false;
  if (now - lastChange > NUDGE_AFTER_MS && !station.nudgedAt) {
    await db.update(stations).set({ nudgedAt: new Date() }).where(eq(stations.id, station.id));
    nudge = true;
  }
  const [session] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, station.activeSessionId));
  if (session?.desk && uncheckedLines(session.desk).length && (await lock(station.id))) {
    try {
      await maybeCheck(session.id, session.kidId, session.desk, false);
    } catch (e) {
      await recordError(station.id, e);
    } finally {
      await unlock(station.id);
    }
  }
  return { nudge };
}

// ---------- what the station shows ----------

export async function stationState(station: Station) {
  const base = {
    station: { name: station.name, approved: !!station.approvedAt, pairCode: station.pairCode },
    problems: problems(station),
  };
  if (!station.approvedAt) return { ...base, kids: [], active: null };
  if (!station.activeSessionId) {
    const list = await db.select({ id: kids.id, name: kids.name, assistantName: kids.assistantName }).from(kids).orderBy(kids.name);
    return { ...base, kids: list, active: null };
  }
  const [row] = await db
    .select({ s: tutorSessions, kid: kids })
    .from(tutorSessions)
    .innerJoin(kids, eq(kids.id, tutorSessions.kidId))
    .where(eq(tutorSessions.id, station.activeSessionId));
  if (!row) return { ...base, kids: [], active: null };
  const [last] = await db
    .select({ id: turns.id, reply: turns.reply })
    .from(turns)
    .where(and(eq(turns.sessionId, row.s.id), eq(turns.role, "tutor")))
    .orderBy(desc(turns.id))
    .limit(1);
  return {
    ...base,
    kids: [],
    active: {
      sessionId: row.s.id,
      title: row.s.title,
      kid: {
        name: row.kid.name,
        assistantName: row.kid.assistantName,
        voiceProvider: row.kid.voiceProvider,
        voiceId: row.kid.voiceId,
      },
      paused: station.paused,
      busy: !!station.busySince && Date.now() - station.busySince.getTime() < BUSY_TIMEOUT_MS,
      startedAt: station.startedAt,
      desk: row.s.desk ?? emptyDesk(),
      lastReply: last ? { turnId: last.id, say: last.reply?.say ?? "" } : null,
    },
  };
}

/** What the camera program needs: whether to send photos, and whether one was asked for. */
export function cameraState(station: Station) {
  return {
    approved: !!station.approvedAt,
    watching: !!station.activeSessionId && !station.paused,
    captureRequested: station.captureRequested,
  };
}

/** Stations a kid can pick from the Chromebook, and the one (if any) watching this conversation. */
export async function stationsForSession(sessionId: number) {
  const list = await listStations();
  return list.map((s) => ({ id: s.id, name: s.name, watchingThis: s.activeSessionId === sessionId, busy: !!s.activeSessionId && s.activeSessionId !== sessionId }));
}

export async function snapshotForStation(station: Station, uploadId: number) {
  const session = await activeSession(station);
  const u = await getUpload(uploadId);
  if (u.kidId !== session.kidId) throw notFound();
  return u;
}

import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/db";
import { account, kids, stations, turns, tutorSessions, type PendingTutor, type SoundCheckResult, type StationSpeech, type DeskState, type LineMark, type PageLine } from "@/db/schema";
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

/**
 * Change a session's desk state under a row lock, from its latest saved value. Reading photos and the
 * tutor run at the same time, so each applies its change to the current state instead of overwriting it.
 */
async function updateDesk(sessionId: number, change: (desk: DeskState) => DeskState): Promise<DeskState> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ desk: tutorSessions.desk }).from(tutorSessions).where(eq(tutorSessions.id, sessionId)).for("update");
    const next = change(row?.desk ?? emptyDesk());
    await tx.update(tutorSessions).set({ desk: next }).where(eq(tutorSessions.id, sessionId));
    return next;
  });
}

/** Lines waiting for the tutor, merged with any still waiting from earlier photos. */
function mergePending(prev: PendingTutor | null | undefined, lines: number[], wrong: { line: number; ref: number }[], requested: boolean, desk: DeskState): PendingTutor | null {
  const all = new Map<number, string>();
  for (const p of prev?.lines ?? []) if (desk.lines[p.i]?.latex === p.latex) all.set(p.i, p.latex);
  for (const i of lines) all.set(i, desk.lines[i].latex);
  const keepWrong = [...(prev?.wrong ?? []).filter((w) => all.has(w.line) && !wrong.some((x) => x.line === w.line)), ...wrong];
  const req = requested || !!prev?.requested;
  if (!all.size && !req) return null;
  return { lines: [...all].map(([i, latex]) => ({ i, latex })).sort((x, y) => x.i - y.i), wrong: keepWrong, requested: req };
}

/**
 * The math engine's pass over new lines (instant). Lines that need the tutor (mistakes, ones the engine
 * can't judge, or everything when the kid tapped Check now) are queued for it.
 */
export function checkWithEngine(desk: DeskState, requested: boolean) {
  const fresh = uncheckedLines(desk);
  const t0 = Date.now();
  const { marks, forTutor, wrong } = engineCheck(desk, fresh);
  const next: DeskState = { ...desk, marks };
  const queue = requested ? fresh : forTutor;
  next.pendingTutor = mergePending(desk.pendingTutor, queue, wrong, requested && desk.lines.length > 0, next);
  const counts = { ok: fresh.filter((i) => marks[i]?.status === "ok").length, wrong: wrong.length, unknown: forTutor.length - wrong.length };
  return { desk: next, engineMs: Date.now() - t0, counts };
}

/** Is it time for the tutor? Right away for mistakes and Check now; lines it can't judge wait for the gap. */
function tutorDue(desk: DeskState) {
  const p = desk.pendingTutor;
  if (!p) return false;
  if (p.requested || p.wrong.length) return true;
  const since = desk.lastTutorAt ? Date.now() - new Date(desk.lastTutorAt).getTime() : Infinity;
  return since >= MIN_CHECK_GAP_MS;
}

/** Only one tutor check per station at a time (separate from reading photos). */
async function lockTutor(stationId: number) {
  const stale = new Date(Date.now() - BUSY_TIMEOUT_MS);
  const rows = await db
    .update(stations)
    .set({ tutorBusySince: new Date() })
    .where(and(eq(stations.id, stationId), or(isNull(stations.tutorBusySince), lt(stations.tutorBusySince, stale))))
    .returning({ id: stations.id });
  return rows.length > 0;
}
async function unlockTutor(stationId: number) {
  await db.update(stations).set({ tutorBusySince: null }).where(eq(stations.id, stationId));
}

/** Ask the tutor about the queued lines, then put its marks on the lines that are still there. */
async function runTutor(sessionId: number, kidId: number) {
  let pending: PendingTutor | null = null;
  const desk = await updateDesk(sessionId, (d) => {
    pending = d.pendingTutor ?? null;
    return { ...d, pendingTutor: null };
  });
  const job = pending as PendingTutor | null;
  if (!job) return null;
  const toCheck = job.lines.filter((p) => desk.lines[p.i]?.latex === p.latex).map((p) => p.i);
  if (!toCheck.length && !job.requested) return null;

  const t0 = Date.now();
  let turn;
  try {
    turn = await sendKidTurn(sessionId, kidId, {
      text: deskMessage(desk, toCheck, job.requested, job.wrong.filter((w) => toCheck.includes(w.line))),
      source: "desk",
      snapshotId: desk.linesSnapshotId ?? desk.snapshotId ?? undefined,
    });
  } catch (e) {
    // Put the work back so it's tried again on the next tick.
    await updateDesk(sessionId, (d) => ({ ...d, pendingTutor: mergePending(d.pendingTutor, toCheck, job.wrong, job.requested, d) }));
    throw e;
  }
  const tutorMs = Date.now() - t0;
  await updateDesk(sessionId, (d) => {
    const still = toCheck.filter((i) => d.lines[i]?.latex === desk.lines[i].latex);
    return {
      ...d,
      marks: applyMarks(d, still, turn.reply),
      lastTutorAt: new Date().toISOString(),
      timing: d.timing ? { ...d.timing, tutorMs } : d.timing,
    };
  });
  console.log(`[desk] session ${sessionId}: tutor ${tutorMs} ms for ${toCheck.length} line(s)`);
  return { turn, tutorMs };
}

/**
 * A photo from the station's camera. Shows it right away, reads it, runs the math check, and queues
 * anything the tutor should look at (the station's tick runs the tutor, so photos keep flowing).
 * Ignored when nothing is being watched or the station is paused.
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
    // Show the new photo straight away; its marks follow once it's read.
    const before = await updateDesk(session.id, (d) => ({ ...d, linesSnapshotId: d.linesSnapshotId ?? d.snapshotId ?? null, snapshotId: upload.id }));
    let reading;
    const t0 = Date.now();
    try {
      reading = await engine().readPage(image, mediaType, before.lines);
    } catch (e) {
      // Don't keep photos that couldn't be read; the camera tries again shortly.
      await updateDesk(session.id, (d) => ({ ...d, snapshotId: d.snapshotId === upload.id ? (d.linesSnapshotId ?? null) : d.snapshotId }));
      await deleteUpload(upload.id);
      throw e;
    }
    const readMs = Date.now() - t0;

    if (reading.unreadable && reading.lines.length === 0) {
      await updateDesk(session.id, (d) => ({ ...d, unreadable: reading.unreadable }));
      return { status: "unreadable" as const, reason: reading.unreadable };
    }

    let changed = false;
    let result: ReturnType<typeof checkWithEngine> | null = null;
    await updateDesk(session.id, (d) => {
      const newPage = isNewPage(d.lines, reading.lines);
      changed = newPage || JSON.stringify(d.lines.map((l) => l.latex)) !== JSON.stringify(reading.lines.map((l) => l.latex));
      const read: DeskState = {
        ...d,
        lines: reading.lines,
        marks: newPage ? [] : d.marks,
        pendingTutor: newPage ? null : d.pendingTutor,
        linesSnapshotId: upload.id,
        unreadable: reading.unreadable,
      };
      // A partly covered page isn't checked until it can be read clearly.
      if (reading.unreadable && !wasRequested) return read;
      result = checkWithEngine(read, wasRequested);
      return { ...result.desk, timing: { readMs, engineMs: result.engineMs, tutorMs: null, at: new Date().toISOString(), check: result.counts } };
    });
    if (changed) {
      await db.update(stations).set({ lastChangeAt: new Date(), nudgedAt: null }).where(eq(stations.id, station.id));
      await db.update(tutorSessions).set({ lastActivityAt: new Date() }).where(eq(tutorSessions.id, session.id));
    }
    const r = result as ReturnType<typeof checkWithEngine> | null;
    const timing = { readMs, engineMs: r?.engineMs ?? 0, check: r?.counts ?? null };
    console.log(`[desk] station ${station.id}: read ${readMs} ms, engine ${timing.engineMs} ms, ${JSON.stringify(timing.check)}`);
    if (station.lastError) await db.update(stations).set({ lastError: null, lastErrorAt: null }).where(eq(stations.id, station.id));
    return { status: "read" as const, lines: reading.lines.length, queuedForTutor: !!r?.desk.pendingTutor, timing };
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
  if (session?.desk && tutorDue(session.desk) && (await lockTutor(station.id))) {
    try {
      await runTutor(session.id, session.kidId);
    } catch (e) {
      await recordError(station.id, e);
    } finally {
      await unlockTutor(station.id);
    }
  }
  return { nudge };
}

// ---------- what the station shows ----------

export async function stationState(station: Station) {
  const base = {
    station: { name: station.name, approved: !!station.approvedAt, pairCode: station.pairCode },
    problems: problems(station),
    soundCheck: station.soundCheck,
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
      busy: [station.busySince, station.tutorBusySince].some((t) => !!t && Date.now() - t.getTime() < BUSY_TIMEOUT_MS),
      startedAt: station.startedAt,
      desk: row.s.desk ?? emptyDesk(),
      lastReply: last ? { turnId: last.id, say: last.reply?.say ?? "" } : null,
    },
  };
}

/** Speech older than this is dropped rather than played late. */
const SPEECH_FRESH_MS = 60_000;

/**
 * What the Pi program needs: whether to send photos, whether one was asked for, anything to say,
 * and a sound check to run.
 */
export function cameraState(station: Station) {
  const speech = station.speech && Date.now() - new Date(station.speech.at).getTime() < SPEECH_FRESH_MS ? station.speech : null;
  const check = station.soundCheck;
  const soundCheck = check && !check.results && Date.now() - new Date(check.requestedAt).getTime() < 2 * 60_000 ? { id: check.id } : null;
  return {
    approved: !!station.approvedAt,
    watching: !!station.activeSessionId && !station.paused,
    captureRequested: station.captureRequested,
    speech,
    soundCheck,
  };
}

/**
 * Something for the station to say out loud. The Pi plays it through its own speaker (system audio
 * works there; the kiosk browser's sound may not), in the watched kid's voice when there is one.
 */
export async function queueSpeech(station: Station, text: string) {
  requireApproved(station);
  const clean = text.trim().slice(0, 1000);
  if (!clean) return null;
  let provider: StationSpeech["provider"] = "browser";
  let voiceId = "";
  if (station.activeSessionId) {
    const [row] = await db
      .select({ provider: kids.voiceProvider, voiceId: kids.voiceId })
      .from(tutorSessions)
      .innerJoin(kids, eq(kids.id, tutorSessions.kidId))
      .where(eq(tutorSessions.id, station.activeSessionId));
    if (row) {
      provider = row.provider === "elevenlabs" ? "elevenlabs" : "browser";
      voiceId = row.voiceId;
    }
  }
  const speech: StationSpeech = { id: Date.now(), text: clean, provider, voiceId, at: new Date().toISOString() };
  await db.update(stations).set({ speech }).where(eq(stations.id, station.id));
  return speech;
}

export function currentSpeech(station: Station, id: number) {
  if (!station.speech || station.speech.id !== id) throw notFound("That speech has been replaced");
  return station.speech;
}

/** Ask the Pi to test its speaker, built-in voice and ElevenLabs. */
export async function requestSoundCheck(station: Station) {
  const soundCheck = { id: Date.now(), requestedAt: new Date().toISOString(), results: null, finishedAt: null };
  await db.update(stations).set({ soundCheck }).where(eq(stations.id, station.id));
  return soundCheck;
}

export async function saveSoundCheck(station: Station, id: number, results: SoundCheckResult[]) {
  if (!station.soundCheck || station.soundCheck.id !== id) throw notFound("That sound check has been replaced");
  await db
    .update(stations)
    .set({ soundCheck: { ...station.soundCheck, results, finishedAt: new Date().toISOString() } })
    .where(eq(stations.id, station.id));
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

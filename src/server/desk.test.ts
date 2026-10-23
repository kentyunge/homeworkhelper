import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { stations, turns, tutorSessions, type PageLine } from "@/db/schema";
import type { TutorReply } from "@/lib/tutor-reply";
import * as desk from "./desk";
import { createKid } from "./family";
import * as tutor from "./tutor";
import type { TutorEngine } from "./tutor/engine";

type Msg = Anthropic.Beta.BetaMessageParam;

const line = (latex: string, handwritten = true, y = 0.5): PageLine => ({ latex, handwritten, y, x0: 0.1, x1: 0.5 });
const PROBLEM = line("3(x-4)=2x+5", false, 0.1);

/** Reads pages from a queue; the tutor marks every NEW line ok unless it contains "BAD". */
class DeskEngine implements TutorEngine {
  readonly demo = false;
  pages: { lines: PageLine[]; unreadable?: string }[] = [];
  replies: string[] = [];
  reads = 0;
  async reply(_system: string, messages: Msg[]) {
    const last = messages[messages.length - 1];
    const text = typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    this.replies.push(text);
    const fresh = [...text.matchAll(/^(\d+)\. NEW: \$(.*)\$$/gm)].map((m) => ({ n: Number(m[1]), latex: m[2] }));
    const bad = fresh.find((l) => l.latex.includes("BAD"));
    const r: TutorReply = {
      say: bad ? "Look again at that line." : "",
      show: fresh.length
        ? [
            {
              type: "workReview",
              lines: fresh.map((l) => ({ math: l.latex, status: l === bad ? "look_here" : "ok", note: l === bad ? "Check the sign?" : "", pageLine: l.n })),
            },
          ]
        : [{ type: "text", markdown: "Looks good so far." }],
      hintLevel: 0,
      title: null,
    };
    return { reply: r, content: [{ type: "text", text: JSON.stringify(r) }] as Anthropic.Beta.BetaContentBlockParam[], usage: { model: "demo", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  async revealsAnswer() {
    return { revealed: false, usage: null };
  }
  async readPage() {
    this.reads++;
    const p = this.pages.shift() ?? { lines: [] };
    return { lines: p.lines, unreadable: p.unreadable ?? null, usage: null };
  }
}

let eng: DeskEngine;
let n = 0;
const JPEG = Buffer.from("fake-jpeg");

async function newKid() {
  n++;
  return createKid({ name: `Desk Kid ${n}`, grade: 7, username: `deskkid${n}`, pin: "2468" });
}

async function pairedStation(name = "Kitchen") {
  const { token, code } = await desk.requestPairing();
  await desk.approveStation(code, name);
  return token;
}
const station = (token: string) => desk.stationForToken(token);

async function watching() {
  const kid = await newKid();
  const token = await pairedStation();
  const { sessionId } = await desk.startAtStation(await station(token), kid.id, "2468");
  return { kid, token, sessionId };
}

beforeAll(async () => {
  await migrate(db as never, { migrationsFolder: "drizzle" });
});

beforeEach(() => {
  eng = new DeskEngine();
  tutor.setEngine(eng);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pairing", () => {
  it("shows a code until a parent approves it, and the token does nothing before then", async () => {
    const { token, code } = await desk.requestPairing();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const s = await station(token);
    expect(await desk.stationState(s)).toMatchObject({ station: { approved: false, pairCode: code }, kids: [] });
    expect(desk.cameraState(s).approved).toBe(false);
    await expect(desk.startAtStation(s, 1, "0000")).rejects.toThrow(/Waiting for a parent/);

    // Codes are forgiving about case and dashes.
    await desk.approveStation(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`, "Kitchen desk");
    const approved = await station(token);
    expect(approved.name).toBe("Kitchen desk");
    expect((await desk.stationState(approved)).station).toMatchObject({ approved: true, pairCode: null });
    await expect(desk.approveStation(code, "again")).rejects.toThrow(/No station is showing that code/);
  });

  it("rejects unknown tokens", async () => {
    await expect(desk.stationForToken("nope")).rejects.toThrow(/isn't paired/);
    await expect(desk.stationForToken(null)).rejects.toThrow(/missing/);
  });

  it("can be renamed and removed", async () => {
    const token = await pairedStation("Old name");
    const s = await station(token);
    await desk.renameStation(s.id, "  Nova's desk ");
    expect((await station(token)).name).toBe("Nova's desk");
    await desk.removeStation(s.id);
    await expect(station(token)).rejects.toThrow(/isn't paired/);
  });
});

describe("starting at the station", () => {
  it("needs the kid's PIN, and locks for a minute after 5 wrong tries", async () => {
    const kid = await newKid();
    const token = await pairedStation();
    for (let i = 0; i < 5; i++) await expect(desk.startAtStation(await station(token), kid.id, "0000")).rejects.toThrow(/didn't match/);
    await expect(desk.startAtStation(await station(token), kid.id, "2468")).rejects.toThrow(/Too many wrong PINs/);
    await db.update(stations).set({ pinLockedUntil: null }).where(eq(stations.tokenHash, desk.hashToken(token)));
    const { sessionId } = await desk.startAtStation(await station(token), kid.id, "2468");
    const st = await desk.stationState(await station(token));
    expect(st.active?.sessionId).toBe(sessionId);
    expect(st.active?.kid.name).toBe(kid.name);
  });

  it("joins the kid's open conversation instead of starting a new one", async () => {
    const kid = await newKid();
    const open = await tutor.startSession(kid.id);
    const token = await pairedStation();
    const { sessionId } = await desk.startAtStation(await station(token), kid.id, "2468");
    expect(sessionId).toBe(open.id);
  });

  it("tells the camera to start, and the Chromebook can attach and stop it", async () => {
    const { token, sessionId } = await watching();
    expect(desk.cameraState(await station(token))).toEqual({ approved: true, watching: true, captureRequested: false });
    expect((await desk.stationsForSession(sessionId)).find((s) => s.watchingThis)).toBeTruthy();
    await desk.stopForSession(sessionId);
    expect(desk.cameraState(await station(token)).watching).toBe(false);
    await desk.attachFromApp((await station(token)).id, sessionId);
    expect((await desk.stationState(await station(token))).active?.sessionId).toBe(sessionId);
  });
});

describe("watching the page", () => {
  it("reads each photo, sends only new handwritten lines to the tutor, and keeps its marks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { token, sessionId } = await watching();

    eng.pages.push({ lines: [PROBLEM, line("3x-12=2x+5")] });
    expect(await desk.handleFrame(await station(token), JPEG, "image/jpeg", false)).toMatchObject({ status: "read", checked: true });
    expect(eng.replies[0]).toBe("[Desk camera] The lines on the page now:\n1. (printed) $3(x-4)=2x+5$\n2. NEW: $3x-12=2x+5$");

    // Another line soon after: read, but the tutor waits so it isn't chatty.
    vi.setSystemTime(Date.now() + 5_000);
    eng.pages.push({ lines: [PROBLEM, line("3x-12=2x+5"), line("x-12=5")] });
    expect(await desk.handleFrame(await station(token), JPEG, "image/jpeg", false)).toMatchObject({ status: "read", checked: false });
    expect(eng.replies).toHaveLength(1);

    // The station's regular tick picks it up once enough time has passed.
    vi.setSystemTime(Date.now() + desk.MIN_CHECK_GAP_MS);
    await desk.tick(await station(token));
    expect(eng.replies).toHaveLength(2);
    expect(eng.replies[1]).toContain("2. $3x-12=2x+5$\n3. NEW: $x-12=5$");

    vi.setSystemTime(Date.now() + desk.MIN_CHECK_GAP_MS);
    eng.pages.push({ lines: [PROBLEM, line("3x-12=2x+5"), line("x-12=5"), line("x=BAD")] });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
    expect(s.desk?.marks.map((m) => m.status)).toEqual(["not_checked", "ok", "ok", "look_here"]);
    expect(s.desk?.marks[3].note).toBe("Check the sign?");
    expect((await desk.stationState(await station(token))).active?.lastReply?.say).toBe("Look again at that line.");

    // Desk turns show the photo in the app but don't send it to the tutor.
    const kidTurns = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    const deskTurn = kidTurns.find((t) => t.role === "kid")!;
    expect(deskTurn.kid).toMatchObject({ source: "desk", uploadIds: [] });
    expect(deskTurn.kid?.snapshotId).toBeGreaterThan(0);
  });

  it("checks right away when the kid taps Check now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { token } = await watching();
    eng.pages.push({ lines: [line("a=1")] }, { lines: [line("a=1"), line("b=2")] });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    vi.setSystemTime(Date.now() + 1_000);
    await desk.requestCheck(await station(token));
    expect(desk.cameraState(await station(token)).captureRequested).toBe(true);
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", true);
    expect(eng.replies).toHaveLength(2);
    expect(desk.cameraState(await station(token)).captureRequested).toBe(false);
  });

  it("doesn't bother the tutor when nothing new was written, or the page can't be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { token, sessionId } = await watching();
    eng.pages.push({ lines: [line("a=1")] });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    vi.setSystemTime(Date.now() + 60_000);
    eng.pages.push({ lines: [line("a=1")] }, { lines: [], unreadable: "A hand is covering the page" }, { lines: [line("a=1"), line("b=2")], unreadable: "Partly covered" });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    expect(await desk.handleFrame(await station(token), JPEG, "image/jpeg", false)).toMatchObject({ status: "unreadable" });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    expect(eng.replies).toHaveLength(1);
    const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
    expect(s.desk?.unreadable).toBe("Partly covered");
  });

  it("starts fresh marks when the page is turned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { token, sessionId } = await watching();
    eng.pages.push({ lines: [line("a=1"), line("b=2")] });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    vi.setSystemTime(Date.now() + 60_000);
    eng.pages.push({ lines: [line("y=3x")] });
    await desk.handleFrame(await station(token), JPEG, "image/jpeg", false);
    const [s] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
    expect(s.desk?.lines.map((l) => l.latex)).toEqual(["y=3x"]);
    expect(s.desk?.marks.map((m) => m.latex)).toEqual(["y=3x"]);
  });

  it("ignores photos while paused or not watching, and one at a time while busy", async () => {
    const { token } = await watching();
    await desk.setPaused(await station(token), true);
    expect(await desk.handleFrame(await station(token), JPEG, "image/jpeg", false)).toEqual({ status: "ignored" });
    await desk.setPaused(await station(token), false);
    await db.update(stations).set({ busySince: new Date() }).where(eq(stations.tokenHash, desk.hashToken(token)));
    expect(await desk.handleFrame(await station(token), JPEG, "image/jpeg", false)).toEqual({ status: "busy" });
    await desk.stopWatching((await station(token)).id);
    expect(await desk.handleFrame(await station(token), JPEG, "image/jpeg", false)).toEqual({ status: "ignored" });
    expect(eng.reads).toBe(0);
  });

  it("offers a hint after a quiet spell, then stops watching after a long one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { token } = await watching();
    expect((await desk.tick(await station(token))).nudge).toBe(false);
    vi.setSystemTime(Date.now() + desk.NUDGE_AFTER_MS + 1000);
    expect((await desk.tick(await station(token))).nudge).toBe(true);
    expect((await desk.tick(await station(token))).nudge).toBe(false); // only once
    vi.setSystemTime(Date.now() + desk.IDLE_STOP_MS);
    expect(await desk.tick(await station(token))).toMatchObject({ stopped: true });
    expect(desk.cameraState(await station(token)).watching).toBe(false);
  });

  it("only shows a station the photos of the kid it's watching", async () => {
    const other = await newKid();
    const { saveUpload } = await import("./uploads");
    const theirs = await saveUpload(other.id, "image/jpeg", JPEG);
    const { token } = await watching();
    await expect(desk.snapshotForStation(await station(token), theirs.id)).rejects.toThrow();
  });
});

describe("helpers", () => {
  it("spots a turned page", () => {
    expect(desk.isNewPage([line("a=1")], [line("a = 1"), line("b=2")])).toBe(false);
    expect(desk.isNewPage([line("a=1")], [line("z=9")])).toBe(true);
    expect(desk.isNewPage([], [line("z=9")])).toBe(false);
  });

  it("skips printed lines and already-checked ones", () => {
    const state = {
      lines: [PROBLEM, line("a=1"), line("b=2")],
      marks: [{ latex: "", status: "not_checked" as const, note: "" }, { latex: "a=1", status: "ok" as const, note: "" }],
      snapshotId: null,
      unreadable: null,
      lastTutorAt: null,
    };
    expect(desk.uncheckedLines(state)).toEqual([2]);
    // A line rewritten after it was checked counts as new again.
    expect(desk.uncheckedLines({ ...state, lines: [PROBLEM, line("a=2"), line("b=2")] })).toEqual([1, 2]);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { tutorSessions, turns, uploads } from "@/db/schema";
import { auth } from "@/lib/auth";
import type { TutorReply } from "@/lib/tutor-reply";
import { canSeeSession } from "./access";
import { createKid, listFlags, setKidPin, updateKid } from "./family";
import * as tutor from "./tutor";
import { echoContent, type TutorEngine } from "./tutor/engine";
import { buildSystemPrompt } from "./tutor/prompt";
import { purgeOldUploads, saveUpload } from "./uploads";

type Msg = Anthropic.Beta.BetaMessageParam;

const reply = (say: string): TutorReply => ({ say, show: [{ type: "text", markdown: say }], hintLevel: 1, title: "Equations" });

/** Records every call; `reveals` decides what the answer check says, call by call. */
class FakeEngine implements TutorEngine {
  readonly demo = false;
  calls: { system: string; messages: Msg[] }[] = [];
  reveals: boolean[] = [];
  async reply(system: string, messages: Msg[]) {
    this.calls.push({ system, messages: structuredClone(messages) });
    const r = reply(`reply ${this.calls.length}`);
    return {
      reply: r,
      content: [
        { type: "thinking", thinking: "", signature: `sig-${this.calls.length}` },
        { type: "text", text: JSON.stringify(r) },
      ] as Anthropic.Beta.BetaContentBlockParam[],
      usage: { model: "claude-opus-5-5", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    };
  }
  async revealsAnswer() {
    return { revealed: this.reveals.shift() ?? false, usage: { model: "claude-haiku-5-5", input: 500, output: 20, cacheRead: 0, cacheWrite: 0 } };
  }
  async readPage() {
    return { lines: [], unreadable: null, usage: null };
  }
}

let fake: FakeEngine;
let n = 0;
const newKid = async (over: Partial<{ grade: number }> = {}) => createKid({ name: `Kid ${++n}`, grade: over.grade ?? 7, username: `kid${n}`, pin: "1234" });
const kidActor = (k: { id: number; userId: string; name: string }) => ({ userId: k.userId, name: k.name, role: "kid" as const, kidId: k.id });

beforeAll(async () => {
  await migrate(db as never, { migrationsFolder: "drizzle" });
});

beforeEach(() => {
  fake = new FakeEngine();
  tutor.setEngine(fake);
});

describe("kid sign-in", () => {
  it("signs in with username + PIN, and a new PIN replaces the old one", async () => {
    const k = await newKid();
    const ok = await auth.api.signInUsername({ body: { username: k.username, password: "1234" }, headers: new Headers() });
    expect(ok?.user.id).toBe(k.userId);
    await expect(auth.api.signInUsername({ body: { username: k.username, password: "9999" }, headers: new Headers() })).rejects.toBeTruthy();

    await setKidPin(k.id, "4321");
    await expect(auth.api.signInUsername({ body: { username: k.username, password: "1234" }, headers: new Headers() })).rejects.toBeTruthy();
    const again = await auth.api.signInUsername({ body: { username: k.username, password: "4321" }, headers: new Headers() });
    expect(again?.user.id).toBe(k.userId);
  });

  it("rejects duplicate usernames and short PINs", async () => {
    const k = await newKid();
    await expect(createKid({ name: "Copy", grade: 7, username: k.username, pin: "1234" })).rejects.toThrow(/taken/);
    await expect(createKid({ name: "Short", grade: 7, username: "shortpin", pin: "12" })).rejects.toThrow();
  });
});

describe("sessions", () => {
  it("freezes the system prompt when the session starts", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    await updateKid(k.id, { assistantName: "Nova" });
    await tutor.sendKidTurn(s.id, k.id, { text: "help with 3(x-4)=2x+5" });
    expect(fake.calls[0].system).toBe(s.systemPrompt);
    expect(fake.calls[0].system).not.toContain("Nova");
    const next = await tutor.startSession(k.id);
    expect(next.systemPrompt).toContain("You are Nova");
  });

  it("only appends to the history Claude sees, and replays reasoning unchanged", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    await tutor.sendKidTurn(s.id, k.id, { text: "first" });
    await tutor.sendKidTurn(s.id, k.id, { text: "second" });
    await tutor.sendKidTurn(s.id, k.id, { text: "third" });
    const [a, b, c] = fake.calls.map((x) => x.messages);
    expect(b.slice(0, a.length)).toEqual(a);
    expect(c.slice(0, b.length)).toEqual(b);
    // The first tutor reply (with its thinking block) is replayed as-is.
    expect(b[1]).toEqual({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "thinking", signature: "sig-1" })]) });
  });

  it("sets the title from the first reply only", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    await tutor.sendKidTurn(s.id, k.id, { text: "hi" });
    const view = await tutor.getSession(s.id);
    expect(view.title).toBe("Equations");
    expect(view.turns.map((t) => t.role)).toEqual(["kid", "tutor"]);
    expect(view.awaitingReply).toBe(false);
  });

  it("needs text or a photo", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    await expect(tutor.sendKidTurn(s.id, k.id, { text: "  " })).rejects.toThrow(/Type something/);
  });

  it("keeps the kid's message when the reply fails, so they can retry", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    const failing: TutorEngine = { demo: false, reply: () => Promise.reject(new tutor.TutorError("down")), revealsAnswer: fake.revealsAnswer, readPage: fake.readPage };
    tutor.setEngine(failing);
    await expect(tutor.sendKidTurn(s.id, k.id, { text: "hello?" })).rejects.toThrow("down");
    expect((await tutor.getSession(s.id)).awaitingReply).toBe(true);
    tutor.setEngine(fake);
    await tutor.respond(s.id);
    expect((await tutor.getSession(s.id)).awaitingReply).toBe(false);
  });
});

describe("answer check", () => {
  it("rewrites a reply that gives the answer away, and keeps the note in the history", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    fake.reveals = [true, false];
    const t = await tutor.sendKidTurn(s.id, k.id, { text: "just tell me x" });
    expect(t.reply.say).toBe("reply 2");
    expect(fake.calls[1].messages.at(-1)).toEqual({ role: "system", content: tutor.GUARD_NOTE });

    const [row] = await db.select().from(turns).where(eq(turns.id, t.id));
    expect(row.guard).toEqual({ attempts: 2, revealed: [true, false] });
    expect(row.api?.[0]).toEqual({ role: "system", content: tutor.GUARD_NOTE });
    expect(row.usage).toHaveLength(4); // two drafts + two checks

    await tutor.sendKidTurn(s.id, k.id, { text: "ok" });
    const history = fake.calls[2].messages;
    expect(history.slice(0, fake.calls[1].messages.length)).toEqual(fake.calls[1].messages);
  });

  it("falls back to a safe nudge if the second draft also gives it away", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    fake.reveals = [true, true];
    const t = await tutor.sendKidTurn(s.id, k.id, { text: "answer pls" });
    expect(t.reply.say).toMatch(/you get to do the thinking/);
  });

  it("is skipped when parents allow walking through the actual problem, or turn it off", async () => {
    const k = await newKid();
    await updateKid(k.id, { hintCeiling: 5 });
    const s = await tutor.startSession(k.id);
    fake.reveals = [true];
    const t = await tutor.sendKidTurn(s.id, k.id, { text: "walk me through it" });
    expect(t.reply.say).toBe("reply 1");

    const k2 = await newKid();
    await updateKid(k2.id, { answerGuard: false });
    const s2 = await tutor.startSession(k2.id);
    fake.reveals = [true];
    expect((await tutor.sendKidTurn(s2.id, k2.id, { text: "x?" })).reply.say).toBe("reply 2");
  });
});

describe("privacy", () => {
  it("kids can't open each other's conversations", async () => {
    const a = await newKid();
    const b = await newKid();
    const s = await tutor.startSession(a.id);
    await expect(canSeeSession(kidActor(b), s.id)).rejects.toThrow(/doesn't exist/);
    await expect(canSeeSession(kidActor(a), s.id)).resolves.toBeTruthy();
    await expect(canSeeSession({ userId: "p", name: "Parent", role: "parent", kidId: null }, s.id)).resolves.toBeTruthy();
  });

  it("kids can only attach their own uploads", async () => {
    const a = await newKid();
    const b = await newKid();
    const up = await saveUpload(a.id, "image/png", Buffer.from("fakepng"));
    const s = await tutor.startSession(b.id);
    await expect(tutor.sendKidTurn(s.id, b.id, { uploadIds: [up.id] })).rejects.toThrow(/couldn't be found/);
  });

  it("sends photos to Claude as images, and deletes them after 30 days", async () => {
    const k = await newKid();
    const up = await saveUpload(k.id, "image/jpeg", Buffer.from("jpegbytes"));
    const s = await tutor.startSession(k.id);
    await tutor.sendKidTurn(s.id, k.id, { text: "this one", uploadIds: [up.id] });
    expect(fake.calls[0].messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("jpegbytes").toString("base64") } },
      { type: "text", text: "this one" },
    ]);
    await purgeOldUploads(new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(await db.select().from(uploads).where(eq(uploads.id, up.id))).toHaveLength(0);
  });

  it("rejects files that aren't photos or PDFs", async () => {
    const k = await newKid();
    await expect(saveUpload(k.id, "text/html", Buffer.from("<script>"))).rejects.toThrow(/photo, screenshot or PDF/);
  });
});

describe("flags", () => {
  it("flags a conversation, and resolving it clears it from the open list", async () => {
    const k = await newKid();
    const s = await tutor.startSession(k.id);
    await tutor.flagSession(s.id, "  don't get step 2 ");
    expect((await listFlags(k.id)).map((f) => f.flagNote)).toEqual(["don't get step 2"]);
    await tutor.setFlagResolved(s.id, true);
    expect(await listFlags(k.id)).toHaveLength(0);
    expect(await listFlags(k.id, true)).toHaveLength(1);
    const [row] = await db.select().from(tutorSessions).where(eq(tutorSessions.id, s.id));
    expect(row.flagResolvedAt).not.toBeNull();
  });
});

describe("system prompt", () => {
  const base = { name: "Sam", grade: 7, assistantName: "Atlas", personaPreset: "butler", personaNotes: "" };

  it("marks rungs above the ceiling as not allowed and forbids answers", () => {
    const p = buildSystemPrompt({ ...base, hintCeiling: 3 });
    expect(p).toContain("4. Similar example: Work a similar problem start to finish (different numbers), never theirs. (NOT ALLOWED");
    expect(p).toContain("3. First step: Show the first step of their problem, then hand it back.\n");
    expect(p).toContain("Never state the final answer");
  });

  it("allows walking through the actual problem at rung 5", () => {
    const p = buildSystemPrompt({ ...base, hintCeiling: 5 });
    expect(p).not.toContain("NOT ALLOWED");
    expect(p).toContain("At rung 5 you may walk through their actual problem");
  });

  it("includes the parents' personality notes and never writes essays", () => {
    const p = buildSystemPrompt({ ...base, hintCeiling: 4, personaNotes: "Loves soccer analogies." });
    expect(p).toContain("Notes from Sam's parents: Loves soccer analogies.");
    expect(p).toContain("Never write sentences, paragraphs or essays for them");
  });

  it("is deterministic (same settings, same prompt)", () => {
    expect(buildSystemPrompt({ ...base, hintCeiling: 4 })).toBe(buildSystemPrompt({ ...base, hintCeiling: 4 }));
  });
});

describe("echoContent", () => {
  it("drops the SDK's parsed copy and, after a fallback, earlier model-internal blocks", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "a" },
      { type: "fallback", from: { model: "x" }, to: { model: "y" } },
      { type: "thinking", thinking: "", signature: "b" },
      { type: "text", text: "{}", citations: null, parsed_output: {} },
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(echoContent(content)).toEqual([
      { type: "thinking", thinking: "", signature: "b" },
      { type: "text", text: "{}" },
    ]);
  });
});

describe("cost estimate", () => {
  it("prices Opus and Haiku usage", () => {
    const usd = tutor.estimateCost([
      { model: "claude-opus-5-5", input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
      { model: "claude-haiku-5-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { model: "demo", input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(usd).toBeCloseTo(4 + 2 + 0.1);
  });
});

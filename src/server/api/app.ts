import { Hono, type Context } from "hono";
import { z } from "zod";
import { getActor, canSeeSession, requireActor, requireKid, requireParent, type Actor } from "../access";
import { HttpError, badRequest, notFound } from "../errors";
import * as desk from "../desk";
import * as family from "../family";
import * as tutor from "../tutor";
import { getUpload, saveUpload } from "../uploads";
import { elevenLabsConfigured, elevenLabsSpeech } from "../tts";

type Env = { Variables: { actor: Actor | null } };

export const api = new Hono<Env>().basePath("/api/v1");

api.use("*", async (c, next) => {
  c.set("actor", await getActor(c.req.raw.headers));
  await next();
});

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
  if (err instanceof tutor.TutorError) return c.json({ error: err.message }, 502);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

const id = (c: Context, name = "id") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw badRequest("Expected a JSON body");
  });
  return schema.parse(raw);
}

// ---------- me ----------

api.get("/me", async (c) => {
  const a = requireActor(c.get("actor"));
  if (a.role === "parent") return c.json({ ...a, kid: null });
  return c.json({ ...a, kid: await family.getKid(a.kidId!) });
});

// ---------- parent: family ----------

api.get("/kids", async (c) => {
  requireParent(c.get("actor"));
  return c.json(await family.listKids());
});

api.post("/kids", async (c) => {
  requireParent(c.get("actor"));
  return c.json(await family.createKid(await body(c, family.NewKid)), 201);
});

api.get("/kids/:id", async (c) => {
  requireParent(c.get("actor"));
  return c.json(await family.getKid(id(c)));
});

api.patch("/kids/:id", async (c) => {
  requireParent(c.get("actor"));
  return c.json(await family.updateKid(id(c), await body(c, family.KidSettings.partial())));
});

api.post("/kids/:id/pin", async (c) => {
  requireParent(c.get("actor"));
  const { pin } = await body(c, z.object({ pin: family.Pin }));
  await family.setKidPin(id(c), pin);
  return c.json({ ok: true });
});

api.delete("/kids/:id", async (c) => {
  requireParent(c.get("actor"));
  await family.deleteKid(id(c));
  return c.json({ ok: true });
});

api.get("/kids/:id/sessions", async (c) => {
  requireParent(c.get("actor"));
  return c.json(await tutor.listSessions(id(c), 100));
});

api.get("/usage", async (c) => {
  requireParent(c.get("actor"));
  return c.json({
    monthToDateUsd: await tutor.monthToDateCost(),
    demo: tutor.engine().demo,
    elevenLabs: elevenLabsConfigured(),
  });
});

// ---------- flags (kid: their own; parent: any kid's) ----------

api.get("/flags", async (c) => {
  const a = requireActor(c.get("actor"));
  const kidId = a.role === "kid" ? a.kidId! : Number(c.req.query("kid"));
  if (!kidId) throw badRequest("Which kid?");
  return c.json(await family.listFlags(kidId, c.req.query("all") === "1"));
});

// ---------- sessions ----------

api.get("/sessions", async (c) => {
  const a = requireKid(c.get("actor"));
  return c.json(await tutor.listSessions(a.kidId));
});

api.post("/sessions", async (c) => {
  const a = requireKid(c.get("actor"));
  const s = await tutor.startSession(a.kidId);
  return c.json({ id: s.id }, 201);
});

api.get("/sessions/:id", async (c) => {
  const a = requireActor(c.get("actor"));
  await canSeeSession(a, id(c));
  return c.json(await tutor.getSession(id(c)));
});

const TurnBody = z.object({ text: z.string().max(8000).default(""), uploadIds: z.array(z.number().int().positive()).max(5).default([]) });

api.post("/sessions/:id/turns", async (c) => {
  const a = requireKid(c.get("actor"));
  await canSeeSession(a, id(c));
  return c.json(await tutor.sendKidTurn(id(c), a.kidId, await body(c, TurnBody)));
});

api.post("/sessions/:id/retry", async (c) => {
  const a = requireKid(c.get("actor"));
  await canSeeSession(a, id(c));
  return c.json(await tutor.respond(id(c)));
});

api.post("/sessions/:id/flag", async (c) => {
  const a = requireKid(c.get("actor"));
  await canSeeSession(a, id(c));
  const { note } = await body(c, z.object({ note: z.string().max(500).nullable().default(null) }));
  await tutor.flagSession(id(c), note);
  return c.json({ ok: true });
});

/** Mark a flag as gone over together (or reopen it). Either the parent or the kid can. */
api.post("/sessions/:id/resolve", async (c) => {
  const a = requireActor(c.get("actor"));
  await canSeeSession(a, id(c));
  const { resolved } = await body(c, z.object({ resolved: z.boolean() }));
  await tutor.setFlagResolved(id(c), resolved);
  return c.json({ ok: true });
});

// ---------- uploads ----------

api.post("/uploads", async (c) => {
  const a = requireKid(c.get("actor"));
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim();
  const data = Buffer.from(await c.req.arrayBuffer());
  return c.json(await saveUpload(a.kidId, type, data), 201);
});

api.get("/uploads/:id", async (c) => {
  const a = requireActor(c.get("actor"));
  const u = await getUpload(id(c));
  if (a.role === "kid" && u.kidId !== a.kidId) throw notFound();
  return new Response(new Uint8Array(u.data), {
    headers: { "content-type": u.mediaType, "cache-control": "private, max-age=86400" },
  });
});

// ---------- voice ----------

/** Parents audition a natural voice before saving it to a profile. */
api.post("/voice-preview", async (c) => {
  requireParent(c.get("actor"));
  const { text, voiceId } = await body(c, z.object({ text: z.string().max(300), voiceId: z.string().max(200) }));
  return elevenLabsSpeech(text, voiceId);
});

api.post("/tts", async (c) => {
  const a = requireKid(c.get("actor"));
  const { text } = await body(c, z.object({ text: z.string().max(1000) }));
  const kid = await family.getKid(a.kidId);
  return elevenLabsSpeech(text, kid.voiceId);
});

// ---------- desk stations: parent management ----------

api.get("/stations", async (c) => {
  requireParent(c.get("actor"));
  return c.json(await desk.listStations());
});

api.post("/stations/approve", async (c) => {
  requireParent(c.get("actor"));
  const { code, name } = await body(c, z.object({ code: z.string().min(4).max(20), name: z.string().max(40).default("Desk station") }));
  return c.json(await desk.approveStation(code, name));
});

api.patch("/stations/:id", async (c) => {
  requireParent(c.get("actor"));
  const { name } = await body(c, z.object({ name: z.string().max(40) }));
  return c.json(await desk.renameStation(id(c), name));
});

api.delete("/stations/:id", async (c) => {
  requireParent(c.get("actor"));
  await desk.removeStation(id(c));
  return c.json({ ok: true });
});

// ---------- desk stations: from a conversation ----------

api.get("/sessions/:id/desk", async (c) => {
  const a = requireActor(c.get("actor"));
  await canSeeSession(a, id(c));
  return c.json(await desk.stationsForSession(id(c)));
});

api.post("/sessions/:id/desk", async (c) => {
  const a = requireKid(c.get("actor"));
  await canSeeSession(a, id(c));
  const { stationId } = await body(c, z.object({ stationId: z.number().int().positive() }));
  await desk.attachFromApp(stationId, id(c));
  return c.json({ ok: true });
});

api.delete("/sessions/:id/desk", async (c) => {
  const a = requireActor(c.get("actor"));
  await canSeeSession(a, id(c));
  await desk.stopForSession(id(c));
  return c.json({ ok: true });
});

// ---------- desk stations: the station itself (signs in with its own token) ----------

/** A new station asks for a pairing code. No sign-in: the code does nothing until a parent approves it. */
api.post("/stations/pair", async (c) => c.json(await desk.requestPairing(), 201));

const stationOf = (c: Context) => desk.stationForToken(c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? null);

api.get("/station/camera", async (c) => c.json(desk.cameraState(await stationOf(c))));

api.get("/station/state", async (c) => c.json(await desk.stationState(await stationOf(c))));

api.post("/station/tick", async (c) => {
  const s = await stationOf(c);
  const t = await desk.tick(s);
  return c.json({ ...(await desk.stationState(await stationOf(c))), nudge: t.nudge });
});

api.post("/station/start", async (c) => {
  const s = await stationOf(c);
  const { kidId, pin } = await body(c, z.object({ kidId: z.number().int().positive(), pin: z.string().max(8) }));
  return c.json(await desk.startAtStation(s, kidId, pin));
});

api.post("/station/stop", async (c) => {
  const s = await stationOf(c);
  await desk.stopWatching(s.id);
  return c.json({ ok: true });
});

api.post("/station/pause", async (c) => {
  const s = await stationOf(c);
  const { paused } = await body(c, z.object({ paused: z.boolean() }));
  await desk.setPaused(s, paused);
  return c.json({ ok: true });
});

api.post("/station/check", async (c) => {
  await desk.requestCheck(await stationOf(c));
  return c.json({ ok: true });
});

api.post("/station/hint", async (c) => c.json(await desk.hint(await stationOf(c))));

api.post("/station/flag", async (c) => {
  await desk.flagFromStation(await stationOf(c));
  return c.json({ ok: true });
});

api.post("/station/frames", async (c) => {
  const s = await stationOf(c);
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim();
  const data = Buffer.from(await c.req.arrayBuffer());
  return c.json(await desk.handleFrame(s, data, type, c.req.query("requested") === "1"));
});

api.get("/station/snapshots/:id", async (c) => {
  const u = await desk.snapshotForStation(await stationOf(c), id(c));
  return new Response(new Uint8Array(u.data), { headers: { "content-type": u.mediaType, "cache-control": "private, max-age=3600" } });
});

api.post("/station/tts", async (c) => {
  const s = await stationOf(c);
  const { text } = await body(c, z.object({ text: z.string().max(1000) }));
  const st = await desk.stationState(s);
  if (!st.active) throw badRequest("Nothing is being watched");
  return elevenLabsSpeech(text, st.active.kid.voiceId);
});

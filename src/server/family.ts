import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { kids, session, tutorSessions, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { DEFAULT_HINT_CEILING, MAX_HINT, MIN_HINT } from "@/lib/hints";
import { PERSONA_KEYS } from "@/lib/personas";
import { badRequest, conflict, notFound } from "./errors";

export const VOICE_PROVIDERS = ["browser", "elevenlabs"] as const;

export const KidSettings = z.object({
  name: z.string().trim().min(1).max(40),
  grade: z.number().int().min(1).max(12),
  hintCeiling: z.number().int().min(MIN_HINT).max(MAX_HINT),
  answerGuard: z.boolean(),
  assistantName: z.string().trim().min(1).max(30),
  personaPreset: z.enum(PERSONA_KEYS as [string, ...string[]]),
  personaNotes: z.string().max(1000),
  voiceProvider: z.enum(VOICE_PROVIDERS),
  voiceId: z.string().trim().max(200),
});
export type KidSettings = z.infer<typeof KidSettings>;

export const NewKid = z.object({
  name: z.string().trim().min(1).max(40),
  grade: z.number().int().min(1).max(12),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.]{3,30}$/, "Usernames are 3-30 letters, numbers, dots or underscores"),
  pin: z.string().regex(/^\d{4,8}$/, "PINs are 4-8 digits"),
});

export const Pin = z.string().regex(/^\d{4,8}$/, "PINs are 4-8 digits");

/** Kids don't have email addresses here; Better Auth needs one, so each gets a placeholder. */
const kidEmail = (username: string) => `${username}@kids.invalid`;

export async function listKids() {
  const rows = await db
    .select({ kid: kids, username: user.username })
    .from(kids)
    .innerJoin(user, eq(user.id, kids.userId))
    .orderBy(kids.name);
  const flags = await db
    .select({ kidId: tutorSessions.kidId, n: count() })
    .from(tutorSessions)
    .where(and(isNotNull(tutorSessions.flaggedAt), isNull(tutorSessions.flagResolvedAt)))
    .groupBy(tutorSessions.kidId);
  return rows.map((r) => ({ ...r.kid, username: r.username ?? "", openFlags: flags.find((f) => f.kidId === r.kid.id)?.n ?? 0 }));
}

export async function getKid(id: number) {
  const [row] = await db
    .select({ kid: kids, username: user.username })
    .from(kids)
    .innerJoin(user, eq(user.id, kids.userId))
    .where(eq(kids.id, id));
  if (!row) throw notFound("No kid with that id");
  return { ...row.kid, username: row.username ?? "" };
}

export async function createKid(input: z.input<typeof NewKid>) {
  const k = NewKid.parse(input);
  const ctx = await auth.$context;
  const [taken] = await db.select({ id: user.id }).from(user).where(eq(user.username, k.username));
  if (taken) throw conflict(`The username "${k.username}" is taken`);

  const created = await ctx.internalAdapter.createUser(
    { email: kidEmail(k.username), name: k.name, emailVerified: true, username: k.username, displayUsername: k.username },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await ctx.password.hash(k.pin),
  });
  const [kid] = await db
    .insert(kids)
    .values({ userId: created.id, name: k.name, grade: k.grade, hintCeiling: DEFAULT_HINT_CEILING })
    .returning();
  return { ...kid, username: k.username };
}

export async function updateKid(id: number, input: Partial<KidSettings>) {
  const patch = KidSettings.partial().parse(input);
  const [kid] = await db.update(kids).set(patch).where(eq(kids.id, id)).returning();
  if (!kid) throw notFound("No kid with that id");
  if (patch.name) await db.update(user).set({ name: patch.name }).where(eq(user.id, kid.userId));
  return getKid(id);
}

export async function setKidPin(id: number, pin: string) {
  const p = Pin.safeParse(pin);
  if (!p.success) throw badRequest("PINs are 4-8 digits");
  const kid = await getKid(id);
  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(kid.userId, await ctx.password.hash(p.data));
  // Sign them out everywhere so the old PIN stops working right away.
  await db.delete(session).where(eq(session.userId, kid.userId));
}

export async function deleteKid(id: number) {
  const kid = await getKid(id);
  await db.delete(user).where(eq(user.id, kid.userId)); // cascades to the profile, sessions and uploads
}

/** Flagged conversations, newest first. Open ones (not yet gone over together) unless `all`. */
export async function listFlags(kidId: number, all = false) {
  return db
    .select({
      id: tutorSessions.id,
      title: tutorSessions.title,
      flaggedAt: tutorSessions.flaggedAt,
      flagNote: tutorSessions.flagNote,
      flagResolvedAt: tutorSessions.flagResolvedAt,
    })
    .from(tutorSessions)
    .where(
      and(
        eq(tutorSessions.kidId, kidId),
        isNotNull(tutorSessions.flaggedAt),
        all ? undefined : isNull(tutorSessions.flagResolvedAt),
      ),
    )
    .orderBy(desc(tutorSessions.flaggedAt));
}

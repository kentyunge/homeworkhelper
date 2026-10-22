import { eq } from "drizzle-orm";
import { db } from "@/db";
import { kids, tutorSessions } from "@/db/schema";
import { auth } from "@/lib/auth";
import { forbidden, notFound, unauthorized } from "./errors";

export interface Actor {
  userId: string;
  name: string;
  role: "parent" | "kid";
  /** Set for kids. */
  kidId: number | null;
}

export async function getActor(headers: Headers): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const u = session.user as typeof session.user & { role?: string };
  if (u.role === "parent") return { userId: u.id, name: u.name, role: "parent", kidId: null };
  const [kid] = await db.select({ id: kids.id, name: kids.name }).from(kids).where(eq(kids.userId, u.id));
  if (!kid) return null; // a login with no profile (e.g. the profile was deleted)
  return { userId: u.id, name: kid.name, role: "kid", kidId: kid.id };
}

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw unauthorized();
  return actor;
}

export function requireParent(actor: Actor | null): Actor {
  const a = requireActor(actor);
  if (a.role !== "parent") throw forbidden("Parents only");
  return a;
}

export function requireKid(actor: Actor | null): Actor & { kidId: number } {
  const a = requireActor(actor);
  if (a.role !== "kid" || a.kidId === null) throw forbidden("Kids only");
  return a as Actor & { kidId: number };
}

/** Kids see only their own sessions; parents see all of them. */
export async function canSeeSession(actor: Actor, sessionId: number) {
  const [s] = await db.select({ kidId: tutorSessions.kidId }).from(tutorSessions).where(eq(tutorSessions.id, sessionId));
  if (!s) throw notFound("That conversation doesn't exist");
  if (actor.role === "kid" && actor.kidId !== s.kidId) throw notFound("That conversation doesn't exist");
  return s;
}

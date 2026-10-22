import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getActor } from "./access";

export const getPageActor = cache(async () => getActor(await headers()));

export async function requirePageActor() {
  const actor = await getPageActor();
  if (!actor) redirect("/login");
  return actor;
}

export async function requirePageParent() {
  const actor = await requirePageActor();
  if (actor.role !== "parent") redirect("/");
  return actor;
}

export async function requirePageKid() {
  const actor = await requirePageActor();
  if (actor.role !== "kid") redirect("/parent");
  return actor as typeof actor & { kidId: number };
}

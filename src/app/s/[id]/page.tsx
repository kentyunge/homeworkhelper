import { notFound } from "next/navigation";
import { Header } from "@/components/layout/header";
import { canSeeSession } from "@/server/access";
import { HttpError } from "@/server/errors";
import { getKid } from "@/server/family";
import { requirePageActor } from "@/server/session";
import { SessionView } from "./session-view";

export const metadata = { title: "Study session" };

export default async function SessionPage({ params, searchParams }: PageProps<"/s/[id]">) {
  const actor = await requirePageActor();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  let kidId: number;
  try {
    kidId = (await canSeeSession(actor, id)).kidId;
  } catch (e) {
    if (e instanceof HttpError) notFound();
    throw e;
  }
  const kid = await getKid(kidId);
  const { u } = await searchParams;
  const isKid = actor.role === "kid";
  return (
    <>
      <Header name={isKid ? kid.name : `${actor.name} (parent)`} home={isKid ? "/" : `/parent/kids/${kid.id}`} />
      <SessionView
        id={id}
        readOnly={!isKid}
        assistantName={kid.assistantName}
        voiceProvider={kid.voiceProvider as "browser" | "elevenlabs"}
        voiceId={kid.voiceId}
        initialUpload={isKid && typeof u === "string" ? Number(u) || null : null}
        backHref={isKid ? "/" : `/parent/kids/${kid.id}`}
      />
    </>
  );
}

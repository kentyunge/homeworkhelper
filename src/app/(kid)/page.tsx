import { Header } from "@/components/layout/header";
import { getKid } from "@/server/family";
import { requirePageKid } from "@/server/session";
import { KidHome } from "./kid-home";

export default async function HomePage() {
  const actor = await requirePageKid();
  const kid = await getKid(actor.kidId);
  return (
    <>
      <Header name={kid.name} home="/" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <KidHome name={kid.name} assistantName={kid.assistantName} />
      </main>
    </>
  );
}

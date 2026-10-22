import { Header } from "@/components/layout/header";
import { requirePageParent } from "@/server/session";

export default async function ParentLayout({ children }: LayoutProps<"/parent">) {
  const actor = await requirePageParent();
  return (
    <>
      <Header name={actor.name} home="/parent" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">{children}</main>
    </>
  );
}

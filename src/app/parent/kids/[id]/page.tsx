import { KidSettingsView } from "./kid-settings";

export const metadata = { title: "Settings" };

export default async function KidPage({ params }: PageProps<"/parent/kids/[id]">) {
  return <KidSettingsView id={Number((await params).id)} />;
}

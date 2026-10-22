import { redirect } from "next/navigation";
import { getPageActor } from "@/server/session";
import { AuthShell } from "./auth-shell";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getPageActor()) redirect("/");
  const { error } = await searchParams;
  return (
    <AuthShell>
      <LoginForm error={typeof error === "string" ? error : null} />
    </AuthShell>
  );
}

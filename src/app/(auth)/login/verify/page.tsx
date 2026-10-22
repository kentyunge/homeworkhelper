import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getPageActor } from "@/server/session";
import { AuthShell } from "../auth-shell";
import { VerifyButton } from "./verify-button";

export const metadata = { title: "Sign in" };

/**
 * Landing page for the emailed sign-in link. Opening it does nothing on its own (so email
 * scanners that open links can't use it up); the parent presses the button to sign in.
 */
export default async function VerifyPage({ searchParams }: PageProps<"/login/verify">) {
  const { token } = await searchParams;
  const actor = await getPageActor();
  return (
    <AuthShell>
      <Card>
        <CardContent className="space-y-4 text-center">
          {actor ? (
            <>
              <p className="text-sm">You&apos;re already signed in as {actor.name}.</p>
              <Button asChild className="w-full">
                <Link href="/">Continue</Link>
              </Button>
            </>
          ) : typeof token === "string" && token ? (
            <VerifyButton token={token} />
          ) : (
            <>
              <p className="text-sm">This sign-in link is incomplete. Request a new one.</p>
              <Button asChild variant="outline" className="w-full">
                <Link href="/login">Back to sign in</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

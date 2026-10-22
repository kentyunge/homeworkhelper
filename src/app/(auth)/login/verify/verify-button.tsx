"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

export function VerifyButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setBusy(true);
    // A used or expired token comes back as a redirect rather than an error, so confirm a session exists.
    const { error } = await authClient.magicLink.verify({ query: { token } });
    const session = error ? null : (await authClient.getSession()).data;
    if (!session) {
      setBusy(false);
      setFailed(true);
      return;
    }
    router.push("/");
    router.refresh();
  }

  if (failed) {
    return (
      <div className="space-y-3">
        <p className="font-medium">This sign-in link has expired or was already used.</p>
        <p className="text-muted-foreground text-sm">
          Links work once and last 15 minutes. Send yourself a new one, or use the 6-digit code from the email.
        </p>
        <Button asChild className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">Press the button to finish signing in on this device.</p>
      <Button className="w-full" size="lg" onClick={signIn} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </div>
  );
}

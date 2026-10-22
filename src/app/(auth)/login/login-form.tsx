"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GraduationCap, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient } from "@/lib/auth/client";

function errorMessage(code: string): string {
  if (code === "INVALID_TOKEN" || code === "EXPIRED_TOKEN") return "That sign-in link has expired or was already used. Send yourself a new one.";
  return "Sign-in didn't work. Please try again.";
}

export function LoginForm({ error }: { error: string | null }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  function signedIn() {
    router.push("/");
    router.refresh();
  }

  async function kidSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await authClient.signIn.username({ username: username.trim().toLowerCase(), password: pin, rememberMe: true });
    setBusy(false);
    if (error) {
      toast.error("That username and PIN don't match.");
      setPin("");
      return;
    }
    signedIn();
  }

  async function sendEmail(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    const { error } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: "/", errorCallbackURL: "/login" });
    setBusy(false);
    if (error) toast.error(error.message ?? "Could not send the email");
    else {
      setCode("");
      setSent(true);
    }
  }

  async function signInCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
    setBusy(false);
    if (error) {
      toast.error(error.code === "TOO_MANY_ATTEMPTS" ? "Too many tries. Send yourself a new code." : "That code didn't work.");
      return;
    }
    signedIn();
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        {error && !sent && (
          <p role="alert" className="border-warn/40 bg-warn/10 text-warn rounded-md border p-3 text-sm">
            {errorMessage(error)}
          </p>
        )}
        <Tabs defaultValue="kid">
          <TabsList className="w-full">
            <TabsTrigger value="kid">
              <GraduationCap /> Student
            </TabsTrigger>
            <TabsTrigger value="parent">
              <Mail /> Parent
            </TabsTrigger>
          </TabsList>

          <TabsContent value="kid" className="pt-4">
            <form onSubmit={kidSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pin">PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  pattern="[0-9]{4,8}"
                  maxLength={8}
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  className="text-center text-xl tracking-[0.4em]"
                />
              </div>
              <Button type="submit" className="w-full" size="lg" disabled={busy || pin.length < 4}>
                {busy ? "Signing in…" : "Let's go"}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="parent" className="pt-4">
            {sent ? (
              <form onSubmit={signInCode} className="space-y-4">
                <div className="space-y-1 text-center text-sm">
                  <p className="font-medium">Check your email</p>
                  <p className="text-muted-foreground">If {email} is a parent account, a sign-in link and code are on the way.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">6-digit code</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="text-center text-2xl font-semibold tracking-[0.4em] tabular-nums"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
                <div className="flex justify-center gap-4 text-sm">
                  <Button type="button" variant="link" className="h-auto p-0" onClick={sendEmail} disabled={busy}>
                    Send a new email
                  </Button>
                  <Button type="button" variant="link" className="h-auto p-0" onClick={() => setSent(false)}>
                    Use a different email
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={sendEmail} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? "Sending…" : "Email me a sign-in link"}
                </Button>
              </form>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

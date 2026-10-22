"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { APP_NAME } from "@/lib/app";

export function Header({ name, home, children }: { name: string; home: string; children?: React.ReactNode }) {
  const router = useRouter();
  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <header className="border-border/60 bg-background/70 sticky top-0 z-20 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
        <Link href={home} className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="orb-core inline-block size-5 rounded-full" aria-hidden />
          {APP_NAME}
        </Link>
        <div className="ml-auto flex items-center gap-2">
          {children}
          <span className="text-muted-foreground hidden text-sm sm:inline">{name}</span>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut />
          </Button>
        </div>
      </div>
    </header>
  );
}

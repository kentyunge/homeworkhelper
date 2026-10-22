import { Orb } from "@/components/voice/orb";
import { APP_NAME } from "@/lib/app";

/** Logo, title and centered card area shared by the sign-in pages. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Orb state="idle" size={72} />
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="text-muted-foreground text-sm">Let&apos;s think it through together.</p>
        </div>
        {children}
      </div>
    </main>
  );
}

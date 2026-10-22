"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, ChevronRight, Flag, Keyboard, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/voice/orb";
import { api } from "@/lib/api-client";
import { uploadFile } from "@/lib/upload-client";
import { cn } from "@/lib/utils";

type SessionRow = { id: number; title: string; lastActivityAt: string; flaggedAt: string | null; flagResolvedAt: string | null };

function greeting(now: Date) {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function KidHome({ name, assistantName }: { name: string; assistantName: string }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<null | "photo" | "file" | "type">(null);
  const [hello, setHello] = useState("Hi");
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<SessionRow[]>("/sessions")
      .then(setSessions)
      .catch(() => {});
  }, []);

  useEffect(() => {
    // The greeting depends on the viewer's clock, so it's set after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHello(greeting(new Date()));
    load();
    // Refresh now and then, so a photo sent from a phone shows up here too.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function start(kind: "photo" | "file" | "type", f?: File) {
    setBusy(kind);
    try {
      const uploadId = f ? await uploadFile(f) : null;
      const { id } = await api<{ id: number }>("/sessions", { method: "POST", body: {} });
      router.push(uploadId ? `/s/${id}?u=${uploadId}` : `/s/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  }

  const openFlags = (sessions ?? []).filter((s) => s.flaggedAt && !s.flagResolvedAt);

  return (
    <div className="space-y-8">
      <section className="flex flex-col items-center gap-4 pt-4 text-center">
        <Orb state={busy ? "thinking" : "idle"} size={96} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {hello}, {name}.
          </h1>
          <p className="text-muted-foreground mt-1">I&apos;m {assistantName}. What are we working on?</p>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <StartButton icon={Camera} label="Snap a photo" hint="Point at your worksheet" busy={busy === "photo"} disabled={!!busy} onClick={() => camera.current?.click()} primary />
        <StartButton icon={Paperclip} label="Upload a file" hint="Screenshot or PDF" busy={busy === "file"} disabled={!!busy} onClick={() => file.current?.click()} />
        <StartButton icon={Keyboard} label="Type it in" hint="Or just talk" busy={busy === "type"} disabled={!!busy} onClick={() => start("type")} />
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) start("photo", f);
          }}
        />
        <input
          ref={file}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) start("file", f);
          }}
        />
      </section>

      {openFlags.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-warn flex items-center gap-2 text-sm font-semibold tracking-widest uppercase">
            <Flag className="size-4" /> To go over with a parent
          </h2>
          <List rows={openFlags} />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-muted-foreground text-sm font-semibold tracking-widest uppercase">Recent</h2>
        {sessions === null ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing yet. Snap a photo of a problem to get started.</p>
        ) : sessions.some((s) => !openFlags.includes(s)) ? (
          <List rows={sessions.filter((s) => !openFlags.includes(s))} />
        ) : (
          <p className="text-muted-foreground text-sm">Nothing else yet.</p>
        )}
      </section>
    </div>
  );
}

function StartButton({
  icon: Icon,
  label,
  hint,
  onClick,
  busy,
  disabled,
  primary,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group flex items-center gap-3 rounded-xl border p-4 text-left transition sm:flex-col sm:items-start",
        primary ? "border-primary/50 bg-primary/10 hover:bg-primary/15" : "border-border bg-card/60 hover:bg-card",
        "disabled:opacity-60",
      )}
    >
      <Icon className={cn("size-6", primary ? "text-primary" : "text-muted-foreground")} />
      <span>
        <span className="block font-semibold">{busy ? "One sec…" : label}</span>
        <span className="text-muted-foreground block text-sm">{hint}</span>
      </span>
    </button>
  );
}

function List({ rows }: { rows: SessionRow[] }) {
  return (
    <ul className="border-border bg-card/50 divide-border divide-y overflow-hidden rounded-xl border">
      {rows.map((s) => (
        <li key={s.id}>
          <Link href={`/s/${s.id}`} className="hover:bg-accent/50 flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{s.title}</span>
              <span className="text-muted-foreground text-xs">{ago(s.lastActivityAt)}</span>
            </span>
            {s.flaggedAt && !s.flagResolvedAt && <Flag className="text-warn size-4" aria-label="Flagged" />}
            <ChevronRight className="text-muted-foreground size-4" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

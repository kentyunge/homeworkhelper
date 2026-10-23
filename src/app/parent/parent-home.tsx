"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Flag, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { DeskStations } from "./desk-stations";

type KidRow = { id: number; name: string; grade: number; username: string; assistantName: string; openFlags: number };
type Usage = { monthToDateUsd: number; demo: boolean; elevenLabs: boolean };

export function ParentHome() {
  const [kids, setKids] = useState<KidRow[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<KidRow[]>("/kids").then(setKids).catch((e) => toast.error(e.message));
    api<Usage>("/usage").then(setUsage).catch(() => {});
  }, []);
  useEffect(load, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Family</h1>
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add a kid
        </Button>
      </div>

      {usage?.demo && (
        <p className="border-warn/40 bg-warn/10 text-warn rounded-lg border px-3 py-2 text-sm">
          <strong>Demo mode.</strong> The tutor sends canned example replies until <code>ANTHROPIC_API_KEY</code> is set.
        </p>
      )}

      {kids === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : kids.length === 0 ? (
        <div className="border-border bg-card/50 rounded-xl border p-6 text-center">
          <p className="font-medium">No kids yet</p>
          <p className="text-muted-foreground mt-1 text-sm">Add each kid with a username and PIN. They&apos;ll sign in on their own devices.</p>
        </div>
      ) : (
        <ul className="border-border bg-card/50 divide-border divide-y overflow-hidden rounded-xl border">
          {kids.map((k) => (
            <li key={k.id}>
              <Link href={`/parent/kids/${k.id}`} className="hover:bg-accent/50 flex items-center gap-3 px-4 py-4">
                <span className="orb-core inline-block size-9 shrink-0 rounded-full" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{k.name}</span>
                  <span className="text-muted-foreground text-sm">
                    Grade {k.grade} · signs in as <span className="font-mono">{k.username}</span> · assistant: {k.assistantName}
                  </span>
                </span>
                {k.openFlags > 0 && (
                  <span className="text-warn flex items-center gap-1 text-sm font-medium">
                    <Flag className="size-4" /> {k.openFlags}
                  </span>
                )}
                <ChevronRight className="text-muted-foreground size-4" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <DeskStations />

      {usage && !usage.demo && (
        <p className="text-muted-foreground text-sm">
          Claude usage this month: about <span className="text-foreground font-medium">${usage.monthToDateUsd.toFixed(2)}</span>. Set a hard
          monthly limit in the Anthropic Console.
        </p>
      )}

      <AddKid open={adding} onOpenChange={setAdding} onAdded={load} />
    </div>
  );
}

function AddKid({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState("7");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/kids", { body: { name, grade: Number(grade), username, pin } });
      toast.success(`${name} can now sign in as "${username.toLowerCase()}"`);
      setName("");
      setUsername("");
      setPin("");
      onOpenChange(false);
      onAdded();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a kid</DialogTitle>
            <DialogDescription>They&apos;ll sign in with this username and PIN. You can change the PIN any time.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="space-y-2">
              <Label htmlFor="k-name">First name</Label>
              <Input id="k-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="k-grade">Grade</Label>
              <Input id="k-grade" type="number" min={1} max={12} required value={grade} onChange={(e) => setGrade(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="k-user">Username</Label>
            <Input id="k-user" required autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. sam" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="k-pin">PIN (4-8 digits)</Label>
            <Input
              id="k-pin"
              required
              inputMode="numeric"
              pattern="[0-9]{4,8}"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

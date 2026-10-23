"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, ScanLine, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";

type Station = { id: number; name: string; lastSeenAt: string | null; inUseBy: string | null };

function seen(iso: string | null) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs} hr ago` : new Date(iso).toLocaleDateString();
}

/** Pair, rename and remove desk stations (the Raspberry Pi with the camera above the desk). */
export function DeskStations() {
  const [stations, setStations] = useState<Station[] | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const load = useCallback(() => {
    api<Station[]>("/stations").then(setStations).catch((e) => toast.error(e.message));
  }, []);
  useEffect(load, [load]);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    try {
      const s = await api<Station>("/stations/approve", { body: { code, name: name || "Desk station" } });
      toast.success(`${s.name} is paired.`);
      setCode("");
      setName("");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function rename(id: number) {
    try {
      await api(`/stations/${id}`, { method: "PATCH", body: { name: editName } });
      setEditing(null);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(s: Station) {
    if (!confirm(`Remove ${s.name}? It will need a new pairing code to be used again.`)) return;
    try {
      await api(`/stations/${s.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <section className="border-border bg-card/50 space-y-4 rounded-xl border p-4 sm:p-5">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <ScanLine className="text-primary size-5" /> Desk stations
        </h2>
        <p className="text-muted-foreground text-sm">A camera above the desk that checks work on paper as it&apos;s written.</p>
      </div>

      {stations && stations.length > 0 && (
        <ul className="divide-border divide-y">
          {stations.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2">
              {editing === s.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename(s.id);
                  }}
                >
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={40} autoFocus aria-label="Station name" />
                  <Button type="submit" size="sm">
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{s.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {s.inUseBy ? `In use by ${s.inUseBy}` : `Last checked in ${seen(s.lastSeenAt)}`}
                    </span>
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Rename ${s.name}`}
                    onClick={() => {
                      setEditing(s.id);
                      setEditName(s.name);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => remove(s)}>
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={pair} className="space-y-3">
        <p className="text-sm font-medium">Pair a new station</p>
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="pair-code">Code on its screen</Label>
            <Input
              id="pair-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC-123"
              className="font-mono tracking-widest uppercase"
              autoCapitalize="characters"
              maxLength={7}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pair-name">Name</Label>
            <Input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen desk" maxLength={40} />
          </div>
          <Button type="submit" disabled={code.replace(/[^A-Za-z0-9]/g, "").length < 6}>
            Pair
          </Button>
        </div>
      </form>
    </section>
  );
}

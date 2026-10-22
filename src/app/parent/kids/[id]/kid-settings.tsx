"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronRight, Flag, Play, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { browserVoiceNames } from "@/components/voice/use-voice";
import { api } from "@/lib/api-client";
import { HINT_LEVELS } from "@/lib/hints";
import { PERSONAS, PERSONA_KEYS, type PersonaPreset } from "@/lib/personas";
import { cn } from "@/lib/utils";

type Kid = {
  id: number;
  name: string;
  grade: number;
  username: string;
  hintCeiling: number;
  answerGuard: boolean;
  assistantName: string;
  personaPreset: PersonaPreset;
  personaNotes: string;
  voiceProvider: "browser" | "elevenlabs";
  voiceId: string;
};
type SessionRow = { id: number; title: string; lastActivityAt: string; flaggedAt: string | null; flagResolvedAt: string | null };
type FlagRow = { id: number; title: string; flaggedAt: string; flagNote: string | null; flagResolvedAt: string | null };

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-border bg-card/50 space-y-4 rounded-xl border p-4 sm:p-5">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function KidSettingsView({ id }: { id: number }) {
  const router = useRouter();
  const [kid, setKid] = useState<Kid | null>(null);
  const [draft, setDraft] = useState<Kid | null>(null);
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [pin, setPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  const [elevenLabs, setElevenLabs] = useState(false);

  const load = useCallback(async () => {
    try {
      const k = await api<Kid>(`/kids/${id}`);
      setKid(k);
      setDraft(k);
      setFlags(await api<FlagRow[]>(`/flags?kid=${id}&all=1`));
      setSessions(await api<SessionRow[]>(`/kids/${id}/sessions`));
      setElevenLabs((await api<{ elevenLabs: boolean }>("/usage")).elevenLabs);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    // Loads from the API; state is set when the requests finish.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const update = () => setVoices(browserVoiceNames());
    update();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", update);
    return () => {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.removeEventListener("voiceschanged", update);
    };
  }, [load]);

  if (!kid || !draft) return <p className="text-muted-foreground">Loading…</p>;

  const set = <K extends keyof Kid>(key: K, value: Kid[K]) => setDraft({ ...draft, [key]: value });
  const dirty = JSON.stringify(kid) !== JSON.stringify(draft);

  async function save() {
    setSaving(true);
    try {
      const { name, grade, hintCeiling, answerGuard, assistantName, personaPreset, personaNotes, voiceProvider, voiceId } = draft!;
      const k = await api<Kid>(`/kids/${id}`, {
        method: "PATCH",
        body: { name, grade, hintCeiling, answerGuard, assistantName, personaPreset, personaNotes, voiceProvider, voiceId },
      });
      setKid(k);
      setDraft(k);
      toast.success("Saved. Changes apply to new conversations.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function changePin(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/kids/${id}/pin`, { body: { pin } });
      setPin("");
      toast.success(`New PIN set. ${kid!.name} was signed out on their devices.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${kid!.name}'s profile and all their conversations? This can't be undone.`)) return;
    try {
      await api(`/kids/${id}`, { method: "DELETE" });
      router.push("/parent");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function resolve(sessionId: number, resolved: boolean) {
    await api(`/sessions/${sessionId}/resolve`, { body: { resolved } }).catch((e) => toast.error(e.message));
    load();
  }

  async function preview() {
    const sample = `Hi ${draft!.name}, I'm ${draft!.assistantName}. Let's take a look at that problem together.`;
    if (draft!.voiceProvider === "elevenlabs") {
      try {
        const res = await fetch("/api/v1/voice-preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: sample, voiceId: draft!.voiceId }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Preview failed");
        const url = URL.createObjectURL(await res.blob());
        await new Audio(url).play();
      } catch (e) {
        toast.error((e as Error).message);
      }
      return;
    }
    const u = new SpeechSynthesisUtterance(sample);
    const v = speechSynthesis.getVoices().find((x) => x.name === draft!.voiceId);
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  const openFlags = flags.filter((f) => !f.flagResolvedAt);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link href="/parent">
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{kid.name}</h1>
          <p className="text-muted-foreground text-sm">
            Signs in as <span className="font-mono">{kid.username}</span>
          </p>
        </div>
      </div>

      {openFlags.length > 0 && (
        <Section title="Flagged to go over" description="Problems they saved to work through with you.">
          <ul className="space-y-2">
            {openFlags.map((f) => (
              <li key={f.id} className="border-warn/40 bg-warn/5 flex items-center gap-3 rounded-lg border px-3 py-2">
                <Flag className="text-warn size-4 shrink-0" />
                <Link href={`/s/${f.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="block truncate font-medium">{f.title}</span>
                  {f.flagNote && <span className="text-muted-foreground block truncate text-sm">&ldquo;{f.flagNote}&rdquo;</span>}
                </Link>
                <Button size="sm" variant="secondary" onClick={() => resolve(f.id, true)}>
                  <Check /> Went over it
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="About" description="Changes apply to new conversations, not ones already in progress.">
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grade">Grade</Label>
            <Input id="grade" type="number" min={1} max={12} value={draft.grade} onChange={(e) => set("grade", Number(e.target.value))} />
          </div>
        </div>
      </Section>

      <Section title="How much help" description="The highest step the tutor can reach when they're stuck. It always starts low and climbs one step at a time.">
        <div className="space-y-2" role="radiogroup" aria-label="Most help allowed">
          {HINT_LEVELS.map((h) => (
            <button
              key={h.level}
              type="button"
              role="radio"
              aria-checked={draft.hintCeiling === h.level}
              onClick={() => set("hintCeiling", h.level)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left",
                h.level <= draft.hintCeiling ? "border-primary/40 bg-primary/5" : "border-border opacity-60",
                draft.hintCeiling === h.level && "ring-primary ring-2",
              )}
            >
              <span className="bg-primary/15 text-primary mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">{h.level}</span>
              <span>
                <span className="block font-medium">{h.name}</span>
                <span className="text-muted-foreground block text-sm">{h.short}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">
          {draft.hintCeiling >= 5
            ? "At step 5 the tutor may give the answer to their actual problem, while still walking them through it."
            : "The tutor won't give the answer to their actual problem. Similar examples use different numbers."}
        </p>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="accent-primary mt-1 size-4"
            checked={draft.answerGuard}
            disabled={draft.hintCeiling >= 5}
            onChange={(e) => set("answerGuard", e.target.checked)}
          />
          <span>
            <span className="block font-medium">Double-check replies</span>
            <span className="text-muted-foreground block text-sm">
              A second, low-cost AI model reads each reply first and sends it back if it gives away the answer. Adds a moment and a little cost.
            </span>
          </span>
        </label>
      </Section>

      <Section title="Personality">
        <div className="space-y-2">
          <Label htmlFor="assistant">Assistant&apos;s name</Label>
          <Input id="assistant" value={draft.assistantName} onChange={(e) => set("assistantName", e.target.value)} className="max-w-60" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {PERSONA_KEYS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => set("personaPreset", p)}
              className={cn("rounded-lg border p-3 text-left", draft.personaPreset === p ? "border-primary ring-primary bg-primary/5 ring-2" : "border-border")}
            >
              <span className="block font-medium">{PERSONAS[p].label}</span>
              <span className="text-muted-foreground block text-sm">{PERSONAS[p].blurb}</span>
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <Label htmlFor="notes">Extra notes (optional)</Label>
          <Textarea
            id="notes"
            value={draft.personaNotes}
            onChange={(e) => set("personaNotes", e.target.value)}
            placeholder="e.g. Loves soccer and Minecraft analogies. Gets frustrated with word problems, so keep those extra calm."
            maxLength={1000}
          />
        </div>
      </Section>

      <Section title="Voice" description="Kids turn voice on or off on each device. This sets which voice they hear.">
        <div className="flex flex-wrap gap-2">
          {(["browser", "elevenlabs"] as const).map((p) => (
            <Button key={p} type="button" variant={draft.voiceProvider === p ? "default" : "secondary"} onClick={() => set("voiceProvider", p)}>
              {p === "browser" ? "Built-in voice (free)" : "Natural voice (ElevenLabs)"}
            </Button>
          ))}
        </div>
        {draft.voiceProvider === "browser" ? (
          <div className="space-y-2">
            <Label htmlFor="bvoice">Voice name (optional)</Label>
            <Input id="bvoice" list="voices" value={draft.voiceId} onChange={(e) => set("voiceId", e.target.value)} placeholder="Automatic" className="max-w-80" />
            <datalist id="voices">
              {voices.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <p className="text-muted-foreground text-xs">
              Each device has its own built-in voices. If the one named here isn&apos;t on their device, a similar English voice is used.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="evoice">ElevenLabs voice ID</Label>
            <Input id="evoice" value={draft.voiceId} onChange={(e) => set("voiceId", e.target.value)} placeholder="Paste from the ElevenLabs voice library" className="max-w-96 font-mono" />
            {!elevenLabs && (
              <p className="text-warn text-sm">ELEVENLABS_API_KEY isn&apos;t set yet, so the built-in voice is used for now.</p>
            )}
          </div>
        )}
        <Button type="button" variant="secondary" onClick={preview}>
          <Play /> Hear it
        </Button>
      </Section>

      <div className="bg-background/90 border-border sticky bottom-0 -mx-4 flex justify-end gap-2 border-t px-4 py-3 backdrop-blur">
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(kid)}>
          <RotateCcw /> Undo changes
        </Button>
        <Button disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <Section title="Change PIN">
        <form onSubmit={changePin} className="flex gap-2">
          <Input
            inputMode="numeric"
            pattern="[0-9]{4,8}"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="New PIN"
            className="max-w-40"
            aria-label="New PIN"
          />
          <Button type="submit" variant="secondary" disabled={pin.length < 4}>
            Set PIN
          </Button>
        </form>
      </Section>

      <Section title="Conversations">
        {sessions.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet.</p>
        ) : (
          <ul className="divide-border -mx-1 divide-y">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link href={`/s/${s.id}`} className="hover:bg-accent/50 flex items-center gap-3 rounded px-1 py-2">
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {s.flaggedAt && <Flag className={cn("size-4", s.flagResolvedAt ? "text-muted-foreground" : "text-warn")} />}
                  <span className="text-muted-foreground text-xs">{new Date(s.lastActivityAt).toLocaleDateString()}</span>
                  <ChevronRight className="text-muted-foreground size-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="pt-2">
        <Button variant="ghost" className="text-destructive" onClick={remove}>
          <Trash2 /> Delete {kid.name}&apos;s profile
        </Button>
      </div>
    </div>
  );
}

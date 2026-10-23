"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUp, Camera, Check, Flag, Mic, Paperclip, RotateCw, ScanLine, Volume2, VolumeX, X } from "lucide-react";
import { toast } from "sonner";
import { TutorBlocks } from "@/components/tutor/blocks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Orb, type OrbState } from "@/components/voice/orb";
import { useListener, useSpeaker, type VoiceProvider } from "@/components/voice/use-voice";
import { api } from "@/lib/api-client";
import type { TutorReply } from "@/lib/tutor-reply";
import { uploadFile } from "@/lib/upload-client";
import { cn } from "@/lib/utils";

type Turn = {
  id: number;
  role: "kid" | "tutor";
  kid: { text: string; uploadIds: number[]; source?: "desk"; snapshotId?: number } | null;
  reply: TutorReply | null;
  createdAt: string;
};
type SessionData = {
  id: number;
  title: string;
  demo: boolean;
  flaggedAt: string | null;
  flagNote: string | null;
  flagResolvedAt: string | null;
  turns: Turn[];
  awaitingReply: boolean;
  deskStation: { id: number; name: string; live: boolean } | null;
};
type StationOption = { id: number; name: string; watchingThis: boolean; busy: boolean };

const QUICK = ["I'm stuck", "Give me a hint", "Can you check my work?", "Explain it a different way"];
const VOICE_KEY = "voice-on";

function readVoicePref() {
  try {
    return localStorage.getItem(VOICE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeVoicePref(on: boolean) {
  try {
    localStorage.setItem(VOICE_KEY, on ? "1" : "0");
  } catch {}
}

export function SessionView(props: {
  id: number;
  readOnly: boolean;
  assistantName: string;
  voiceProvider: VoiceProvider;
  voiceId: string;
  initialUpload: number | null;
  backHref: string;
}) {
  const { id, readOnly, assistantName } = props;
  const router = useRouter();
  const [data, setData] = useState<SessionData | null>(null);
  const [text, setText] = useState("");
  const [pendingUploads, setPendingUploads] = useState<number[]>([]);
  const [thinking, setThinking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [deskOpen, setDeskOpen] = useState(false);
  const [stationOptions, setStationOptions] = useState<StationOption[] | null>(null);
  const speaker = useSpeaker(props.voiceProvider, props.voiceId);
  const listener = useListener();
  const bottom = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const sentInitial = useRef(false);
  const busy = thinking || uploading;

  const load = useCallback(async () => {
    try {
      setData(await api<SessionData>(`/sessions/${id}`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    // Voice on/off is remembered per device, so it's read after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVoiceOn(readVoicePref());
    load();
  }, [load]);

  // Pick up messages sent from another device (e.g. a photo from a phone) while idle.
  useEffect(() => {
    if (busy) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [busy, load]);

  const turnCount = data?.turns.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnCount, thinking]);

  const send = useCallback(
    async (message: string, uploadIds: number[]) => {
      if (!message.trim() && uploadIds.length === 0) return;
      speaker.stop();
      setThinking(true);
      // Show the kid's message right away.
      setData((d) =>
        d
          ? { ...d, turns: [...d.turns, { id: -Date.now(), role: "kid", kid: { text: message, uploadIds }, reply: null, createdAt: new Date().toISOString() }] }
          : d,
      );
      setText("");
      setPendingUploads([]);
      try {
        const t = await api<Turn>(`/sessions/${id}/turns`, { body: { text: message, uploadIds } });
        // When the desk station's screen is on, it does the talking.
        if (voiceOn && t.reply && !data?.deskStation?.live) speaker.speak(t.reply.say);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setThinking(false);
        load();
      }
    },
    [id, load, speaker, voiceOn, data?.deskStation?.live],
  );

  // Arriving from "Snap a photo" on the home screen: send that photo straight away.
  useEffect(() => {
    if (sentInitial.current || !props.initialUpload || !data || data.turns.length > 0) return;
    sentInitial.current = true;
    router.replace(`/s/${id}`);
    send("", [props.initialUpload]);
  }, [data, id, props.initialUpload, router, send]);

  async function retry() {
    setThinking(true);
    try {
      const t = await api<Turn>(`/sessions/${id}/retry`, { method: "POST", body: {} });
      if (voiceOn && t.reply) speaker.speak(t.reply.say);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setThinking(false);
      load();
    }
  }

  async function addFile(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    try {
      const uid = await uploadFile(f);
      setPendingUploads((p) => [...p, uid]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    writeVoicePref(next);
    if (next) speaker.unlock();
    else speaker.stop();
  }

  // ---------- push to talk ----------
  const talking = useRef(false);
  const pressStart = useCallback(() => {
    if (talking.current || busy) return;
    talking.current = true;
    speaker.stop();
    speaker.unlock();
    listener.start();
  }, [busy, listener, speaker]);
  const pressEnd = useCallback(async () => {
    if (!talking.current) return;
    talking.current = false;
    const heard = await listener.stop();
    if (heard) send(heard, pendingUploads);
  }, [listener, pendingUploads, send]);

  // Hold the space bar to talk (when not typing).
  useEffect(() => {
    if (readOnly || !listener.supported) return;
    const typing = () => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !typing()) {
        e.preventDefault();
        pressStart();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing()) {
        e.preventDefault();
        pressEnd();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [listener.supported, pressEnd, pressStart, readOnly]);

  useEffect(() => {
    if (listener.error) toast.error(listener.error);
  }, [listener.error]);

  async function flag() {
    try {
      await api(`/sessions/${id}/flag`, { body: { note: flagNote || null } });
      toast.success("Flagged. You can go over it with a parent later.");
      setFlagOpen(false);
      setFlagNote("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function openDesk() {
    setDeskOpen(true);
    setStationOptions(null);
    try {
      setStationOptions(await api<StationOption[]>(`/sessions/${id}/desk`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function chooseStation(stationId: number) {
    try {
      await api(`/sessions/${id}/desk`, { body: { stationId } });
      setDeskOpen(false);
      toast.success("Desk camera on. If the station's screen is dark, tap it to wake it.");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function stopDesk() {
    try {
      await api(`/sessions/${id}/desk`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function resolve(resolved: boolean) {
    try {
      await api(`/sessions/${id}/resolve`, { body: { resolved } });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const orbState: OrbState = listener.listening ? "listening" : thinking ? "thinking" : speaker.speaking ? "speaking" : "idle";
  const flagged = !!data?.flaggedAt && !data.flagResolvedAt;
  const lastTutor = [...(data?.turns ?? [])].reverse().find((t) => t.role === "tutor");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
      {/* session bar */}
      <div className="border-border/60 bg-background/80 sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 flex items-center gap-2 border-b px-3 py-2 backdrop-blur">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link href={props.backHref}>
            <ArrowLeft />
          </Link>
        </Button>
        <Orb state={orbState} size={30} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{data?.title ?? "…"}</p>
          <p className="text-muted-foreground text-xs">
            {orbState === "listening" ? "Listening…" : orbState === "thinking" ? `${assistantName} is thinking…` : orbState === "speaking" ? `${assistantName} is talking` : assistantName}
          </p>
        </div>
        {!readOnly && (
          <Button variant={voiceOn ? "secondary" : "ghost"} size="sm" onClick={toggleVoice} aria-pressed={voiceOn} aria-label="Voice" title="Read replies out loud">
            {voiceOn ? <Volume2 /> : <VolumeX />}
            <span className="hidden sm:inline">Voice {voiceOn ? "on" : "off"}</span>
          </Button>
        )}
        {!readOnly && !data?.deskStation && (
          <Button variant="ghost" size="sm" onClick={openDesk} aria-label="Desk camera" title="Watch my paper with the desk camera">
            <ScanLine />
            <span className="hidden sm:inline">Desk camera</span>
          </Button>
        )}
        {!readOnly && !flagged && (
          <Button variant="ghost" size="sm" onClick={() => setFlagOpen(true)} aria-label="Flag for a parent" title="Save this to go over with a parent">
            <Flag />
            <span className="hidden sm:inline">Flag for a parent</span>
          </Button>
        )}
        {flagged && (
          <Button variant="secondary" size="sm" onClick={() => resolve(true)} title="We went over it together">
            <Check /> Went over it
          </Button>
        )}
      </div>

      {data?.demo && (
        <p className="border-warn/40 bg-warn/10 text-warn mx-3 mt-3 rounded-lg border px-3 py-2 text-xs">
          Demo mode: replies are canned examples until an Anthropic API key is added.
        </p>
      )}
      {data?.deskStation && (
        <div className="border-primary/40 bg-primary/10 mx-3 mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <ScanLine className="text-primary size-4 shrink-0" />
          <span className="flex-1">
            {data.deskStation.name} is watching {readOnly ? "the" : "your"} page. Write each step on its own line.
          </span>
          <Button variant="ghost" size="sm" onClick={stopDesk}>
            Stop
          </Button>
        </div>
      )}
      {flagged && (
        <p className="border-warn/40 bg-warn/10 text-warn mx-3 mt-3 rounded-lg border px-3 py-2 text-sm">
          <Flag className="mr-1 inline size-4" /> Flagged to go over with a parent{data?.flagNote ? `: "${data.flagNote}"` : "."}
        </p>
      )}

      {/* conversation */}
      <div className="flex-1 space-y-6 px-3 py-4">
        {data?.turns.length === 0 && !thinking && (
          <div className="text-muted-foreground flex flex-col items-center gap-3 py-10 text-center">
            <Orb state="idle" size={64} />
            <p>
              {readOnly ? "Nothing here yet." : `Snap a photo, type the problem, or ${listener.supported ? "hold the mic and say it" : "ask a question"}.`}
            </p>
          </div>
        )}
        {data?.turns.map((t) =>
          t.role === "kid" ? (
            <KidBubble key={t.id} turn={t} />
          ) : t.reply ? (
            <TutorTurn key={t.id} reply={t.reply} name={assistantName} onReplay={readOnly ? undefined : () => speaker.speak(t.reply!.say)} />
          ) : null,
        )}
        {thinking && (
          <div className="text-muted-foreground flex items-center gap-3 text-sm">
            <Orb state="thinking" size={28} /> Thinking…
          </div>
        )}
        {!readOnly && !thinking && data?.awaitingReply && (
          <Button variant="secondary" onClick={retry}>
            <RotateCw /> Try that again
          </Button>
        )}
        <div ref={bottom} />
      </div>

      {/* composer */}
      {!readOnly && (
        <div className="border-border/60 bg-background/90 sticky bottom-0 border-t px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
          {lastTutor && !busy && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
              {QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q, pendingUploads)}
                  className="border-border bg-card/70 hover:bg-accent shrink-0 rounded-full border px-3 py-1 text-sm"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          {pendingUploads.length > 0 && (
            <div className="mb-2 flex gap-2">
              {pendingUploads.map((u) => (
                <div key={u} className="relative">
                  <Thumb id={u} />
                  <button
                    type="button"
                    className="bg-background absolute -top-1.5 -right-1.5 rounded-full border p-0.5"
                    onClick={() => setPendingUploads((p) => p.filter((x) => x !== u))}
                    aria-label="Remove"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {listener.listening && (
            <p className="text-glow mb-2 min-h-5 text-sm">{listener.interim || "Listening… let go when you're done."}</p>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(text, pendingUploads);
            }}
          >
            <Button type="button" variant="ghost" size="icon" onClick={() => camera.current?.click()} disabled={busy} aria-label="Take a photo">
              <Camera />
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => file.current?.click()} disabled={busy} aria-label="Attach a file" className="hidden sm:inline-flex">
              <Paperclip />
            </Button>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(text, pendingUploads);
                }
              }}
              placeholder={uploading ? "Adding your photo…" : "Type here…"}
              rows={1}
              className="max-h-40 min-h-10 flex-1 resize-none"
            />
            {text.trim() || pendingUploads.length > 0 ? (
              <Button type="submit" size="icon" disabled={busy} aria-label="Send">
                <ArrowUp />
              </Button>
            ) : listener.supported ? (
              <Button
                type="button"
                size="icon"
                disabled={busy}
                aria-label="Hold to talk"
                title="Hold to talk (or hold the space bar)"
                className={cn("touch-none select-none", listener.listening && "ring-glow ring-4")}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pressStart();
                }}
                onPointerUp={pressEnd}
                onPointerCancel={pressEnd}
                onContextMenu={(e) => e.preventDefault()}
              >
                <Mic />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </form>
          <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (addFile(e.target.files?.[0]), (e.target.value = ""))} />
          <input ref={file} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => (addFile(e.target.files?.[0]), (e.target.value = ""))} />
        </div>
      )}

      <Dialog open={flagOpen} onOpenChange={setFlagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Flag for a parent</DialogTitle>
            <DialogDescription>This saves the conversation so you can go over it together later.</DialogDescription>
          </DialogHeader>
          <Textarea value={flagNote} onChange={(e) => setFlagNote(e.target.value)} placeholder="What's confusing? (optional)" maxLength={500} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFlagOpen(false)}>
              Cancel
            </Button>
            <Button onClick={flag}>
              <Flag /> Flag it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deskOpen} onOpenChange={setDeskOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use the desk camera</DialogTitle>
            <DialogDescription>Work on paper under the camera. {assistantName} checks each line as you write it.</DialogDescription>
          </DialogHeader>
          {stationOptions === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : stationOptions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No desk stations are set up yet. A parent can add one from the parent page.</p>
          ) : (
            <div className="space-y-2">
              {stationOptions.map((s) => (
                <Button key={s.id} variant="secondary" className="w-full justify-start" onClick={() => chooseStation(s.id)}>
                  <ScanLine /> {s.name}
                  {s.busy && <span className="text-muted-foreground ml-auto text-xs">in use</span>}
                </Button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Thumb({ id }: { id: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/v1/uploads/${id}`}
      alt="Attached"
      className="border-border size-16 rounded-lg border object-cover"
      onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")}
    />
  );
}

function KidBubble({ turn }: { turn: Turn }) {
  const k = turn.kid!;
  if (k.source === "desk") {
    const asked = k.text.includes("tapped Check now");
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground text-xs">{asked ? "Asked for a check" : "New work on your page"}</span>
        {k.snapshotId ? (
          <a href={`/api/v1/uploads/${k.snapshotId}`} target="_blank" rel="noreferrer" title="See the photo">
            <Thumb id={k.snapshotId} />
          </a>
        ) : (
          <ScanLine className="text-muted-foreground size-4" />
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-2">
      {k.uploadIds.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {k.uploadIds.map((u) => (
            <a key={u} href={`/api/v1/uploads/${u}`} target="_blank" rel="noreferrer">
              <Thumb id={u} />
            </a>
          ))}
        </div>
      )}
      {k.text && <p className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 whitespace-pre-wrap">{k.text}</p>}
    </div>
  );
}

function TutorTurn({ reply, name, onReplay }: { reply: TutorReply; name: string; onReplay?: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="orb-core mt-1 inline-block size-6 shrink-0 rounded-full" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs font-semibold">{name}</p>
          {reply.say && <p className="text-[1.05rem] leading-relaxed">{reply.say}</p>}
        </div>
        {onReplay && reply.say && (
          <Button variant="ghost" size="icon" className="size-8" onClick={onReplay} aria-label="Say it again" title="Say it again">
            <Volume2 className="size-4" />
          </Button>
        )}
      </div>
      {reply.show.length > 0 && (
        <div className="pl-9">
          <TutorBlocks blocks={reply.show} />
        </div>
      )}
    </div>
  );
}

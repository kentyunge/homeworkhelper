"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Delete, Flag, Lightbulb, Pause, Play, Power, Volume2, X } from "lucide-react";
import { Markdown } from "@/components/tutor/markdown";
import { Orb, type OrbState } from "@/components/voice/orb";
import type { DeskState } from "@/db/schema";
import { cn } from "@/lib/utils";

type KidOption = { id: number; name: string; assistantName: string };
type Active = {
  sessionId: number;
  title: string;
  kid: { name: string; assistantName: string; voiceProvider: string; voiceId: string };
  paused: boolean;
  busy: boolean;
  startedAt: string | null;
  desk: DeskState;
  lastReply: { turnId: number; say: string } | null;
};
type State = {
  station: { name: string; approved: boolean; pairCode: string | null };
  problems: { camera: string | null; tutor: string | null };
  kids: KidOption[];
  active: Active | null;
  nudge?: boolean;
};

const TOKEN_KEY = "station-token";
/** With nobody using it, the screen sleeps (and stops checking in) after this long. */
const SLEEP_AFTER_MS = 10 * 60_000;

function readToken(): string | null {
  try {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("k");
    if (fromHash) {
      localStorage.setItem(TOKEN_KEY, fromHash);
      history.replaceState(null, "", window.location.pathname);
      return fromHash;
    }
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * The browser's voices. Chromium on Linux loads them a moment after the page first asks, so wait for
 * them (up to a few seconds) instead of assuming there are none.
 */
function loadVoices(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener("voiceschanged", done);
      clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener("voiceschanged", done);
    const timer = setTimeout(done, timeoutMs);
  });
}

/** Speak with the browser's built-in voice. Resolves with an error message, or null when it played. */
async function speakBuiltIn(text: string, voiceName?: string): Promise<string | null> {
  if (typeof speechSynthesis === "undefined") return "This browser can't speak.";
  const voices = (await loadVoices()).filter((v) => v.lang.toLowerCase().startsWith("en"));
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find((x) => x.name === voiceName) ?? voices[0];
    if (v) u.voice = v;
    // If the speech service never reports back, don't leave the orb "talking" forever.
    const timer = setTimeout(() => resolve(null), 4000 + text.length * 90);
    u.onend = () => (clearTimeout(timer), resolve(null));
    u.onerror = (e) => (clearTimeout(timer), resolve(`Speech failed (${e.error})`));
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

/** Play audio from a URL; resolves with an error message, or null when it played to the end. */
function playAudio(el: HTMLAudioElement, url: string): Promise<string | null> {
  return new Promise((resolve) => {
    el.src = url;
    el.onended = () => resolve(null);
    el.onerror = () => resolve("The browser couldn't play the sound file");
    el.play().catch((e: Error) => resolve(e.name === "NotAllowedError" ? "The browser blocked sound (autoplay). Rerun the installer and restart." : `Couldn't play sound: ${e.message}`));
  });
}

/** A short tone as a WAV file, to test the speaker without any voice involved. */
function beepUrl(): string {
  const rate = 16000;
  const n = Math.round(rate * 0.5);
  const bytes = new Uint8Array(44 + n * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 800, (n - i) / 800);
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 9000 * fade), true);
  }
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** The server's error message from a failed request. */
async function errorText(res: Response) {
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `Request failed (${res.status})`;
}

class StationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function StationView() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asleep, setAsleep] = useState(false);
  const [pinFor, setPinFor] = useState<KidOption | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  /** The last reason the station couldn't speak, shown until the next sound check. */
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const [soundCheck, setSoundCheck] = useState<SoundResult[] | null>(null);
  const lastTouch = useRef(0);
  const spokenTurn = useRef<number | null>(null);
  /** Finished problems already celebrated (null until the first state arrives, so old ones aren't). */
  const celebrated = useRef<Set<string> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // The token lives in the URL (from the Pi's launcher) or this browser's storage; both are client-only.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(readToken());
    setReady(true);
    lastTouch.current = Date.now();
    loadVoices(); // start loading voices now, so the first reply isn't silent
    audio.current = new Audio();
  }, []);

  const call = useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const res = await fetch(`/api/v1${path}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new StationError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
      return data as T;
    },
    [token],
  );

  // ---------- voice ----------
  const speak = useCallback(
    async (text: string, voice?: Active["kid"]) => {
      if (!text.trim()) return;
      setSpeaking(true);
      try {
        if (voice?.voiceProvider === "elevenlabs") {
          const res = await fetch("/api/v1/station/tts", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (res.ok) {
            const url = URL.createObjectURL(await res.blob());
            const problem = await playAudio(audio.current!, url);
            URL.revokeObjectURL(url);
            if (!problem) return;
            setVoiceProblem(problem);
          } else {
            setVoiceProblem(await errorText(res));
          }
        }
        const problem = await speakBuiltIn(text, voice?.voiceProvider === "elevenlabs" ? undefined : voice?.voiceId);
        if (problem) setVoiceProblem(`Built-in voice: ${problem}`);
      } finally {
        setSpeaking(false);
      }
    },
    [token],
  );

  // ---------- polling ----------
  const refresh = useCallback(
    async (tick: boolean) => {
      if (!token) return;
      try {
        const s = await call<State>(tick ? "/station/tick" : "/station/state", tick ? { body: {} } : {});
        setError(null);
        setState(s);
        const reply = s.active?.lastReply;
        if (reply && reply.turnId !== spokenTurn.current) {
          // Speak replies that arrive while watching, not the one already there when the screen wakes.
          if (spokenTurn.current !== null) speak(reply.say, s.active!.kid);
          spokenTurn.current = reply.turnId;
        }
        if (s.active) {
          const done = s.active.desk.marks.flatMap((m, i) => (m?.solved && m.latex ? [`${s.active!.sessionId}:${i}:${m.latex}`] : []));
          if (celebrated.current === null) celebrated.current = new Set(done);
          else if (done.some((k) => !celebrated.current!.has(k))) {
            done.forEach((k) => celebrated.current!.add(k));
            setBanner("✓ That one's done!");
            if (!s.active.lastReply || s.active.lastReply.turnId === spokenTurn.current) speak(`Nice, ${s.active.kid.name}. That one's done.`, s.active.kid);
          }
        }
        if (s.nudge && s.active) {
          setBanner("Stuck? Tap Hint, or keep going.");
          speak(`Want a hint, ${s.active.kid.name}? Tap Hint, or keep going.`, s.active.kid);
        }
      } catch (e) {
        setError(e instanceof StationError && e.status === 401 ? "not-paired" : (e as Error).message);
      }
    },
    [call, speak, token],
  );

  const active = !!state?.active;
  useEffect(() => {
    if (!token) return;
    // Loads from the API; state is set when the request finishes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh(false);
    const t = setInterval(() => {
      const idleFor = Date.now() - lastTouch.current;
      if (!active && idleFor > SLEEP_AFTER_MS) {
        setAsleep(true);
        return;
      }
      refresh(active);
    }, active ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [token, active, refresh]);

  const touch = useCallback(() => {
    lastTouch.current = Date.now();
    if (asleep) {
      setAsleep(false);
      refresh(false);
    }
  }, [asleep, refresh]);

  async function act(path: string, body: unknown = {}, message?: string) {
    touch();
    try {
      await call(path, { body });
      if (message) setBanner(message);
      await refresh(false);
    } catch (e) {
      setBanner((e as Error).message);
    }
  }

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(t);
  }, [banner]);

  // ---------- screens ----------
  if (!ready) return <Shell />;
  if (!token || error === "not-paired") {
    return (
      <Shell>
        <Centered>
          <Orb state="idle" size={90} />
          <p className="text-xl font-semibold">This station isn&apos;t set up yet</p>
          <p className="text-muted-foreground max-w-md text-center">Run the installer on the Raspberry Pi (see pi/README.md). It shows a pairing code here.</p>
        </Centered>
      </Shell>
    );
  }
  if (!state) return <Shell><Centered><Orb state="thinking" size={70} /></Centered></Shell>;

  if (!state.station.approved) {
    return (
      <Shell onTouch={touch}>
        <Centered>
          <Orb state="idle" size={80} />
          <p className="text-muted-foreground text-lg">Pair this station</p>
          <p className="text-glow font-mono text-6xl font-bold tracking-[0.25em]">
            {state.station.pairCode?.slice(0, 3)}-{state.station.pairCode?.slice(3)}
          </p>
          <p className="text-muted-foreground max-w-md text-center">
            On the parent page, open <span className="text-foreground font-medium">Desk stations</span> and enter this code.
          </p>
        </Centered>
      </Shell>
    );
  }

  if (!state.active) {
    if (pinFor) {
      return (
        <Shell onTouch={touch}>
          <PinPad
            kid={pinFor}
            onCancel={() => setPinFor(null)}
            onSubmit={async (pin) => {
              try {
                await call("/station/start", { body: { kidId: pinFor.id, pin } });
                setPinFor(null);
                spokenTurn.current = null;
                await refresh(false);
                return null;
              } catch (e) {
                return (e as Error).message;
              }
            }}
          />
        </Shell>
      );
    }
    return (
      <Shell onTouch={touch}>
        {soundCheck && <SoundCheck results={soundCheck} onClose={() => setSoundCheck(null)} />}
        <Idle
          state={state}
          asleep={asleep}
          onPick={(k) => (touch(), setPinFor(k))}
          banner={banner}
          onTestVoice={async () => {
            touch();
            setVoiceProblem(null);
            const results: SoundResult[] = [
              { name: "Speaker", status: "running" },
              { name: "Built-in voice", status: "waiting" },
              { name: "Natural voice (ElevenLabs)", status: "waiting" },
            ];
            const show = () => setSoundCheck(results.map((r) => ({ ...r })));
            const done = (i: number, problem: string | null, okText: string) => {
              results[i] = { ...results[i], status: problem ? "failed" : "ok", detail: problem ?? okText };
              if (results[i + 1]) results[i + 1].status = "running";
              show();
            };
            show();
            setSpeaking(true);
            done(0, await playAudio(audio.current!, beepUrl()), "You should have heard a tone.");
            const voices = await loadVoices();
            done(
              1,
              await speakBuiltIn(`Hi, this is ${state.station.name}. This is the built-in voice.`),
              voices.length ? `Spoke with one of ${voices.length} voices.` : "Spoke with the browser's default voice.",
            );
            const res = await fetch("/api/v1/station/voice-test", { method: "POST", headers: { authorization: `Bearer ${token}` } });
            if (res.ok) {
              const url = URL.createObjectURL(await res.blob());
              done(2, await playAudio(audio.current!, url), "Played a natural voice clip.");
              URL.revokeObjectURL(url);
            } else done(2, await errorText(res), "");
            setSpeaking(false);
          }}
        />
      </Shell>
    );
  }

  const a = state.active;
  const orb: OrbState = a.busy ? "thinking" : speaking ? "speaking" : a.paused ? "idle" : "listening";
  const issue = a.desk.marks.find((m) => m.status === "look_here");
  return (
    <Shell onTouch={touch}>
      <div className="flex h-full w-full gap-3 p-3">
        <section className="relative flex min-w-0 flex-[1.55] items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black/30">
          <PageView desk={a.desk} token={token} />
          {a.paused && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xl font-semibold">Paused. Not watching.</div>
          )}
        </section>
        <aside className="flex w-[290px] shrink-0 flex-col gap-2">
          <div className="flex items-center gap-3">
            <Orb state={orb} size={56} />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{a.kid.assistantName}</p>
              <p className="text-muted-foreground truncate text-sm">
                {a.paused ? "Paused" : a.busy ? "Looking at your work…" : `Watching ${a.kid.name}'s page`}
              </p>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-white/5 p-3 text-[15px] leading-snug">
            {state.problems.camera ? (
              <p className="text-destructive">{state.problems.camera}</p>
            ) : state.problems.tutor ? (
              <p className="text-destructive">
                <span className="font-semibold">Can&apos;t check your work right now. </span>
                {state.problems.tutor}
              </p>
            ) : voiceProblem ? (
              <p className="text-destructive">
                <span className="font-semibold">Can&apos;t speak: </span>
                {voiceProblem}
              </p>
            ) : banner ? (
              <p className="text-warn">{banner}</p>
            ) : issue ? (
              <p>
                <span className="text-warn font-semibold">Look again: </span>
                {issue.note || (a.busy ? "that line doesn't follow from the one above it. Thinking of a hint…" : "that line doesn't follow from the one above it.")}
              </p>
            ) : a.lastReply?.say ? (
              <p>{a.lastReply.say}</p>
            ) : (
              <p className="text-muted-foreground">Write each step on its own line. I&apos;ll check them as you go.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Big icon={Camera} label="Check now" onClick={() => act("/station/check", {}, "Taking a look…")} primary />
            <Big icon={Lightbulb} label="Hint" onClick={() => act("/station/hint", {}, "Thinking of a hint…")} />
            <Big icon={a.paused ? Play : Pause} label={a.paused ? "Resume" : "Pause"} onClick={() => act("/station/pause", { paused: !a.paused })} />
            <Big icon={Flag} label="Flag" onClick={() => act("/station/flag", {}, "Flagged to go over with a parent.")} />
          </div>
          <Big icon={Power} label="Done" onClick={() => act("/station/stop", {}, "See you next time!")} wide />
        </aside>
      </div>
    </Shell>
  );
}

// ---------- pieces ----------

function Shell({ children, onTouch }: { children?: React.ReactNode; onTouch?: () => void }) {
  return (
    <main
      className="fixed inset-0 flex touch-manipulation overflow-hidden select-none"
      onPointerDown={onTouch}
      style={{ background: "radial-gradient(ellipse 90% 70% at 50% -10%, oklch(0.32 0.09 240 / 55%), transparent), var(--background)" }}
    >
      {children}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">{children}</div>;
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // Time comes from the station's own clock, so it's only shown in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return null;
  return (
    <div className="text-center">
      <p className="text-5xl font-light tabular-nums">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
      <p className="text-muted-foreground">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
    </div>
  );
}

function Idle({
  state,
  asleep,
  onPick,
  banner,
  onTestVoice,
}: {
  state: State;
  asleep: boolean;
  onPick: (k: KidOption) => void;
  banner: string | null;
  onTestVoice: () => void;
}) {
  if (asleep) {
    return (
      <Centered>
        <div className="opacity-40">
          <Orb state="idle" size={110} />
        </div>
        <p className="text-muted-foreground/60 text-sm">Tap to wake</p>
      </Centered>
    );
  }
  return (
    <div className="flex h-full w-full items-center gap-6 px-8">
      <div className="flex flex-1 flex-col items-center gap-4">
        <Orb state="idle" size={120} />
        <Clock />
        <p className="text-glow text-sm font-semibold tracking-widest uppercase">{state.station.name}</p>
        {state.problems.camera && <p className="text-destructive max-w-xs text-center text-sm">{state.problems.camera}</p>}
        <button type="button" onClick={onTestVoice} className="text-muted-foreground flex items-center gap-1.5 text-sm underline-offset-4 active:underline">
          <Volume2 className="size-4" /> Sound check
        </button>
      </div>
      <div className="flex w-[330px] flex-col gap-3">
        <p className="text-muted-foreground text-center">{banner ?? "Tap your name to start"}</p>
        {state.kids.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => onPick(k)}
            className="border-primary/40 bg-primary/10 active:bg-primary/25 flex items-center gap-4 rounded-2xl border px-5 py-4 text-left"
          >
            <span className="orb-core inline-block size-10 shrink-0 rounded-full" aria-hidden />
            <span>
              <span className="block text-xl font-semibold">{k.name}</span>
              <span className="text-muted-foreground text-sm">with {k.assistantName}</span>
            </span>
          </button>
        ))}
        {state.kids.length === 0 && <p className="text-muted-foreground text-center text-sm">No kids added yet. Add them on the parent page.</p>}
      </div>
    </div>
  );
}

function PinPad({ kid, onCancel, onSubmit }: { kid: KidOption; onCancel: () => void; onSubmit: (pin: string) => Promise<string | null> }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const err = await onSubmit(pin);
    setBusy(false);
    if (err) {
      setError(err);
      setPin("");
    }
  }
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "go"];
  return (
    <div className="flex h-full w-full items-center gap-8 px-10">
      <div className="flex flex-1 flex-col items-center gap-4">
        <Orb state={busy ? "thinking" : "idle"} size={90} />
        <p className="text-2xl font-semibold">Hi {kid.name}</p>
        <p className="text-muted-foreground">Enter your PIN</p>
        <div className="flex h-6 gap-3" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <span key={i} className={cn("size-4 rounded-full border-2 border-white/40", i < pin.length && "bg-glow border-glow")} />
          ))}
        </div>
        <p className="text-destructive h-5 text-sm">{error}</p>
        <button type="button" onClick={onCancel} className="text-muted-foreground flex items-center gap-1 text-sm">
          <X className="size-4" /> Not you?
        </button>
      </div>
      <div className="grid w-[300px] grid-cols-3 gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy || (k === "go" && pin.length < 4)}
            onClick={() => {
              setError(null);
              if (k === "del") setPin((p) => p.slice(0, -1));
              else if (k === "go") go();
              else setPin((p) => (p.length < 8 ? p + k : p));
            }}
            className={cn(
              "flex h-[84px] items-center justify-center rounded-2xl border text-3xl font-medium disabled:opacity-40",
              k === "go" ? "bg-primary text-primary-foreground border-primary" : "border-white/10 bg-white/5 active:bg-white/15",
            )}
            aria-label={k === "del" ? "Delete" : k === "go" ? "Start" : k}
          >
            {k === "del" ? <Delete className="size-7" /> : k === "go" ? <Check className="size-8" /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}

function Big({
  icon: Icon,
  label,
  onClick,
  primary,
  wide,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  primary?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-14 items-center justify-center gap-2 rounded-xl border text-base font-semibold",
        primary ? "bg-primary text-primary-foreground border-primary active:opacity-80" : "border-white/10 bg-white/5 active:bg-white/15",
        wide && "h-11 text-sm",
      )}
    >
      <Icon className="size-5" /> {label}
    </button>
  );
}

/** The last photo of the page, with the tutor's marks beside each line. */
function PageView({ desk, token }: { desk: DeskState; token: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [ratio, setRatio] = useState(4 / 3);
  const loaded = useRef<number | null>(null);

  useEffect(() => {
    const id = desk.snapshotId;
    if (!id || loaded.current === id) return;
    let cancelled = false;
    fetch(`/api/v1/station/snapshots/${id}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b || cancelled) return;
        loaded.current = id;
        setSrc((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(b);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [desk.snapshotId, token]);

  if (!src) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 p-6 text-center">
        <Camera className="size-10 opacity-60" />
        <p>Put your paper under the camera and start writing.</p>
      </div>
    );
  }
  return (
    <div className="relative max-h-full max-w-full" style={{ aspectRatio: ratio, height: "100%" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Your page"
        className="h-full w-full rounded-xl object-contain"
        onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight || 4 / 3)}
      />
      {desk.lines.map((l, i) => {
        if (!l.handwritten) return null;
        const m = desk.marks[i]?.latex === l.latex ? desk.marks[i] : null;
        const status = m?.status ?? "pending";
        return (
          <div key={i}>
            {status === "look_here" && (
              <div
                className="bg-warn/25 ring-warn absolute rounded-md ring-2"
                style={{ left: `${l.x0 * 100 - 1.5}%`, width: `${(l.x1 - l.x0) * 100 + 3}%`, top: `${l.y * 100 - 3.5}%`, height: "7%" }}
              />
            )}
            <div
              className={cn(
                "absolute flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-lg font-bold shadow-lg",
                status === "ok" && "bg-ok text-black",
                status === "look_here" && "bg-warn text-black",
                status === "pending" && "border-2 border-dashed border-white/50",
                status === "not_checked" && "hidden",
              )}
              style={{ left: `${Math.min(94, l.x1 * 100 + 2)}%`, top: `${l.y * 100}%` }}
              aria-label={status === "ok" ? "Looks right" : status === "look_here" ? "Look again" : "Not checked yet"}
            >
              {status === "ok" ? <Check className="size-5" /> : status === "look_here" ? "?" : null}
            </div>
          </div>
        );
      })}
      {desk.unreadable && (
        <div className="bg-background/80 absolute inset-x-3 bottom-3 rounded-lg px-3 py-2 text-sm">
          <Markdown>{`Can't read the page right now: ${desk.unreadable}`}</Markdown>
        </div>
      )}
    </div>
  );
}

type SoundResult = { name: string; status: "waiting" | "running" | "ok" | "failed"; detail?: string };

/** Results of the sound check: the speaker, the built-in voice, and ElevenLabs, each tested on its own. */
function SoundCheck({ results, onClose }: { results: SoundResult[]; onClose: () => void }) {
  const finished = results.every((r) => r.status === "ok" || r.status === "failed");
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-6">
      <div className="bg-card w-full max-w-lg space-y-3 rounded-2xl border border-white/10 p-5">
        <p className="text-lg font-semibold">Sound check</p>
        {results.map((r) => (
          <div key={r.name} className="flex gap-3">
            <span className="w-6 shrink-0 text-center text-lg">
              {r.status === "ok" ? "✓" : r.status === "failed" ? "✗" : r.status === "running" ? "…" : ""}
            </span>
            <div className="min-w-0">
              <p className={cn("font-medium", r.status === "ok" && "text-ok", r.status === "failed" && "text-destructive")}>{r.name}</p>
              {r.detail && <p className="text-muted-foreground text-sm">{r.detail}</p>}
            </div>
          </div>
        ))}
        {finished && (
          <p className="text-muted-foreground text-xs">
            A ✓ means the browser played it. If you heard nothing for a ✓, the sound is going to a different output: see &ldquo;No sound&rdquo; in pi/README.md.
          </p>
        )}
        <button type="button" onClick={onClose} className="bg-primary text-primary-foreground w-full rounded-xl py-3 font-semibold disabled:opacity-50" disabled={!finished}>
          {finished ? "Close" : "Testing…"}
        </button>
      </div>
    </div>
  );
}

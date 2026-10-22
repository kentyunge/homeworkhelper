"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceProvider = "browser" | "elevenlabs";

// ---------- speaking ----------

/** A short silent clip, played on a tap so iPhones allow audio that starts later (after a reply arrives). */
function silentWav(): string {
  const samples = 800; // 0.1 s at 8 kHz, 8-bit mono
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  str(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function pickBrowserVoice(name: string): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (name) {
    const exact = voices.find((v) => v.name === name);
    if (exact) return exact;
  }
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const preferred = ["Google UK English Male", "Daniel", "Arthur", "Google US English", "Samantha", "Microsoft Guy", "Microsoft Aria"];
  for (const p of preferred) {
    const v = english.find((x) => x.name.includes(p));
    if (v) return v;
  }
  return english.find((v) => v.localService) ?? english[0] ?? null;
}

export function browserVoiceNames(): string[] {
  if (typeof speechSynthesis === "undefined") return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith("en"))
    .map((v) => v.name);
}

export function useSpeaker(provider: VoiceProvider, voiceId: string) {
  const [speaking, setSpeaking] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const token = useRef(0);

  useEffect(() => {
    audio.current = new Audio();
    // Voices load asynchronously in some browsers.
    if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
    return () => {
      audio.current?.pause();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    };
  }, []);

  /** Call from a tap (e.g. turning voice on, pressing the mic) so later playback is allowed. */
  const unlock = useCallback(() => {
    const a = audio.current;
    if (a) {
      a.src = silentWav();
      a.play().catch(() => {});
    }
    if (typeof speechSynthesis !== "undefined") {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }, []);

  const stop = useCallback(() => {
    token.current++;
    audio.current?.pause();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speakBrowser = useCallback(
    (text: string, my: number) =>
      new Promise<void>((resolve) => {
        if (typeof speechSynthesis === "undefined") return resolve();
        const u = new SpeechSynthesisUtterance(text);
        const v = pickBrowserVoice(provider === "browser" ? voiceId : "");
        if (v) u.voice = v;
        u.rate = 1.02;
        u.onend = u.onerror = () => {
          if (token.current === my) setSpeaking(false);
          resolve();
        };
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      }),
    [provider, voiceId],
  );

  const speak = useCallback(
    async (text: string) => {
      stop();
      const my = ++token.current;
      if (!text.trim()) return;
      setSpeaking(true);
      if (provider === "elevenlabs") {
        try {
          const res = await fetch("/api/v1/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) throw new Error(`tts ${res.status}`);
          const url = URL.createObjectURL(await res.blob());
          if (token.current !== my) return;
          const a = audio.current!;
          a.src = url;
          await new Promise<void>((resolve, reject) => {
            a.onended = () => resolve();
            a.onerror = () => reject(new Error("playback failed"));
            a.play().catch(reject);
          });
          URL.revokeObjectURL(url);
          if (token.current === my) setSpeaking(false);
          return;
        } catch (e) {
          console.warn("[voice] natural voice failed, using the browser voice", e);
          if (token.current !== my) return;
        }
      }
      await speakBrowser(text, my);
    },
    [provider, speakBrowser, stop],
  );

  return { speak, stop, unlock, speaking };
}

// ---------- listening ----------

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Push-to-talk speech recognition (the browser's own; in Chrome, audio goes to Google to be transcribed).
 * start() when the button goes down, stop() when it comes up; stop() resolves with what was heard.
 */
export function useListener() {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalText = useRef("");
  const done = useRef<((text: string) => void) | null>(null);
  const interimRef = useRef("");

  useEffect(() => {
    // Feature detection has to wait for the browser; the server render can't know.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(!!recognitionClass());
  }, []);

  const start = useCallback(() => {
    const Cls = recognitionClass();
    if (!Cls || rec.current) return;
    const r = new Cls();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    finalText.current = "";
    interimRef.current = "";
    setInterim("");
    setError(null);
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText.current += res[0].transcript + " ";
        else live += res[0].transcript;
      }
      interimRef.current = (finalText.current + live).trim();
      setInterim(interimRef.current);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Microphone access is blocked. Allow it in the browser's site settings, or type instead.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setError("I couldn't hear that. Try again, or type instead.");
      }
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const text = finalText.current.trim();
      done.current?.(text);
      done.current = null;
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
    }
  }, []);

  const stop = useCallback(
    () =>
      new Promise<string>((resolve) => {
        if (!rec.current) return resolve(finalText.current.trim());
        // Give the recognizer a moment to finalize the last words.
        done.current = (t) => resolve(t || interimRef.current);
        setTimeout(() => rec.current?.stop(), 250);
      }),
    [],
  );

  const cancel = useCallback(() => {
    done.current = null;
    rec.current?.abort();
    rec.current = null;
    setListening(false);
    setInterim("");
  }, []);

  return { supported, listening, interim, error, start, stop, cancel };
}

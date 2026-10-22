import { badRequest } from "./errors";

/**
 * Natural voices through ElevenLabs. The browser's built-in voices need nothing from the server;
 * this is used only when a kid's profile has voice provider "elevenlabs" and ELEVENLABS_API_KEY is set.
 * To switch to another service later, add a function like this one and a provider option in family.ts.
 */
export function elevenLabsConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

export async function elevenLabsSpeech(text: string, voiceId: string): Promise<Response> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw badRequest("ElevenLabs isn't set up (ELEVENLABS_API_KEY is missing)");
  const voice = voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  if (!voice) throw badRequest("Pick an ElevenLabs voice for this profile");
  const clean = text.trim().slice(0, 1000);
  if (!clean) throw badRequest("Nothing to say");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: clean, model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5" }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    console.error(`[tts] ElevenLabs ${res.status}: ${detail.slice(0, 300)}`);
    throw badRequest(`The voice service returned an error (${res.status})`);
  }
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

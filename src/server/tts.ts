import { badRequest } from "./errors";

/**
 * Natural voices through ElevenLabs. The browser's built-in voices need nothing from the server;
 * this is used only when a kid's profile has voice provider "elevenlabs" and ELEVENLABS_API_KEY is set.
 * To switch to another service later, add a function like this one and a provider option in family.ts.
 */
export function elevenLabsConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

/** ElevenLabs' own explanation of an error, from its JSON body ({ detail: { message } } or { detail: "..." }). */
function explain(status: number, body: string): string {
  let message = "";
  try {
    const j = JSON.parse(body) as { detail?: { message?: string; status?: string } | string };
    message = typeof j.detail === "string" ? j.detail : (j.detail?.message ?? j.detail?.status ?? "");
  } catch {
    message = body.slice(0, 200);
  }
  if (status === 401) return `ElevenLabs rejected the API key${message ? `: ${message}` : ""}. Check ELEVENLABS_API_KEY in Vercel.`;
  if (status === 404 || /voice.*not.*found/i.test(message)) return `ElevenLabs couldn't find that voice ID. Copy it again from the ElevenLabs voice library${message ? ` (${message})` : ""}.`;
  return `ElevenLabs error ${status}${message ? `: ${message}` : ""}`;
}

export async function elevenLabsSpeech(text: string, voiceId: string): Promise<Response> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw badRequest("ElevenLabs isn't set up (ELEVENLABS_API_KEY is missing in Vercel)");
  const voice = voiceId.trim() || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  if (!voice) throw badRequest("No ElevenLabs voice ID: add one on the kid's settings page");
  const clean = text.trim().slice(0, 1000);
  if (!clean) throw badRequest("Nothing to say");

  const call = (model: string | null) =>
    fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify(model ? { text: clean, model_id: model } : { text: clean }),
    });
  let res = await call(process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5");
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const detail = await res.text().catch(() => "");
    console.error(`[tts] ElevenLabs ${res.status}: ${detail.slice(0, 300)}`);
    // A model name that's been retired or isn't on this plan: try again with ElevenLabs' default model.
    if (/model/i.test(detail)) res = await call(null);
    else throw badRequest(explain(res.status, detail));
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    console.error(`[tts] ElevenLabs ${res.status}: ${detail.slice(0, 300)}`);
    throw badRequest(explain(res.status, detail));
  }
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

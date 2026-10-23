/**
 * The desk station installer, with this app's address filled in. On the Raspberry Pi:
 *   curl -fsSL https://<this app>/pi/install | bash
 * The script itself is public/pi/install.sh (served as a static file, so fetched rather than read from disk).
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/pi/install.sh`, { cache: "no-store" });
  if (!res.ok) return new Response(`echo "Couldn't load the installer (${res.status})"; exit 1\n`, { status: 502 });
  const script = await res.text();
  return new Response(script.replaceAll("__APP_URL__", origin), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

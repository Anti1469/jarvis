// Jarvis hang-híd — Cloudflare Worker
// A Fish Audio API nem fogad közvetlen böngészős kéréseket, ezért ez a kis szerver
// továbbítja a Jarvis oldal felolvasási kéréseit. A Fish Audio kulcs itt, titokban marad.
//
// Beállítandó titkos változók (Cloudflare → Worker → Settings → Variables and Secrets):
//   FISH_API_KEY  – a Fish Audio API-kulcsod (fish.audio → API Keys)
//   ACCESS_KEY    – egy általad kitalált jelszó; ugyanezt írod be a Jarvis Beállításokba
// Nem kötelező:
//   VOICE_ID      – alapértelmezett hangmodell (ha a Jarvis nem küld)
//   FISH_MODEL    – Fish Audio modell, pl. "s2.1-pro" (alapértelmezés) vagy "s2.1-pro-free"

const ALLOWED_ORIGINS = ["https://anti1469.github.io", "http://localhost:5173"];
const DEFAULT_VOICE = "612b878b113047d9a770c069c8b4fdfe";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-jarvis-key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (status, message) =>
      new Response(JSON.stringify({ message }), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json(405, "Csak POST kérés engedélyezett.");
    if (!env.FISH_API_KEY) return json(500, "A hídban nincs beállítva a FISH_API_KEY.");
    if (!env.ACCESS_KEY || request.headers.get("x-jarvis-key") !== env.ACCESS_KEY) return json(401, "Hibás hozzáférési kulcs.");

    let body;
    try { body = await request.json(); } catch { return json(400, "Hibás kérés."); }
    const text = String(body.text || "").slice(0, 3000).trim();
    if (!text) return json(400, "Nincs felolvasandó szöveg.");
    const voice = /^[a-f0-9]{32}$/.test(body.reference_id || "") ? body.reference_id : (env.VOICE_ID || DEFAULT_VOICE);

    const upstream = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + env.FISH_API_KEY,
        "content-type": "application/json",
        "model": env.FISH_MODEL || "s2.1-pro",
      },
      body: JSON.stringify({ text, reference_id: voice, format: "mp3", latency: "balanced" }),
    });

    if (!upstream.ok) {
      let msg = "Fish Audio hiba (" + upstream.status + ")";
      try { const d = await upstream.json(); if (d.message) msg += ": " + d.message; } catch {}
      if (upstream.status === 402) msg = "A Fish Audio fiókon nincs elég kredit.";
      if (upstream.status === 401) msg = "A Fish Audio kulcs érvénytelen.";
      return json(upstream.status, msg);
    }
    return new Response(upstream.body, { status: 200, headers: { ...cors, "content-type": "audio/mpeg", "cache-control": "no-store" } });
  },
};

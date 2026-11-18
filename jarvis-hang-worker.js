// Jarvis híd — Cloudflare Worker
// 1) Hang: továbbítja a felolvasási kéréseket a Fish Audiónak (a böngésző közvetlenül nem hívhatja).
// 2) Felhő mentés: eltárolja a Jarvis adatait. Az adat már a böngészőben titkosítva érkezik,
//    a híd és a Cloudflare csak olvashatatlan adatot lát.
//
// Beállítandó (Cloudflare → Worker → Settings → Variables and Secrets), mindkettő típusa: Secret
//   FISH_API_KEY  – a Fish Audio API-kulcsod
//   ACCESS_KEY    – a Jarvis által adott hozzáférési kód
// Kötés (Settings → Bindings → KV namespace):
//   JARVIS_KV     – egy KV tároló a felhő mentéshez
// Nem kötelező: VOICE_ID (alapértelmezett hang), FISH_MODEL (pl. "s2.1-pro" vagy "s2.1-pro-free")

const ALLOWED_ORIGINS = ["https://anti1469.github.io", "http://localhost:5173"];
const DEFAULT_VOICE = "612b878b113047d9a770c069c8b4fdfe";
const MAX_SYNC_BYTES = 20 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const decodeEntities = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const cleanText = s => decodeEntities(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-jarvis-key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (status, obj) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const err = (status, message) => json(status, { message });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Próbálkozás-korlát: IP-nként 15 percen belül legfeljebb 10 hibás kód, utána tiltás.
    const ip = request.headers.get("CF-Connecting-IP") || "ismeretlen";
    const failKey = "fail:" + ip;
    const fails = env.JARVIS_KV ? Number(await env.JARVIS_KV.get(failKey)) || 0 : 0;
    if (fails >= 10) return err(429, "Túl sok sikertelen próbálkozás. Próbáld újra 15 perc múlva.");
    if (!env.ACCESS_KEY || request.headers.get("x-jarvis-key") !== env.ACCESS_KEY) {
      if (env.JARVIS_KV) await env.JARVIS_KV.put(failKey, String(fails + 1), { expirationTtl: 900 });
      return err(401, "Hibás hozzáférési kód.");
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    // ---------- bejelentkezés ellenőrzése ----------
    if (path === "/auth") return json(200, { ok: true });

    // ---------- internet: keresés és weboldal olvasás ----------
    if (path === "/search" && request.method === "GET") {
      const q = (new URL(request.url).searchParams.get("q") || "").trim().slice(0, 300);
      if (!q) return err(400, "Nincs keresőkifejezés.");
      const results = [];
      try {
        // 1) DuckDuckGo Lite
        const r = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q) + "&kl=hu-hu", { headers: { "user-agent": UA, "accept-language": "hu-HU,hu;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(10000) });
        const html = await r.text();
        const re = /<a[^>]*href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>[\s\S]*?class='result-snippet'>([\s\S]*?)<\/td>/g;
        let m;
        while ((m = re.exec(html)) && results.length < 8) {
          let url = decodeEntities(m[1]);
          const u = url.match(/[?&]uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
          if (url.startsWith("//")) url = "https:" + url;
          if (/duckduckgo\.com\/y\.js|[?&]ad_domain=/.test(url)) continue; // hirdetések kihagyása
          results.push({ title: cleanText(m[2]), url, snippet: cleanText(m[3]) });
        }
      } catch (e) {}
      if (!results.length) {
        // 2) tartalék: Wikipédia keresés
        try {
          const wr = await fetch("https://hu.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=" + encodeURIComponent(q), { headers: { "user-agent": "JarvisBridge/1.0" }, signal: AbortSignal.timeout(8000) });
          const wd = await wr.json();
          for (const s of (wd.query && wd.query.search) || []) results.push({ title: s.title + " – Wikipédia", url: "https://hu.wikipedia.org/wiki/" + encodeURIComponent(s.title.replace(/ /g, "_")), snippet: cleanText(s.snippet) });
        } catch (e) {}
      }
      if (!results.length) return err(502, "A kereső most nem adott találatot.");
      return json(200, { results });
    }
    if (path === "/fetch" && request.method === "GET") {
      const target = new URL(request.url).searchParams.get("url") || "";
      let u; try { u = new URL(target); } catch { return err(400, "Hibás cím."); }
      if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$)/i.test(u.hostname)) return err(400, "Ez a cím nem engedélyezett.");
      try {
        const r = await fetch(u.toString(), { headers: { "user-agent": UA, "accept-language": "hu-HU,hu;q=0.9,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
        const type = r.headers.get("content-type") || "";
        if (!/text\/|json|xml/.test(type)) return err(415, "Ez nem szöveges oldal (" + type.split(";")[0] + ").");
        const raw = (await r.text()).slice(0, 1500000);
        const title = cleanText((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
        const text = /html/.test(type) ? htmlToText(raw) : raw;
        return json(200, { url: r.url, status: r.status, title, text: text.slice(0, 20000) });
      } catch (e) { return err(502, "Az oldal nem tölthető be."); }
    }

    // ---------- felhő mentés ----------
    if (path === "/sync") {
      if (!env.JARVIS_KV) return err(501, "A hídhoz nincs KV tároló kötve (JARVIS_KV).");
      if (request.method === "GET") {
        const v = await env.JARVIS_KV.get("state", "json");
        return json(200, v || { updated: 0, data: null });
      }
      if (request.method === "PUT") {
        const raw = await request.text();
        if (raw.length > MAX_SYNC_BYTES) return err(413, "Túl sok adat a felhő mentéshez.");
        let body; try { body = JSON.parse(raw); } catch { return err(400, "Hibás adat."); }
        if (!body || typeof body.data !== "string" || typeof body.iv !== "string" || !Number.isFinite(body.updated)) return err(400, "Hibás adat.");
        const cur = await env.JARVIS_KV.get("state", "json");
        if (cur && cur.updated > body.updated && !body.force) return json(409, { message: "Újabb mentés van a felhőben.", updated: cur.updated });
        await env.JARVIS_KV.put("state", JSON.stringify({ data: body.data, iv: body.iv, updated: body.updated, device: String(body.device || "").slice(0, 60) }));
        return json(200, { ok: true, updated: body.updated });
      }
      return err(405, "Nem támogatott kérés.");
    }

    // ---------- hang ----------
    if (request.method !== "POST" || (path !== "/" && path !== "/tts")) return err(404, "Ismeretlen cím.");
    if (!env.FISH_API_KEY) return err(500, "A hídban nincs beállítva a FISH_API_KEY.");
    let body;
    try { body = await request.json(); } catch { return err(400, "Hibás kérés."); }
    const text = String(body.text || "").slice(0, 3000).trim();
    if (!text) return err(400, "Nincs felolvasandó szöveg.");
    const voice = /^[a-f0-9]{32}$/.test(body.reference_id || "") ? body.reference_id : (env.VOICE_ID || DEFAULT_VOICE);

    const upstream = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { "authorization": "Bearer " + env.FISH_API_KEY, "content-type": "application/json", "model": env.FISH_MODEL || "s2.1-pro" },
      body: JSON.stringify({ text, reference_id: voice, format: "mp3", latency: "balanced" }),
    });
    if (!upstream.ok) {
      let msg = "Fish Audio hiba (" + upstream.status + ")";
      try { const d = await upstream.json(); if (d.message) msg += ": " + d.message; } catch {}
      if (upstream.status === 402) msg = "A Fish Audio fiókon nincs elég kredit.";
      if (upstream.status === 401) msg = "A Fish Audio kulcs érvénytelen.";
      return err(upstream.status, msg);
    }
    return new Response(upstream.body, { status: 200, headers: { ...cors, "content-type": "audio/mpeg", "cache-control": "no-store" } });
  },
};

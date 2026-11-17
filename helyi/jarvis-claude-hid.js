// Jarvis ⇄ Claude Code helyi híd
// A gépeden futó Claude Code-ot (a saját előfizetéseddel) teszi elérhetővé a Jarvis oldal számára.
// Csak ezen a gépen működik, és csak a Jarvis oldalról fogad kérést.
// Indítás: kattints duplán a "Jarvis-Claude-inditas.bat" fájlra (vagy: node jarvis-claude-hid.js)

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.JARVIS_PORT) || 8765;
const ALLOWED_ORIGINS = ["https://anti1469.github.io", "http://localhost:5173"];
const MODELS = ["sonnet", "opus", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
// Bármilyen Claude-modellnév elfogadott (rövid név vagy teljes azonosító); csak a biztonságos karaktereket engedjük át.
const validModel = m => typeof m === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._\[\]-]{1,59}$/.test(m); // kötőjellel nem kezdődhet, így nem lehet belőle parancssori kapcsoló
const TIMEOUT_MS = 5 * 60 * 1000;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-claude-"));

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
function send(res, origin, status, obj) {
  res.writeHead(status, { ...cors(origin), "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function askClaude({ system, user, model }) {
  return new Promise((resolve, reject) => {
    const sysFile = path.join(WORKDIR, "system-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".txt");
    fs.writeFileSync(sysFile, system || "Te Jarvis vagy, egy segítőkész AI asszisztens.", "utf8");
    const args = ["-p", "--output-format", "json", "--model", validModel(model) ? model : "sonnet",
      "--system-prompt-file", sysFile, "--tools", ""];
    const child = spawn("claude", args, { cwd: WORKDIR, windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("A Claude Code nem válaszolt 5 percen belül.")); }, TIMEOUT_MS);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => { clearTimeout(timer); reject(new Error("Nem indítható a Claude Code: " + e.message)); });
    child.on("close", code => {
      clearTimeout(timer);
      try { fs.unlinkSync(sysFile); } catch {}
      let data = null;
      try { data = JSON.parse(out); } catch {}
      if (data && !data.is_error && typeof data.result === "string") return resolve(data.result);
      const msg = (data && (data.result || data.error)) || err.trim() || ("kilépési kód: " + code);
      if (/login|log in|auth|credential/i.test(msg)) return reject(new Error("A Claude Code nincs bejelentkezve. Nyiss egy terminált, írd be: claude, és jelentkezz be."));
      if (/limit|usage|rate/i.test(msg)) return reject(new Error("Elérted az előfizetésed használati korlátját: " + msg));
      reject(new Error("Claude Code hiba: " + String(msg).slice(0, 300)));
    });
    child.stdin.end(String(user || ""), "utf8");
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") { res.writeHead(204, cors(origin)); return res.end(); }
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return send(res, origin, 403, { message: "Ez az oldal nem használhatja a hidat." });
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") return send(res, origin, 200, { ok: true, models: MODELS });

  if (req.method === "POST" && url.pathname === "/chat") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, origin, 400, { message: "Hibás kérés." }); }
      const t0 = Date.now();
      try {
        const text = await askClaude(body);
        console.log(`[${new Date().toLocaleTimeString("hu-HU")}] kész (${validModel(body.model) ? body.model : "sonnet"}, ${Math.round((Date.now() - t0) / 1000)} mp)`);
        send(res, origin, 200, { text });
      } catch (e) {
        console.log(`[${new Date().toLocaleTimeString("hu-HU")}] hiba: ${e.message}`);
        send(res, origin, 502, { message: e.message });
      }
    });
    return;
  }
  send(res, origin, 404, { message: "Ismeretlen cím." });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Jarvis ⇄ Claude Code híd fut: http://127.0.0.1:" + PORT);
  console.log("Hagyd nyitva ezt az ablakot, amíg a Jarvist használod. Leállítás: zárd be az ablakot.");
});
server.on("error", e => {
  if (e.code === "EADDRINUSE") console.log("A híd már fut egy másik ablakban (" + PORT + "-es port).");
  else console.log("Hiba: " + e.message);
});

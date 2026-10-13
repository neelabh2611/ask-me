// Steady brain server: REST + SSE + static UI + scheduler. Single process.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, getSetting, setSetting, logActivity } from "./db.js";
import { handleTurn, getOrCreateConv } from "./converse.js";
import { runReflection } from "./reflect.js";
import { addMemory, correctMemory, searchMemories, getMemory, updateMemory, deleteMemory, exportMemories } from "./memory.js";
import { enqueueJob, cancelJob, listJobs, pumpOnce, startScheduler } from "./jobs.js";
import { pendingMoments, setMoment, sseSubscribe, queueMoment } from "./notify.js";
import { speak, transcribe, budgetOk } from "./sarvam.js";
import { execTool, toolDefs } from "./tools.js";
import { getPet, renamePet, registerTurn, petAct, petSay, addPetGoal } from "./pet.js";

const db = openDb();
globalThis.__brainDb = db;
const PORT = Number(process.env.PORT || 3000);
const PUB = path.normalize(fileURLToPath(new URL("../public/", import.meta.url)));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon", ".json": "application/json", ".glb": "model/gltf-binary" };

function body(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 3_000_000) { req.destroy(); rej(new Error("body too large")); } });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error("bad JSON")); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
const err = (res, e) => send(res, /not found|bad |empty|too long|Missing|disabled|unknown/.test(e.message) ? 400 : 500, { error: String(e.message).slice(0, 300) });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    // SSE moments stream
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": ok\n\n");
      sseSubscribe(res);
      return;
    }
    // Chat
    if (p === "/api/chat" && req.method === "POST") {
      const b = await body(req);
      const out = await handleTurn(db, { convId: b.convId ?? null, text: b.text });
      const pet = registerTurn(db, { userText: b.text, replyText: out.reply });
      logActivity(db, "user", "chat", { conv: out.convId });
      return send(res, 200, { ...out, pet });
    }
    if (p === "/api/conversations" && req.method === "GET") {
      return send(res, 200, { conversations: db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 20").all() });
    }
    if (/^\/api\/conversations\/\d+\/messages$/.test(p) && req.method === "GET") {
      const id = Number(p.split("/")[3]);
      return send(res, 200, { messages: db.prepare("SELECT * FROM messages WHERE conv_id=? ORDER BY id").all(id) });
    }
    if (/^\/api\/reflect\/\d+$/.test(p) && req.method === "POST") {
      return send(res, 200, await runReflection(db, Number(p.split("/")[3])));
    }
    // Memories
    if (p === "/api/memories" && req.method === "GET") {
      const q = u.searchParams.get("q"), type = u.searchParams.get("type");
      const list = q ? searchMemories(db, q, { types: type ? [type] : null }) : db.prepare("SELECT * FROM memories WHERE status='active' ORDER BY updated_at DESC LIMIT 50").all();
      return send(res, 200, { memories: list });
    }
    if (p === "/api/memories" && req.method === "POST") {
      const b = await body(req);
      const out = b.correct ? correctMemory(db, b) : addMemory(db, { ...b, source: b.source || "user" });
      logActivity(db, "user", "memory-add", out);
      return send(res, 200, out);
    }
    if (/^\/api\/memories\/\d+$/.test(p) && req.method === "PATCH") {
      const b = await body(req);
      return send(res, 200, updateMemory(db, Number(p.split("/")[3]), b));
    }
    if (/^\/api\/memories\/\d+$/.test(p) && req.method === "DELETE") {
      deleteMemory(db, Number(p.split("/")[3]));
      logActivity(db, "user", "memory-delete", { id: Number(p.split("/")[3]) });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/memories/export" && req.method === "GET") {
      return send(res, 200, { memories: exportMemories(db) });
    }
    // Jobs + activity + moments
    if (p === "/api/jobs" && req.method === "GET") return send(res, 200, { jobs: listJobs(db) });
    if (p === "/api/jobs" && req.method === "POST") {
      const b = await body(req);
      if (!["reflect", "consolidate", "digest", "moment-check", "research"].includes(b.kind)) throw new Error("bad job kind");
      return send(res, 200, { id: enqueueJob(db, b.kind, b.payload || {}, { dedupeKey: b.dedupeKey || null }) });
    }
    if (/^\/api\/jobs\/\d+\/cancel$/.test(p) && req.method === "POST") {
      cancelJob(db, Number(p.split("/")[3]));
      return send(res, 200, { ok: true });
    }
    if (p === "/api/jobs/pump" && req.method === "POST") return send(res, 200, { ran: await pumpOnce(db) });
    if (p === "/api/activity" && req.method === "GET") {
      return send(res, 200, { activity: db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 60").all() });
    }
    if (p === "/api/moments" && req.method === "GET") return send(res, 200, { moments: pendingMoments(db) });
    if (/^\/api\/moments\/\d+$/.test(p) && req.method === "POST") {
      const b = await body(req);
      setMoment(db, Number(p.split("/")[3]), b.status);
      return send(res, 200, { ok: true });
    }
    // Tools
    if (p === "/api/tools" && req.method === "GET") return send(res, 200, { tools: toolDefs().map(t => ({ name: t.name, desc: t.desc, perm: t.perm })) });
    if (p === "/api/tools/exec" && req.method === "POST") {
      const b = await body(req);
      return send(res, 200, await execTool(db, b.name, b.args || {}));
    }
    // Voice
    if (p === "/api/speak" && req.method === "POST") {
      const b = await body(req);
      return send(res, 200, { audio: await speak(db, String(b.text || ""), b.lang || "en-IN") });
    }
    if (p === "/api/listen" && req.method === "POST") {
      const b = await body(req);
      if (!b.audioBase64) throw new Error("audioBase64 required");
      return send(res, 200, await transcribe(db, b.audioBase64, b.mime || "audio/webm"));
    }
    // Pet
    if (p === "/api/pet/state" && req.method === "GET") return send(res, 200, getPet(db));
    if (p === "/api/pet/act" && req.method === "POST") {
      const b = await body(req);
      return send(res, 200, petAct(db, b.action));
    }
    if (p === "/api/pet/say" && req.method === "POST") {
      const b = await body(req);
      if (!b.text?.trim()) throw new Error("empty message");
      const said = await petSay(db, b.text);
      let audio = null;
      if (b.voice !== false) { try { audio = await speak(db, said.text); } catch { /* silent */ } }
      return send(res, 200, { ...said, audio });
    }
    if (p === "/api/pet/goal" && req.method === "POST") {
      const b = await body(req);
      if (!b.content?.trim()) throw new Error("empty goal");
      return send(res, 200, { id: addPetGoal(db, b.content) });
    }
    if (p === "/api/pet/rename" && req.method === "POST") {
      const b = await body(req);
      return send(res, 200, { name: renamePet(db, b.name) });
    }
    // Settings + usage
    if (p === "/api/settings" && req.method === "GET") {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      return send(res, 200, { settings: Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)])) });
    }
    if (p === "/api/settings" && req.method === "PUT") {
      const b = await body(req);
      for (const [k, v] of Object.entries(b)) {
        if (!["personality", "autonomy", "budget", "tools"].includes(k)) throw new Error("bad setting: " + k);
        setSetting(db, k, v);
      }
      logActivity(db, "user", "settings", { keys: Object.keys(b) });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/usage" && req.method === "GET") {
      const b = budgetOk(db, 0);
      const rows = db.prepare("SELECT endpoint, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, COUNT(*) AS n FROM usage_log GROUP BY endpoint").all();
      return send(res, 200, { budget: b, byEndpoint: rows });
    }
    // Static
    let f = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(PUB, f));
    if (!fp.startsWith(PUB) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { try { err(res, e); } catch { /* closed */ } }
});

server.listen(PORT, () => console.log(`steady brain on http://localhost:${PORT}`));
startScheduler(db);

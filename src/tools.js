// Permission-controlled tools. Read-only web + memory tools. No destructive tools exist.
// Permission levels per tool: "auto" (run + log) or "deny". Sensitive actions = deny by default.
import { searchMemories } from "./memory.js";
import { getSetting, logActivity } from "./db.js";

export function toolDefs() {
  return [
    { name: "memory_search", desc: "Search long-term memory", perm: "auto" },
    { name: "web_fetch", desc: "Fetch a URL as text (5s timeout, 8KB cap)", perm: getSettingPerm("web_fetch") }
  ];
}
function getSettingPerm(name) {
  try {
    const db = globalThis.__brainDb;
    const t = db ? getSetting(db, "tools", {})[name] : "auto";
    return t === "deny" ? "deny" : "auto";
  } catch { return "auto"; }
}

export async function execTool(db, name, args = {}) {
  globalThis.__brainDb = db;
  const def = toolDefs().find(t => t.name === name);
  if (!def) throw new Error("unknown tool: " + name);
  if (def.perm === "deny") {
    logActivity(db, "tool", "denied", { name, args: safeArgs(args) });
    return { denied: true, message: `Tool ${name} is disabled in settings.` };
  }
  let result;
  if (name === "memory_search") {
    result = { results: searchMemories(db, String(args.query || ""), { limit: 5 }).map(m => ({ id: m.id, type: m.type, content: m.content, score: m.score })) };
  } else if (name === "web_fetch") {
    result = await webFetch(String(args.url || ""));
  }
  logActivity(db, "tool", name, { args: safeArgs(args), ok: !result?.error });
  return result;
}
function safeArgs(a) { const s = JSON.stringify(a); return JSON.parse(s.slice(0, 500)); }

async function webFetch(url) {
  let u;
  try { u = new URL(url); } catch { return { error: "bad URL" }; }
  if (!["http:", "https:"].includes(u.protocol)) return { error: "protocol denied" };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(u, { signal: c.signal, headers: { "User-Agent": "steady-brain/0.1" } }).finally(() => clearTimeout(t));
    const text = await r.text();
    const clean = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { status: r.status, url: u.href, text: clean.slice(0, 8000), truncated: clean.length > 8000 };
  } catch (e) { return { error: "fetch failed: " + String(e.message || e).slice(0, 150) }; }
}

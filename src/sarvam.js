// Sarvam API adapter: chat + memory extraction + voice. Retries, timeouts, budget.
import { getSetting, logActivity } from "./db.js";

const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";
const STT_URL = "https://api.sarvam.ai/speech-to-text";
const key = () => process.env.SARVAM_API_KEY;

function assertKey() { if (!key()) throw new Error("Missing SARVAM_API_KEY"); }

async function withRetry(fn, attempts = 3) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { err = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw err;
}
function timeoutFetch(url, opts, ms = 45000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

export function budgetOk(db, estTokens = 2000) {
  const cap = getSetting(db, "budget", { monthly_token_cap: 500000 }).monthly_token_cap;
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  const r = db.prepare("SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS t FROM usage_log WHERE created_at >= ?").get(start.getTime());
  return { ok: r.t + estTokens <= cap, used: r.t, cap };
}
export function logUsage(db, endpoint, tokens_in = 0, tokens_out = 0) {
  db.prepare("INSERT INTO usage_log (endpoint, tokens_in, tokens_out, created_at) VALUES (?,?,?,?)").run(endpoint, tokens_in, tokens_out, Date.now());
}

export async function chat(db, messages, { model = "sarvam-105b-conversations", temperature = 0.5, max_tokens = 800, json = false } = {}) {
  assertKey();
  const b = budgetOk(db);
  if (!b.ok) throw new Error(`Monthly token budget exceeded (${b.used}/${b.cap})`);
  const body = { model, messages, temperature, max_tokens, reasoning_effort: null };
  if (json) body.response_format = { type: "json_object" };
  const data = await withRetry(async () => {
    const r = await timeoutFetch(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json", "api-subscription-key": key() }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `chat HTTP ${r.status}`);
    return d;
  });
  logUsage(db, "chat", data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);
  return data.choices?.[0]?.message?.content || "";
}

// Reflection pass: extract durable memories from recent turns. Returns array of
// {type,key,content,confidence,importance} or {unresolved} questions. Never throws.
export async function extractMemories(db, turns) {
  const convo = turns.map(t => `${t.role}: ${t.content}`).join("\n").slice(0, 6000);
  const prompt = `From this conversation, extract durable memories as JSON: {"memories":[{"type":"fact|preference|project|procedure|episode|question","key":"optional stable slot like pref:style or proj:name","content":"one crisp sentence","confidence":0-1,"importance":0-1}],"unresolved":["open questions with no answer"]}.
Rules: only store what matters in a week; skip chit-chat; corrections get importance>=0.8; inferred items confidence<=0.6; max 6 memories.\n\n${convo}`;
  try {
    const out = await chat(db, [{ role: "user", content: prompt }], { max_tokens: 900, json: true, temperature: 0.2 });
    const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { memories: parsed.memories || [], unresolved: parsed.unresolved || [] };
  } catch (e) {
    logActivity(db, "brain", "reflect-parse-failed", { error: String(e.message || e).slice(0, 200) });
    return { memories: [], unresolved: [] };
  }
}

export async function speak(db, text, language_code = "en-IN") {
  assertKey();
  const data = await withRetry(async () => {
    const r = await timeoutFetch(TTS_URL, { method: "POST", headers: { "Content-Type": "application/json", "api-subscription-key": key() },
      body: JSON.stringify({ text: text.slice(0, 2000), language_code, speaker: "simran", model: "bulbul:v3", pace: 1.0 }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `tts HTTP ${r.status}`);
    return d;
  });
  logUsage(db, "tts", 0, 0);
  return (data.audios || []).join("");
}

export async function transcribe(db, audioB64, mime = "audio/webm") {
  assertKey();
  const bytes = Buffer.from(audioB64, "base64");
  if (bytes.length > 2_000_000) throw new Error("audio too long, keep under 30s");
  const form = new FormData();
  form.set("model", "saaras:v4");
  form.set("mode", "transcribe");
  form.set("file", new Blob([bytes], { type: mime }), "voice.webm");
  const data = await withRetry(async () => {
    const r = await timeoutFetch(STT_URL, { method: "POST", headers: { "api-subscription-key": key() }, body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `stt HTTP ${r.status}`);
    return d;
  });
  logUsage(db, "stt", 0, 0);
  return { transcript: data.transcript || "", language_code: data.language_code || null };
}

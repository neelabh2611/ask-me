// Background job queue + scheduler + continuity (moments) loop.
// Runs inside server process. Survives UI close, not host reboot (see README deploy).
import { getSetting, logActivity } from "./db.js";
import { runReflection, runConsolidation } from "./reflect.js";
import { chat } from "./sarvam.js";
import { queueMoment } from "./notify.js";

export function enqueueJob(db, kind, payload = {}, { runAt = Date.now(), dedupeKey = null, maxAttempts = 3 } = {}) {
  const t = Date.now();
  try {
    const r = db.prepare(`INSERT INTO jobs (kind, payload, status, run_at, max_attempts, dedupe_key, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(kind, JSON.stringify(payload), "queued", runAt, maxAttempts, dedupeKey, t, t);
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return null; // duplicate suppressed
    throw e;
  }
}
export function cancelJob(db, id) {
  db.prepare("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=? AND status IN ('queued','failed')").run(Date.now(), id);
}
export function listJobs(db, limit = 30) {
  return db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?").all(limit);
}

// Single-flight claim: atomic status flip, resume-safe.
function claim(db) {
  return db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1, updated_at=?
    WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_at <= ? ORDER BY run_at LIMIT 1)
    RETURNING *`).get(Date.now(), Date.now());
}

const HANDLERS = {
  async reflect(db, p) { return runReflection(db, p.convId); },
  async consolidate(db) { return runConsolidation(db); },
  async digest(db, p) { return buildDigest(db, p.range || "day"); },
  async "moment-check"(db) { return momentCheck(db); },
  async research(db, p) {
    const { execTool } = await import("./tools.js");
    const out = await execTool(db, "web_fetch", { url: p.url });
    return { url: p.url, ...out };
  }
};

export async function pumpOnce(db) {
  const auto = getSetting(db, "autonomy", {});
  if (auto.enabled === false) return null; // kill switch
  const job = claim(db);
  if (!job) return null;
  const payload = JSON.parse(job.payload || "{}");
  try {
    const fn = HANDLERS[job.kind];
    if (!fn) throw new Error("unknown job kind: " + job.kind);
    const result = await fn(db, payload);
    db.prepare("UPDATE jobs SET status='done', result=?, updated_at=? WHERE id=?").run(JSON.stringify(result).slice(0, 4000), Date.now(), job.id);
    logActivity(db, "job", "done", { id: job.id, kind: job.kind });
    return { id: job.id, kind: job.kind, result };
  } catch (e) {
    const tries = job.attempts;
    const failed = tries >= job.max_attempts;
    db.prepare("UPDATE jobs SET status=?, last_error=?, run_at=?, updated_at=? WHERE id=?")
      .run(failed ? "failed" : "queued", String(e.message || e).slice(0, 500), Date.now() + 60000 * tries, Date.now(), job.id);
    logActivity(db, "job", failed ? "failed" : "retry", { id: job.id, kind: job.kind, error: String(e.message || e).slice(0, 200) });
    return { id: job.id, kind: job.kind, error: String(e.message || e).slice(0, 200) };
  }
}

export function startScheduler(db, { intervalMs = 15000 } = {}) {
  // Seed recurring jobs if absent.
  const has = (k) => db.prepare("SELECT 1 FROM jobs WHERE kind=? AND status IN ('queued','running') LIMIT 1").get(k);
  if (!has("moment-check")) enqueueJob(db, "moment-check", {}, { runAt: Date.now() + 60000, dedupeKey: "recur:moment-check" });
  const timer = setInterval(async () => {
    try {
      await pumpOnce(db);
      // re-schedule moment-check after completion
      if (!has("moment-check")) enqueueJob(db, "moment-check", {}, { runAt: Date.now() + 15 * 60000, dedupeKey: "recur:moment-check" });
    } catch (e) { logActivity(db, "job", "scheduler-error", { error: String(e.message).slice(0, 200) }); }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

// Continuity loop: retrieve goals + open loops -> candidate moment -> score -> queue or skip.
async function momentCheck(db) {
  const auto = getSetting(db, "autonomy", {});
  const today = new Date().toDateString();
  const count = db.prepare("SELECT COUNT(*) AS n FROM moments WHERE created_at > ?").get(new Date(today).getTime()).n;
  if (count >= (auto.max_moments_per_day || 3)) return { skipped: "daily limit" };
  const projs = db.prepare("SELECT content FROM memories WHERE type='project' AND status='active' ORDER BY updated_at DESC LIMIT 5").all();
  const open = db.prepare("SELECT content FROM memories WHERE type='question' AND status='active' ORDER BY importance DESC LIMIT 5").all();
  const recent = db.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT 6").all().reverse();
  const petGoals = db.prepare("SELECT content FROM memories WHERE type='petgoal' AND status='active' LIMIT 3").all().map(r => r.content);
  const petMood = db.prepare("SELECT content FROM memories WHERE type='pet' AND key='pet:mood' AND status='active'").get();
  if (!projs.length && !open.length && !petGoals.length) return { skipped: "nothing to say" };
  const prompt = `Propose ONE proactive moment or "none". Context:\nProjects: ${projs.map(p => p.content).join(" | ").slice(0, 800)}\nOpen: ${open.map(o => o.content).join(" | ").slice(0, 800)}\nPet goals: ${petGoals.join(" | ").slice(0, 400)}\nPet mood: ${petMood ? petMood.content.slice(0, 200) : "unknown"}\nRecent: ${recent.map(m => m.role + ": " + m.content).join(" / ").slice(0, 1200)}\nReply JSON: {"moment":"text or empty","reason":"why now","score":0-10}. Only score >=7 matters. No generic quotes. Pet-flavored moments welcome when the pet has a goal.`;
  let cand = { moment: "", score: 0, reason: "" };
  try {
    const out = await chat(db, [{ role: "user", content: prompt }], { max_tokens: 300, json: true, temperature: 0.4 });
    cand = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch { return { skipped: "model error" }; }
  if (!cand.moment || (cand.score || 0) < 7) return { skipped: "low score", score: cand.score || 0 };
  const id = queueMoment(db, cand.moment.slice(0, 400), cand.reason || "", 2);
  logActivity(db, "brain", "moment-queued", { id });
  return { queued: id, score: cand.score };
}

async function buildDigest(db, range) {
  const since = Date.now() - (range === "week" ? 7 : 1) * 864e5;
  const turns = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?").get(since).n;
  const mems = db.prepare("SELECT type, content FROM memories WHERE created_at >= ? AND status='active'").all(since);
  const acts = db.prepare("SELECT action, detail FROM activity WHERE created_at >= ? ORDER BY id DESC LIMIT 20").all(since);
  const prompt = `Write a concise ${range}ly review from: ${turns} messages, new memories: ${mems.map(m => "[" + m.type + "] " + m.content).join("; ").slice(0, 1500)}, activity: ${acts.map(a => a.action).join(", ")}. Sections: Wins, Open loops, Suggested next step (one). Under 150 words. Only real items, never invent.`;
  const text = await chat(db, [{ role: "user", content: prompt }], { max_tokens: 500 });
  queueMoment(db, text.slice(0, 600), `${range}ly digest`, 2);
  return { turns, newMemories: mems.length };
}

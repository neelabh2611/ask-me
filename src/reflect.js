// Reflection + learning loop: extract -> compare -> validated traceable updates.
import { extractMemories } from "./sarvam.js";
import { addMemory, correctMemory, getMemory } from "./memory.js";
import { logActivity } from "./db.js";

export async function runReflection(db, convId) {
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(convId);
  if (!conv) throw new Error("no conversation: " + convId);
  const since = conv.reflected_through || 0;
  const turns = db.prepare("SELECT id, role, content FROM messages WHERE conv_id=? AND id>? AND role IN ('user','assistant') ORDER BY id").all(convId, since);
  if (turns.length < 2) return { applied: [], note: "too few turns" };
  const { memories, unresolved } = await extractMemories(db, turns);
  const applied = [];
  for (const m of memories.slice(0, 6)) {
    try {
      const res = m.key
        ? correctMemory(db, { type: m.type, key: m.key, content: m.content, source: "reflection" })
        : addMemory(db, { ...m, source: "reflection" });
      applied.push({ ...res, type: m.type, key: m.key || null });
      logActivity(db, "brain", "memory-applied", { conv: convId, ...res, type: m.type });
    } catch (e) { logActivity(db, "brain", "memory-rejected", { conv: convId, error: String(e.message).slice(0, 150) }); }
  }
  for (const q of unresolved.slice(0, 4)) {
    try {
      const res = addMemory(db, { type: "question", content: String(q).slice(0, 300), source: "reflection", importance: 0.4 });
      applied.push({ ...res, type: "question" });
    } catch { /* dupe, skip */ }
  }
  const maxId = turns[turns.length - 1].id;
  db.prepare("UPDATE conversations SET reflected_through=? WHERE id=?").run(maxId, convId);
  return { applied, turns: turns.length };
}

// Consolidation: nightly-ish. Dedupe stats, decay, project rollups, digest seed.
export async function runConsolidation(db) {
  const { forgetExpired } = await import("./memory.js");
  const f = forgetExpired(db);
  const open = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE type='question' AND status='active'").get().n;
  const projs = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE type='project' AND status='active'").get().n;
  logActivity(db, "job", "consolidate", { ...f, openQuestions: open, activeProjects: projs });
  return { ...f, openQuestions: open, activeProjects: projs };
}

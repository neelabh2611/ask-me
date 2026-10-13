// Memory manager: 6 layers over one table. Types:
// fact (semantic) | preference (user-pref, key pref:*) | project (goal, key proj:*)
// procedure (procedural) | episode (episodic) | question (open loop) | correction (audit trail)
const TYPES = ["fact", "preference", "project", "procedure", "episode", "question", "correction", "pet", "petgoal", "petepisode"];
const now = () => Date.now();

export function addMemory(db, m) {
  if (!TYPES.includes(m.type)) throw new Error("bad memory type: " + m.type);
  if (!m.content?.trim()) throw new Error("empty memory content");
  // Exact-key dedupe: same type+key+content -> touch, no duplicate.
  if (m.key) {
    const dup = db.prepare("SELECT id FROM memories WHERE type=? AND key=? AND content=? AND status='active'").get(m.type, m.key, m.content.trim());
    if (dup) return { id: dup.id, deduped: true };
  }
  // Near-duplicate: same type, high FTS overlap -> keep higher importance, link.
  const near = findNearDuplicate(db, m.type, m.content);
  if (near && !m.key) return { id: near.id, deduped: true, near: true };
  const r = db.prepare(`INSERT INTO memories
    (type,key,content,entities,source,confidence,importance,status,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.type, m.key || null, m.content.trim(), JSON.stringify(m.entities || []),
    m.source || "user", m.confidence ?? 1.0, m.importance ?? 0.5, "active",
    m.expires_at || null, now(), now());
  return { id: Number(r.lastInsertRowid), deduped: false };
}

function findNearDuplicate(db, type, content) {
  const words = content.toLowerCase().split(/[^a-z0-9\u0900-\u097F]+/).filter(w => w.length > 3).slice(0, 8);
  if (words.length < 3) return null;
  try {
    const q = words.map(w => `"${w.replace(/"/g, "")}"`).join(" OR ");
    const rows = db.prepare(`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? LIMIT 5`).all(q);
    for (const r of rows) {
      const m = db.prepare("SELECT * FROM memories WHERE id=? AND type=? AND status='active'").get(r.id, type);
      if (m && overlap(m.content, content) > 0.5) return m;
    }
  } catch { /* FTS syntax fallback below */ }
  return null;
}
function overlap(a, b) {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(Boolean)), B = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  let hit = 0; for (const w of B) if (A.has(w)) hit++;
  return hit / Math.max(1, B.size);
}

// Correction wins: new explicit value supersedes old, history preserved.
export function correctMemory(db, { type, key, content, source = "user" }) {
  const olds = key
    ? db.prepare("SELECT * FROM memories WHERE type=? AND key=? AND status='active'").all(type, key)
    : [];
  const { id } = addMemory(db, { type, key, content, source, confidence: 1.0, importance: 0.8 });
  for (const o of olds) {
    if (o.id === id) continue;
    db.prepare("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(id, now(), o.id);
    addMemory(db, { type: "correction", content: `Superseded ${type}${key ? " " + key : ""} #${o.id}: "${o.content}" -> #${id}`, source, confidence: 1.0, importance: 0.3 });
  }
  return { id, superseded: olds.map(o => o.id).filter(x => x !== id) };
}

export function searchMemories(db, query, { types = null, limit = 8 } = {}) {
  const typeFilter = types?.length ? `AND type IN (${types.map(() => "?").join(",")})` : "";
  const baseParams = types?.length ? [...types] : [];
  let rows = [];
  try {
    const terms = query.split(/\s+/).filter(w => w.length > 2).map(w => `"${w.replace(/"/g, "").slice(0, 20)}"*`);
    const q = terms.join(" OR ") || '""';
    rows = db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ? AND m.status='active' ${typeFilter} LIMIT ?`).all(q, ...baseParams, limit * 2);
  } catch { /* fall through to LIKE */ }
  if (!rows.length) {
    const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 6);
    if (words.length) {
      const cond = words.map(() => "content LIKE ?").join(" OR ");
      rows = db.prepare(`SELECT * FROM memories WHERE status='active' AND (${cond}) ${typeFilter} LIMIT ?`).all(...words.map(w => `%${w.slice(0, 40)}%`), ...baseParams, limit * 2);
    }
  }
  // Key-slot match: "style" finds pref:style even with zero content overlap.
  {
    const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 6);
    if (words.length) {
      const cond = words.map(() => "key LIKE ?").join(" OR ");
      const km = db.prepare(`SELECT * FROM memories WHERE status='active' AND key IS NOT NULL AND (${cond}) ${typeFilter} LIMIT ?`).all(...words.map(w => `%${w.slice(0, 30)}%`), ...baseParams, limit);
      const ids = new Set(rows.map(r => r.id));
      for (const m of km) if (!ids.has(m.id)) rows.push(m);
    }
  }
  return rank(rows, query).slice(0, limit);
}
function rank(rows, query) {
  const qw = new Set(query.toLowerCase().split(/\W+/));
  return rows.map(m => {
    let s = m.importance * 2 + m.confidence;
    const cw = m.content.toLowerCase().split(/\W+/);
    let hit = 0; for (const w of cw) if (qw.has(w)) hit++;
    s += hit * 0.3;
    const ageDays = (now() - m.updated_at) / 864e5;
    s -= Math.min(1, ageDays / 30) * 0.5; // gentle recency decay
    return { ...m, score: +s.toFixed(3) };
  }).sort((a, b) => b.score - a.score);
}

export function getMemory(db, id) { return db.prepare("SELECT * FROM memories WHERE id=?").get(id); }
export function updateMemory(db, id, { content, importance, confidence }) {
  const m = getMemory(db, id);
  if (!m || m.status === "deleted") throw new Error("memory not found: " + id);
  db.prepare("UPDATE memories SET content=COALESCE(?,content), importance=COALESCE(?,importance), confidence=COALESCE(?,confidence), updated_at=? WHERE id=?")
    .run(content ?? null, importance ?? null, confidence ?? null, now(), id);
  return getMemory(db, id);
}
export function deleteMemory(db, id) {
  db.prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=?").run(now(), id);
}
export function forgetExpired(db) {
  const r = db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?").run(now());
  // decay: drop low-importance inferred memories older than 90 days untouched
  const r2 = db.prepare("DELETE FROM memories WHERE source='inferred' AND importance < 0.25 AND updated_at < ?").run(now() - 90 * 864e5);
  return { expired: r.changes, decayed: r2.changes };
}
export function exportMemories(db) {
  return db.prepare("SELECT * FROM memories WHERE status != 'deleted' ORDER BY updated_at DESC").all();
}
export { TYPES };

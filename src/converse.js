// Conversation manager: one turn = retrieve -> build context -> chat -> store -> maybe reflect.
import { buildContext } from "./context.js";
import { chat } from "./sarvam.js";
import { getSetting, logActivity } from "./db.js";
import { enqueueJob } from "./jobs.js";

export function getOrCreateConv(db, id = null) {
  if (id) {
    const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    if (c) return c;
  }
  const t = Date.now();
  const r = db.prepare("INSERT INTO conversations (title, created_at, updated_at) VALUES ('Chat', ?, ?)").run(t, t);
  return db.prepare("SELECT * FROM conversations WHERE id=?").get(Number(r.lastInsertRowid));
}
export function history(db, convId, limit = 12) {
  return db.prepare("SELECT role, content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?").all(convId, limit).reverse();
}
function saveMsg(db, convId, role, content, usedIds = []) {
  const r = db.prepare("INSERT INTO messages (conv_id, role, content, used_memory_ids, created_at) VALUES (?,?,?,?,?)")
    .run(convId, role, content, JSON.stringify(usedIds), Date.now());
  db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(Date.now(), convId);
  return Number(r.lastInsertRowid);
}

export async function handleTurn(db, { convId = null, text }) {
  if (!text?.trim()) throw new Error("empty message");
  if (text.length > 4000) throw new Error("message too long (4000 max)");
  const conv = getOrCreateConv(db, convId);
  saveMsg(db, conv.id, "user", text.trim());
  const hist = history(db, conv.id);
  const ctx = buildContext(db, { query: text, history: hist });
  const reply = await chat(db, [
    { role: "system", content: ctx.system },
    ...ctx.history.map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.content }))
  ]);
  saveMsg(db, conv.id, "assistant", reply, ctx.usedIds);
  logActivity(db, "brain", "turn", { conv: conv.id, usedMemories: ctx.usedIds });
  // Reflection trigger: every N user turns since last reflection.
  const auto = getSetting(db, "autonomy", {});
  const since = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id=? AND id>? AND role='user'").get(conv.id, conv.reflected_through || 0);
  if ((auto.reflect_every_turns || 6) <= since.n) {
    enqueueJob(db, "reflect", { convId: conv.id }, { dedupeKey: `reflect:${conv.id}` });
  }
  return { convId: conv.id, reply, usedMemories: ctx.usedIds };
}

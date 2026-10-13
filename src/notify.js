// Moments + notifications: queue, quiet hours, limits, SSE fan-out.
import { getSetting, logActivity } from "./db.js";

const clients = new Set();
export function sseSubscribe(res) {
  clients.add(res);
  res.on?.("close", () => clients.delete(res));
}
export function pushEvent(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data).slice(0, 2000)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}

export function queueMoment(db, content, reason = "", priority = 1) {
  const r = db.prepare("INSERT INTO moments (content, reason, priority, status, deliver_after, created_at) VALUES (?,?,?,?,?,?)")
    .run(content.slice(0, 600), reason.slice(0, 300), priority, "queued", Date.now(), Date.now());
  const id = Number(r.lastInsertRowid);
  logActivity(db, "brain", "moment-created", { id, priority });
  if (deliverable(db)) deliver(db, id);
  return id;
}
export function inQuietHours(db) {
  const a = getSetting(db, "autonomy", {});
  const h = new Date().getHours();
  const { quiet_start = 23, quiet_end = 7 } = a;
  return quiet_start <= quiet_end ? (h >= quiet_start && h < quiet_end) : (h >= quiet_start || h < quiet_end);
}
export function deliverable(db) {
  const a = getSetting(db, "autonomy", {});
  return a.enabled !== false && !inQuietHours(db);
}
export function deliver(db, id) {
  const m = db.prepare("SELECT * FROM moments WHERE id=?").get(id);
  if (!m || m.status !== "queued") return false;
  db.prepare("UPDATE moments SET status='delivered' WHERE id=?").run(id);
  pushEvent("moment", { id, content: m.content, priority: m.priority });
  logActivity(db, "brain", "moment-delivered", { id });
  return true;
}
export function pendingMoments(db) {
  const list = db.prepare("SELECT * FROM moments WHERE status='queued' ORDER BY priority DESC, id LIMIT 10").all();
  if (deliverable(db)) for (const m of list) deliver(db, m.id);
  return db.prepare("SELECT * FROM moments WHERE status IN ('queued','delivered') ORDER BY id DESC LIMIT 10").all();
}
export function setMoment(db, id, status) {
  if (!["dismissed", "postponed", "expired"].includes(status)) throw new Error("bad moment status");
  const delay = status === "postponed" ? 3 * 3600e3 : 0;
  db.prepare("UPDATE moments SET status=?, deliver_after=? WHERE id=?").run(status, Date.now() + delay, id);
  logActivity(db, "user", "moment-" + status, { id });
}

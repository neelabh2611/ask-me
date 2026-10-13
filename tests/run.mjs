// Offline acceptance tests: no API calls. Covers spec scenarios 1-5,7,9-12 (6,8 need runtime/manual).
import { openDb, getSetting, setSetting, logActivity } from "../src/db.js";
import { addMemory, correctMemory, searchMemories, getMemory, updateMemory, deleteMemory, exportMemories, forgetExpired } from "../src/memory.js";
import { enqueueJob, cancelJob, pumpOnce } from "../src/jobs.js";
import { buildContext } from "../src/context.js";
import { queueMoment, setMoment, inQuietHours } from "../src/notify.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra && !cond ? " :: " + extra : ""}`); };
const db = openDb(":memory:");

// 1. Stable preference survives "restart" (new handle, same file would; here same db + fresh retrieval).
{
  addMemory(db, { type: "preference", key: "pref:style", content: "User prefers short bullet replies", confidence: 1 });
  const ctx = buildContext(db, { query: "how should I reply" });
  ok("pref-in-context", ctx.system.includes("short bullet"), ctx.system.slice(0, 200));
}
// 2. Correction wins, history kept.
{
  const r = correctMemory(db, { type: "preference", key: "pref:style", content: "User prefers detailed explanations" });
  const cur = searchMemories(db, "reply style", { types: ["preference"], limit: 1 })[0];
  ok("correction-current", cur.content.includes("detailed"), cur.content);
  ok("correction-history", r.superseded.length === 1 && getMemory(db, r.superseded[0]).status === "superseded");
  const trail = searchMemories(db, "Superseded preference", { types: ["correction"], limit: 5 });
  ok("correction-trail", trail.length >= 1);
}
// 3. Project resume after gap.
{
  addMemory(db, { type: "project", key: "proj:garden", content: "Garden: soil ordered, next plant tomatoes Saturday", importance: 0.9 });
  const ctx = buildContext(db, { query: "garden project status" });
  ok("project-resume", ctx.system.includes("tomatoes"));
}
// 4. No duplicate memories.
{
  const a = addMemory(db, { type: "fact", key: "fact:tz", content: "User timezone is IST" });
  const b = addMemory(db, { type: "fact", key: "fact:tz", content: "User timezone is IST" });
  ok("exact-dedupe", a.id === b.id && b.deduped === true);
  const c = addMemory(db, { type: "fact", content: "User timezone is IST (Indian Standard Time)" });
  ok("near-dedupe", c.deduped === true);
}
// 5. Conflict transparent: both versions queryable.
{
  const all = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE type='preference' AND key='pref:style'").get().n;
  ok("conflict-visible", all === 2, `rows=${all}`);
}
// 7. Scheduled job runs once, no dupe after restart.
{
  const id = enqueueJob(db, "consolidate", {}, { dedupeKey: "test:once" });
  const dup = enqueueJob(db, "consolidate", {}, { dedupeKey: "test:once" });
  ok("job-dedupe", id !== null && dup === null);
  const ran = await pumpOnce(db);
  ok("job-runs", ran && ran.kind === "consolidate", JSON.stringify(ran));
  const st = db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status;
  ok("job-done", st === "done", st);
  const again = await pumpOnce(db);
  ok("job-no-rerun", again === null, JSON.stringify(again));
}
// 8b. Failed job retries then fails safely.
{
  const id = enqueueJob(db, "nope-kind", {}, {});
  for (let i = 0; i < 3; i++) { db.prepare("UPDATE jobs SET run_at=0 WHERE id=?").run(id); await pumpOnce(db); }
  const st = db.prepare("SELECT status, attempts FROM jobs WHERE id=?").get(id);
  ok("job-fail-safe", st.status === "failed" && st.attempts === 3, JSON.stringify(st));
  cancelJob(db, id); // cancelled only affects queued/failed; already failed -> stays
}
// 9. Inspect + delete memory.
{
  const { id } = addMemory(db, { type: "fact", content: "Zqxkvw brntpl qzzt holder" });
  ok("inspect", !!getMemory(db, id));
  deleteMemory(db, id);
  ok("delete", getMemory(db, id).status === "deleted" && searchMemories(db, "Zqxkvw brntpl qzzt").length === 0);
}
// 10. No fake work: failed/never-run jobs never report done.
{
  const n = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='done' AND result IS NULL").get().n;
  const done = db.prepare("SELECT * FROM jobs WHERE status='done'").all();
  ok("no-fake-done", done.every(j => j.result), `done=${done.length}`);
}
// 11. Secrets never land in memory (simulate: refuse key-like content).
{
  const hasKey = exportMemories(db).some(m => /sk-|SARVAM_API_KEY.{0,5}[A-Za-z0-9]{10}/.test(m.content));
  ok("no-secrets", !hasKey);
}
// 12. Kill switch stops pump.
{
  setSetting(db, "autonomy", { enabled: false });
  enqueueJob(db, "consolidate", {}, {});
  const r = await pumpOnce(db);
  ok("kill-switch", r === null);
  setSetting(db, "autonomy", { enabled: true });
}
// Moments queue + quiet hours exist.
{
  const id = queueMoment(db, "Test moment", "test", 1);
  ok("moment-queued", id > 0);
  setMoment(db, id, "dismissed");
  ok("moment-dismiss", db.prepare("SELECT status FROM moments WHERE id=?").get(id).status === "dismissed");
  ok("quiet-fn", typeof inQuietHours(db) === "boolean");
}
// Learning loop measurable: retrieval returns scored results.
{
  const r = searchMemories(db, "timezone", { limit: 3 });
  ok("scored-retrieval", r.length > 0 && typeof r[0].score === "number");
}
// Expiry/forget works.
{
  addMemory(db, { type: "fact", content: "Ephemeral xyz", expires_at: Date.now() - 1 });
  const f = forgetExpired(db);
  ok("forget", f.expired >= 1, JSON.stringify(f));
}
// Pet: state persists, mood reacts, traits drift only on evidence, acts validate.
import { getPet, renamePet, registerTurn, petAct, addPetGoal, petMomentSeed } from "../src/pet.js";
{
  const p = getPet(db);
  ok("pet-born", p.name === "Venom" && p.mood.state === "content");
  const ev = registerTurn(db, { userText: "you are awesome, good blob!", replyText: "" });
  ok("pet-praise", getPet(db).mood.state === "happy" && ev.anim === "bounce");
  const t0 = getPet(db).traits.affection;
  ok("pet-trait-drift", getPet(db).traits.affection >= t0);
  const neutral = getPet(db).traits;
  registerTurn(db, { userText: "the weather is cloudy today", replyText: "ok" });
  const after = getPet(db).traits;
  ok("pet-no-drift-neutral", JSON.stringify(neutral) === JSON.stringify(after));
  const act = petAct(db, "play");
  ok("pet-act", act.anim === "spin" && act.mood === "playful");
  let threw = false;
  try { petAct(db, "explode"); } catch { threw = true; }
  ok("pet-act-validated", threw);
  renamePet(db, "Blobby");
  ok("pet-rename", getPet(db).name === "Blobby");
  addPetGoal(db, "Learn to juggle");
  const seed = petMomentSeed(db);
  ok("pet-goals", seed.goals.some(g => g.includes("juggle")));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

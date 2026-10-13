// Context builder: working memory + retrieved long-term memory -> chat preamble.
import { searchMemories } from "./memory.js";
import { getSetting } from "./db.js";

const CHAR_BUDGET = 6000; // keeps API calls small, working memory first

export function buildContext(db, { query = "", history = [] } = {}) {
  const personality = getSetting(db, "personality", { name: "Steady", tone: "warm, direct, brief", detail: "medium" });
  // Retrieve per layer, then merge by score.
  // Preferences + projects are few and almost always relevant: load top ones outright.
  // Facts/episodes/questions stay query-scoped.
  const always = db.prepare("SELECT * FROM memories WHERE status='active' AND type IN ('preference','project') ORDER BY importance DESC, updated_at DESC LIMIT 6").all();
  const layers = [
    always,
    searchMemories(db, query || "facts procedures", { types: ["fact", "procedure"], limit: 4 }),
    searchMemories(db, query || "open questions unresolved", { types: ["question", "episode"], limit: 3 })
  ];
  const seen = new Set(), mems = [];
  for (const l of layers) for (const m of l) {
    if (seen.has(m.id)) continue;
    seen.add(m.id); mems.push(m);
  }
  mems.sort((a, b) => b.score - a.score);
  let used = [], chars = 0;
  for (const m of mems.slice(0, 10)) {
    const line = `[${m.type}${m.key ? ":" + m.key : ""}] ${m.content}`;
    if (chars + line.length > CHAR_BUDGET) break;
    chars += line.length; used.push(m);
  }
  const sys = `You are ${personality.name}, a persistent companion. Tone: ${personality.tone}. Detail: ${personality.detail}.
What you remember (facts > guesses; [question] = unresolved, do not present as fact):
${used.map(m => "- " + `[${m.type}] ${m.content}`).join("\n") || "- (no memories yet)"}
Rules: use memories naturally, never recite architecture; admit uncertainty; ask when blocked; one next step at a time; never claim work you did not do.`;
  return { system: sys, usedIds: used.map(m => m.id), history: history.slice(-12) };
}

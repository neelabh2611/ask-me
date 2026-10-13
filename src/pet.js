// Pet mind: mood, traits, goals persist in memories (pet:* keys).
// Evolution is evidence-driven: traits drift only on real signals, changes logged.
import { getMemory, addMemory, correctMemory, searchMemories } from "./memory.js";
import { logActivity } from "./db.js";
import { chat } from "./sarvam.js";

const DEFAULTS = {
  name: "Venom",
  mood: { state: "content", energy: 0.8, updated: 0 },
  traits: { playfulness: 0.6, curiosity: 0.6, affection: 0.5, sass: 0.4 },
  likes: [], dislikes: []
};
const now = () => Date.now();

function get(db, key) {
  const m = db.prepare("SELECT * FROM memories WHERE type='pet' AND key=? AND status='active'").get(key);
  return m ? JSON.parse(m.content) : null;
}
function set(db, key, val, importance = 0.7) {
  const cur = db.prepare("SELECT id FROM memories WHERE type='pet' AND key=? AND status='active'").get(key);
  if (cur) db.prepare("UPDATE memories SET content=?, updated_at=? WHERE id=?").run(JSON.stringify(val), now(), cur.id);
  else addMemory(db, { type: "pet", key, content: JSON.stringify(val), source: "system", confidence: 1, importance });
}
export function getPet(db) {
  let mood = get(db, "pet:mood"), traits = get(db, "pet:traits"), likes = get(db, "pet:likes");
  if (!mood) { mood = { ...DEFAULTS.mood, updated: now() }; set(db, "pet:mood", mood); }
  if (!traits) { traits = { ...DEFAULTS.traits }; set(db, "pet:traits", traits); }
  if (!likes) { likes = { likes: [], dislikes: [] }; set(db, "pet:likes", likes); }
  // Time drift: energy regens, mood settles toward content.
  const hrs = (now() - (mood.updated || now())) / 36e5;
  if (hrs > 0.5) {
    mood.energy = Math.min(1, mood.energy + hrs * 0.05);
    if (mood.state !== "content" && hrs > 6) mood.state = "content";
    mood.updated = now();
    set(db, "pet:mood", mood);
  }
  const goals = db.prepare("SELECT id, content FROM memories WHERE type='petgoal' AND status='active' ORDER BY id").all();
  return { name: getName(db), mood, traits, likes, goals };
}
function getName(db) {
  const n = get(db, "pet:name");
  if (!n) {
    set(db, "pet:name", { name: DEFAULTS.name });
    logActivity(db, "brain", "pet-born", { name: DEFAULTS.name });
    return DEFAULTS.name;
  }
  return n.name || DEFAULTS.name;
}
export function renamePet(db, name) {
  const clean = String(name || "").slice(0, 24).trim() || DEFAULTS.name;
  set(db, "pet:name", { name: clean });
  logActivity(db, "user", "pet-rename", { name: clean });
  return clean;
}

// Turn hook: mood + trait updates from real conversation signals. Returns UI reaction.
export function registerTurn(db, { userText = "", replyText = "" }) {
  const pet = getPet(db);
  const t = (userText + " " + replyText).toLowerCase();
  const ev = { anim: "idle", delta: [] };
  const nudge = (trait, d, why) => {
    const old = pet.traits[trait];
    pet.traits[trait] = Math.max(0, Math.min(1, +(old + d).toFixed(3)));
    if (Math.floor(old * 10) !== Math.floor(pet.traits[trait] * 10)) {
      logActivity(db, "brain", "pet-trait", { trait, from: old, to: pet.traits[trait], why });
      ev.delta.push(`${trait}→${pet.traits[trait]}`);
    }
  };
  const setMood = (s) => { if (pet.mood.state !== s) { pet.mood.state = s; ev.anim = s; } };
  if (/(good|love|awesome|cute|brilliant|thank|well done|nice)/.test(t)) {
    setMood("happy"); pet.mood.energy = Math.min(1, pet.mood.energy + 0.1); ev.anim = "bounce";
    nudge("affection", 0.02, "praise");
  } else if (/(bad|stupid|shut up|hate|useless|dumb)/.test(t)) {
    setMood("droop"); pet.mood.energy = Math.max(0, pet.mood.energy - 0.15); ev.anim = "droop";
    nudge("sass", 0.02, "scolded");
  } else if (/(play|game|fun|chase|fetch)/.test(t)) {
    setMood("playful"); pet.mood.energy = Math.min(1, pet.mood.energy + 0.05); ev.anim = "spin";
    nudge("playfulness", 0.02, "play talk");
  } else if (/\?$/.test(userText.trim())) {
    nudge("curiosity", 0.01, "question asked");
    ev.anim = "tilt";
  }
  pet.mood.updated = now();
  set(db, "pet:mood", pet.mood);
  set(db, "pet:traits", pet.traits);
  return ev;
}

// Physical interactions. Returns {anim, mood} for the stage.
export function petAct(db, action) {
  const pet = getPet(db);
  const okActs = ["feed", "play", "pet", "scold"];
  if (!okActs.includes(action)) throw new Error("bad pet action");
  const anims = { feed: "munch", play: "spin", pet: "bounce", scold: "droop" };
  const moods = { feed: "content", play: "playful", pet: "happy", scold: "droop" };
  pet.mood.state = moods[action];
  pet.mood.energy = Math.max(0, Math.min(1, pet.mood.energy + (action === "play" ? -0.1 : action === "feed" ? 0.15 : 0.05)));
  pet.mood.updated = now();
  set(db, "pet:mood", pet.mood);
  addMemory(db, { type: "petepisode", content: `User ${action}ed ${pet.name}; mood now ${moods[action]}`, source: "user", confidence: 1, importance: 0.3 });
  logActivity(db, "user", "pet-act", { action });
  return { anim: anims[action], mood: pet.mood.state, energy: +pet.mood.energy.toFixed(2) };
}

// Pet voice: short reply in its personality. Uses memory context lightly.
export async function petSay(db, text) {
  const pet = getPet(db);
  const prefs = searchMemories(db, text, { types: ["preference"], limit: 2 }).map(m => m.content).join("; ").slice(0, 300);
  const sys = `You are ${pet.name}, a blob pet. Traits: playful ${pet.traits.playfulness}, sassy ${pet.traits.sass}, affectionate ${pet.traits.affection}. Mood: ${pet.mood.state}. Reply in 1-2 short sentences, pet voice, a little venomous cheek. User facts: ${prefs || "none yet"}. Never claim actions you did not take.`;
  const out = await chat(db, [{ role: "system", content: sys }, { role: "user", content: String(text).slice(0, 1000) }], { max_tokens: 200 });
  registerTurn(db, { userText: text, replyText: out });
  return { text: out, mood: pet.mood.state };
}

// Seed lines for the moment-check loop: pet goals + recent episodes.
export function petMomentSeed(db) {
  const goals = db.prepare("SELECT content FROM memories WHERE type='petgoal' AND status='active' LIMIT 3").all().map(r => r.content);
  const eps = db.prepare("SELECT content FROM memories WHERE type='petepisode' AND status='active' ORDER BY id DESC LIMIT 3").all().map(r => r.content);
  return { goals, episodes: eps };
}
export function addPetGoal(db, content) {
  const { id } = addMemory(db, { type: "petgoal", content: String(content).slice(0, 300), source: "user", importance: 0.7 });
  logActivity(db, "user", "pet-goal", { id });
  return id;
}

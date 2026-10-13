// Live API test: real Sarvam roundtrip. Run: node --env-file=.env tests/live.mjs
import { openDb } from "../src/db.js";
import { chat } from "../src/sarvam.js";
import { handleTurn } from "../src/converse.js";

const db = openDb(":memory:");
const r = await chat(db, [{ role: "user", content: "Say hi in one sentence." }], { max_tokens: 60 });
console.log("chat:", JSON.stringify(r.slice(0, 120)));
if (!r.trim()) throw new Error("empty reply");
const t = await handleTurn(db, { convId: null, text: "Remember this: my favorite break snack is roasted peanuts." });
console.log("turn:", JSON.stringify(t.reply.slice(0, 150)));
console.log("LIVE OK");

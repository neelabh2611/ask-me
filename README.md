# Steady Brain — persistent, self-improving AI. Sarvam engine. SQLite memory.

Single process: chat UI + memory + background jobs + proactive moments. Zero npm deps (Node 22+ built-ins only).

## Pet: Venom the blob (1.3MB GLB, Three.js GLTFLoader, clips auto-detected + procedural idle fallback)

Chat-side 3D companion with its own evolving mind (`src/pet.js`): mood/energy/traits persist as
`pet:*` memories, goals as `petgoal`, interactions as `petepisode`. Traits drift ±0.02 only on
real signals (praise/play/questions), bucket-crossings logged. Chat turns auto-trigger reactions
(bounce/spin/droop/tilt); feed/play/pet/scold via `POST /api/pet/act`; Venom answers + speaks via
`POST /api/pet/say` (Sarvam chat + `simran` TTS). Moment-check includes pet goals/mood. Kill switch
pauses pet too. Three.js via pinned CDN importmap (needs internet; page works without it minus 3D).

## Architecture

```
browser UI (public/) --REST/SSE--> server.js --+--> converse.js -> context.js -> sarvam.js (chat/extract/TTS/STT)
                                                +--> memory.js <-> db.js (SQLite + FTS5)
                                                +--> reflect.js (learning loop, Sarvam extraction)
                                                +--> jobs.js (queue + scheduler + moment-check)
                                                +--> notify.js (moments, quiet hours, SSE)
                                                +--> tools.js (memory_search auto, web_fetch auto/deny)
```

Memory layers = `memories.type`: `fact` semantic, `preference` user prefs (`pref:*` keys),
`project` goals (`proj:*`), `procedure` lessons, `episode` events, `question` open loops,
`correction` audit trail. Every row: type, timestamp, source, confidence, importance, status, expiry.

Learning loop: every N turns a `reflect` job runs Sarvam extraction -> dedupe -> `correctMemory`
(new wins, old kept as `superseded` + `correction` record) -> unresolved saved as `question`.

Background: `jobs` table (queued/running/done/failed/cancelled, retries, dedupe_key, resume-safe
claim). Scheduler ticks every 15s. Moment-check scores candidate moments, queues only score>=7,
respects quiet hours + daily cap. Kill switch: autonomy.enabled=false.

## Setup

1. `cp .env.example .env`, paste `SARVAM_API_KEY`.
2. `node --version` needs 22+.
3. `npm start` -> http://localhost:3000 (DB file `brain.db` created).

## Files

New: `package.json`, `src/db.js`, `src/memory.js`, `src/sarvam.js`, `src/context.js`,
`src/converse.js`, `src/reflect.js`, `src/jobs.js`, `src/notify.js`, `src/tools.js`,
`src/server.js`, `public/index.html|app.js|style.css`, `tests/run.mjs`, `tests/live.mjs`.
Kept: `.env`, `.env.example`, `test-sarvam.mjs`. Removed: old habit-tracker UI + proxies.

## Tests

- `npm test` — 20 offline checks (memory, dedupe, correction, jobs, kill switch, secrets).
- `npm run live` — real Sarvam chat + memory turn.
- Manual guide: 1) tell it a preference, restart server, ask later. 2) correct a fact, check Memories tab shows superseded trail. 3) save project, restart, ask to resume. 4) Jobs tab: enqueue research, watch run once. 5) pause autonomy, confirm pump does nothing. 6) mic button speaks + hears reply. 7) wait for or force moment-check, dismiss moment.

## Background persistence

Server process must stay alive. Options: `pm2 start src/server.js`, Windows Task Scheduler on
logon, or VPS (Fly/Render/Railway) with `npm start` + persistent disk for `brain.db`.
Note: host sleep kills the loop; queued jobs resume on restart (claim is resume-safe), moments
stay queued until delivered. No endless loops: every job has max attempts + budget cap.

## API usage estimate

Per chat turn ~1-3K tokens. Reflection ~1K per 6 turns. Moment-check ~1K per 15 min while
running. Default monthly cap 500K tokens (settings). TTS/STT unmetered here, dashboard-metered.

## Implemented / tested / pending

Implemented+tested: 6-layer memory, dedupe, correction-wins, FTS retrieval + scoring, context
injection, reflection extraction, job queue + retries + idempotency, kill switch, moments queue +
quiet hours + SSE, voice STT/TTS, usage log, export/delete UI.
Tested live: chat roundtrip. Pending (needs your runtime): mic in real browser, overnight
scheduler soak, multi-day project resume, digest quality tuning.
Limits: no embeddings (FTS keyword retrieval), single user, no auth (localhost assumption —
add a password proxy before exposing), tools are read-only by design.

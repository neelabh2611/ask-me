// Steady brain UI: chat + voice + memories + projects + jobs + activity + settings.
const $ = id => document.getElementById(id);
const api = (m, url, b) => fetch(url, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
});
let convId = Number(localStorage.getItem("steady.conv") || 0) || null;
const esc = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $("tab-" + b.dataset.tab).classList.add("active");
  ({ mem: loadMems, proj: loadProjs, jobs: loadJobs, log: loadActs, set: loadSets }[b.dataset.tab] || (() => {}))();
});
function addMsg(t, me) { const d = document.createElement("div"); d.className = "msg" + (me ? " me" : ""); d.textContent = t; $("chat").appendChild(d); $("chat").scrollTop = 1e6; return d; }

$("form").onsubmit = async e => {
  e.preventDefault();
  const v = $("in").value.trim(); if (!v) return;
  $("in").value = ""; addMsg(v, true);
  const ph = addMsg("…");
  try {
    if ($("venomvoice")?.checked) {
      const r = await api("POST", "/api/pet/say", { text: v, voice: true });
      ph.textContent = r.text;
      petReact("bounce");
      if (r.audio) new Audio("data:audio/wav;base64," + r.audio).play().catch(() => {});
      refreshPet();
    } else {
      const r = await api("POST", "/api/chat", { convId, text: v });
      convId = r.convId; localStorage.setItem("steady.conv", convId);
      ph.textContent = r.reply;
      petReact(r.pet?.anim || "tilt");
      $("used").textContent = r.usedMemories.length ? `used ${r.usedMemories.length} memories` : "no memories used yet — teach me";
    }
  } catch (er) { ph.textContent = "Error: " + er.message; }
};
// SSE proactive moments
const es = new EventSource("/api/events");
es.addEventListener("moment", e => showMoment(JSON.parse(e.data)));
async function refreshMoments() {
  try {
    const { moments } = await api("GET", "/api/moments");
    moments.filter(m => m.status === "queued" || m.status === "delivered").slice(0, 3).forEach(showMoment);
  } catch { /* offline */ }
}
function showMoment(m) {
  if (document.querySelector(`[data-m="${m.id}"]`)) return;
  const d = document.createElement("div"); d.className = "moment"; d.dataset.m = m.id;
  d.innerHTML = `<b>Steady:</b> ${esc(m.content)}<div class="row"><button data-a="ok">Got it</button><button data-a="postponed">Later</button><button data-a="dismissed">Dismiss</button></div>`;
  d.querySelectorAll("button").forEach(b => b.onclick = async () => {
    await api("POST", `/api/moments/${m.id}`, { status: b.dataset.a === "ok" ? "dismissed" : b.dataset.a });
    d.remove();
  });
  $("moments").prepend(d);
}
// Voice: mic -> STT -> chat -> optional TTS
let rec = null, chunks = [];
$("mic").onclick = async () => {
  if (rec) { rec.stop(); return; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(s); chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      s.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType }); rec = null; $("mic").textContent = "🎙";
      const b64 = await new Promise(res => { const f = new FileReader(); f.onload = () => res(String(f.result).split(",")[1]); f.readAsDataURL(blob); });
      try {
        const { transcript } = await api("POST", "/api/listen", { audioBase64: b64, mime: blob.type });
        if (transcript) { $("in").value = transcript; $("form").requestSubmit(); }
      } catch (e) { addMsg("Voice failed: " + e.message); }
    };
    rec.start(); $("mic").textContent = "⏹";
  } catch { addMsg("Mic blocked by browser."); }
};
$("spk").onclick = async () => {
  const last = [...document.querySelectorAll("#chat .msg:not(.me)")].pop();
  if (!last) return;
  try {
    const { audio } = await api("POST", "/api/speak", { text: last.textContent });
    new Audio("data:audio/wav;base64," + audio).play().catch(() => {});
  } catch (e) { addMsg("Speech failed: " + e.message); }
};
$("reflect").onclick = async () => {
  if (!convId) return addMsg("Chat first, then reflect.");
  const r = await api("POST", `/api/reflect/${convId}`);
  addMsg(`Reflected: ${r.applied.length} memories applied over ${r.turns || "?"} turns.`);
  loadMems();
};
// Memories
async function loadMems() {
  const t = $("mt").value;
  const { memories } = await api("GET", `/api/memories?q=${encodeURIComponent($("mq").value)}${t ? "&type=" + t : ""}`);
  $("mems").innerHTML = memories.map(m => `<div class="mem"><span class="tag">${esc(m.type)}</span> <small>#${m.id} · conf ${m.confidence} · ${new Date(m.updated_at).toLocaleDateString()}</small><div>${esc(m.content)}</div><div class="row"><button onclick="delMem(${m.id})">Delete</button></div></div>`).join("") || "<p class=muted>No memories yet.</p>";
}
window.delMem = async id => { await api("DELETE", `/api/memories/${id}`); loadMems(); };
$("msearch").onclick = loadMems;
$("mexport").onclick = async () => {
  const { memories } = await api("GET", "/api/memories/export");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(memories, null, 2)], { type: "application/json" }));
  a.download = "memories.json"; a.click();
};
$("mform").onsubmit = async e => {
  e.preventDefault();
  await api("POST", "/api/memories", { type: $("mtype").value || "fact", key: $("mkey").value || undefined, content: $("mcontent").value });
  $("mcontent").value = ""; loadMems();
};
// Projects
async function loadProjs() {
  const { memories } = await api("GET", "/api/memories?type=project");
  $("projs").innerHTML = memories.map(m => `<div class="mem"><span class="tag">project</span> <small>${esc(m.key || "")}</small><div>${esc(m.content)}</div><div class="row"><button onclick="delMem(${m.id})">Delete</button></div></div>`).join("") || "<p class=muted>No projects yet.</p>";
}
$("pform").onsubmit = async e => {
  e.preventDefault();
  await api("POST", "/api/memories", { type: "project", key: $("pkey").value, content: $("pcontent").value, correct: true });
  $("pcontent").value = ""; loadProjs();
};
// Jobs + activity + settings
async function loadJobs() {
  const { jobs } = await api("GET", "/api/jobs");
  $("jobs").innerHTML = jobs.map(j => `<div class="job"><span class="tag">${esc(j.kind)}</span> <span class="tag">${esc(j.status)}</span> <small>try ${j.attempts}/${j.max_attempts} · ${new Date(j.updated_at).toLocaleString()}</small><div><small>${esc(j.last_error || j.result || "")}</small></div>${j.status === "queued" || j.status === "failed" ? `<button onclick="cancelJob(${j.id})">Cancel</button>` : ""}</div>`).join("");
}
window.cancelJob = async id => { await api("POST", `/api/jobs/${id}/cancel`); loadJobs(); };
$("jpump").onclick = async () => { const r = await api("POST", "/api/jobs/pump"); addMsg("Worker: " + JSON.stringify(r.ran || "nothing due")); loadJobs(); };
$("jcon").onclick = async () => { await api("POST", "/api/jobs", { kind: "consolidate" }); loadJobs(); };
$("jdig").onclick = async () => { await api("POST", "/api/jobs", { kind: "digest", payload: { range: "day" } }); loadJobs(); };
async function loadActs() {
  const { activity } = await api("GET", "/api/activity");
  $("acts").innerHTML = activity.map(a => `<div class="act"><small>${new Date(a.created_at).toLocaleString()} · ${esc(a.actor)} · <b>${esc(a.action)}</b></small><div><small>${esc(a.detail)}</small></div></div>`).join("");
}
async function loadSets() {
  const [{ settings }, usage] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/usage")]);
  $("sets").innerHTML = `<div class="mem">Personality: ${esc(JSON.stringify(settings.personality))}<br>Autonomy: ${esc(JSON.stringify(settings.autonomy))}<br>Tools: ${esc(JSON.stringify(settings.tools))}</div><p class=muted>Edit via API: PUT /api/settings</p>`;
  $("usage").innerHTML = `<div class="mem">Budget: ${usage.budget.used}/${usage.budget.cap} tokens used.<br>${usage.byEndpoint.map(u => `${esc(u.endpoint)}: ${u.tin + u.tout} tokens (${u.n} calls)`).join("<br>")}</div>`;
  $("budget").textContent = `${usage.budget.used}/${usage.budget.cap}`;
}
$("kill").onclick = async () => { const s = await api("GET", "/api/settings"); s.settings.autonomy.enabled = false; await api("PUT", "/api/settings", { autonomy: s.settings.autonomy }); addMsg("Autonomy paused. Jobs and moments stopped."); };
$("resume").onclick = async () => { const s = await api("GET", "/api/settings"); s.settings.autonomy.enabled = true; await api("PUT", "/api/settings", { autonomy: s.settings.autonomy }); addMsg("Autonomy resumed."); };
refreshMoments();
api("GET", "/api/usage").then(u => $("budget").textContent = `${u.budget.used}/${u.budget.cap}`).catch(() => {});
// Pet: mood line, actions, reactions.
window.petReact = window.petReact || (() => {});
async function refreshPet(retried = false) {
  try {
    const p = await api("GET", "/api/pet/state");
    $("petmood").textContent = `${p.name} · ${p.mood.state} · ⚡${Math.round(p.mood.energy * 100)}% · play ${p.traits.playfulness} · sass ${p.traits.sass}`;
  } catch {
    if (!retried) return setTimeout(() => refreshPet(true), 2000);
    $("petmood").textContent = "pet offline — is the server running? (npm start, open http://localhost:3000)";
  }
}
setTimeout(() => {
  if (!window.__petLoaded && $("petmood").textContent.startsWith("waking")) {
    $("petmood").textContent = "3D failed to load — check connection, hard-refresh (Ctrl+Shift+R)";
  }
}, 5000);
document.querySelectorAll("[data-pet]").forEach(b => b.onclick = async () => {
  try {
    const r = await api("POST", "/api/pet/act", { action: b.dataset.pet });
    window.petReact(r.anim);
    refreshPet();
  } catch (e) { addMsg("Pet: " + e.message); }
});
refreshPet();

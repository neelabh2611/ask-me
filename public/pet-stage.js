// Pet stage: loads venom-blob.glb, plays embedded clips if present,
// else procedural idle. Exposes window.petReact(anim) with springy targets.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const canvas = document.getElementById("petstage");
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
camera.position.set(0, 1.2, 4.2);
scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2, 4, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 1.6);
rim.position.set(-3, 2, -2);
scene.add(rim);
const under = new THREE.PointLight(0x6644ff, 8, 10);
under.position.set(0, -1.2, 1.5);
scene.add(under);

const root = new THREE.Group();
scene.add(root);
let mixer = null, clips = [];
let target = { y: 0, squash: 1, spin: 0, tilt: 0 };
let cur = { y: 0, squash: 1, spin: 0, tilt: 0 };
let t = 0;

new GLTFLoader().load("venom-blob.glb",
  glb => {
    root.add(glb.scene);
    const box = new THREE.Box3().setFromObject(glb.scene);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    glb.scene.position.sub(c).add(new THREE.Vector3(0, s.y / 2 - 0.9, 0));
    const maxDim = Math.max(s.x, s.y, s.z);
    if (maxDim > 2.2) glb.scene.scale.multiplyScalar(2.2 / maxDim);
    clips = glb.animations || [];
    console.log(`blob: ${(glb.scene.children.length)} nodes, ${clips.length} clips`);
    if (clips.length) {
      mixer = new THREE.AnimationMixer(glb.scene);
      mixer.clipAction(clips[0]).play();
      note(`clips: ${clips.map(c => c.name).join(", ")}`);
    } else note("procedural idle (no clips in file)");
  },
  undefined,
  e => {
    const msg = "blob failed: " + String(e?.message || e).slice(0, 120);
    const m = document.getElementById("petmood");
    if (m) m.textContent = msg;
    const c = document.getElementById("petstage");
    if (c) { const x = c.getContext("2d"); if (x) { x.fillStyle = "#fff"; x.font = "14px system-ui"; x.fillText(msg, 12, 30); } }
  }
);
function note(s) {
  console.log("[pet]", s);
}

// Reactions map to target offsets; loop eases toward them (critically damped feel).
const POSES = {
  idle:   { y: 0, squash: 1, spin: 0, tilt: 0 },
  bounce: { y: 0.35, squash: 0.9, spin: 0, tilt: 0 },
  spin:   { y: 0.15, squash: 1, spin: Math.PI * 2, tilt: 0 },
  droop:  { y: -0.15, squash: 1.15, spin: 0, tilt: 0.25 },
  tilt:   { y: 0.05, squash: 1, spin: 0, tilt: -0.3 },
  munch:  { y: 0, squash: 0.8, spin: 0, tilt: 0 }
};
window.petReact = anim => {
  target = { ...POSES[anim] } || { ...POSES.idle };
  if (anim === "spin") { target.spin = cur.spin + Math.PI * 2; }
  clearTimeout(window.__petBack);
  window.__petBack = setTimeout(() => { target = { ...POSES.idle }; }, anim === "droop" ? 2500 : 1200);
};

function size() {
  const w = canvas.clientWidth || 300, h = 240;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(size).observe(canvas);
size();

const clock = new THREE.Clock();
window.__petLoaded = true;
(function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  // procedural breathing always on (subtle, layered under clips)
  const breathe = Math.sin(t * 2.2) * 0.03;
  const k = 1 - Math.exp(-dt * 8); // fast, no overshoot
  for (const key of ["y", "squash", "spin", "tilt"]) cur[key] += (target[key] - cur[key]) * k;
  root.position.y = cur.y + breathe * 0.4;
  root.scale.set(1 + (1 - cur.squash) * 0.6, cur.squash + breathe, 1 + (1 - cur.squash) * 0.6);
  root.rotation.y = cur.spin;
  root.rotation.z = cur.tilt + Math.sin(t * 1.3) * 0.03;
  mixer?.update(dt);
  renderer.render(scene, camera);
})();

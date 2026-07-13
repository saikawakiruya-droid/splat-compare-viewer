import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh, SparkControls, isMobile } from "@sparkjsdev/spark";

// Catalog of scenes. Each scene lists the format variants that actually
// exist in public/, plus a good starting camera. formats maps a format key to
// its file; only listed formats appear in the dropdown for that scene.
// Camera targets were found by probing the point cloud — the raw bounding box
// is dominated by sky/background outliers and its center lands inside geometry,
// so it is useless as a look-at target.
const SCENES = {
  shrine_light: {
    label: "shrine_light (SH無)",
    camera: { pos: [-6, 3.2, 6], look: [2, 3.0, -1] },
    formats: {
      rad: { file: "/shrine_light-lod.rad", label: "RAD — LOD (128MB)" },
      spz: { file: "/shrine_light-lod.spz", label: "SPZ — LOD (108MB)" },
      ply: { file: "/shrine_light.ply", label: "生PLY — LOD無 (278MB)" },
      splat: { file: "/shrine_light.splat", label: ".splat — LOD無 (159MB)" },
    },
  },
  // shrine_clean (SH3) と shrine 原本 は生PLYが1.1GB級で共有セットから除外したため
  // シーンも外している。ローカルにアセットがあれば SCENES に追記すれば復活する。
  kiruya: {
    label: "kiruya",
    camera: { pos: [0, 0, 2.2], look: [0, 0, 0] },
    formats: {
      rad: { file: "/kiruya-lod.rad", label: "RAD — LOD (7.7MB)" },
      spz: { file: "/kiruya-lod.spz", label: "SPZ — LOD (5.7MB)" },
      ply: { file: "/kiruya.ply", label: "生PLY — LOD無 (17MB)" },
      splat: { file: "/kiruya.splat", label: ".splat — LOD無 (8MB)" },
    },
  },
  kiruya_walk: {
    label: "kiruya — 歩行 (分割パーツ)",
    camera: { pos: [2.0, 0.55, 0], look: [0, 0.45, 0] }, // 正面(+X)から
    // Compound scene: body (contains the ground shadow splats) stays fixed;
    // each leg is a separate mesh swung about the hip pivot from parts_meta.json.
    walk: {
      body: "/part_body.ply",
      legs: ["/part_legL.ply", "/part_legR.ply"],
      pivot: [0.0497, 0.2502, 0.0], // P: hip joint, in the parts' own frame
    },
  },
};

const scene = new THREE.Scene();
scene.background = new THREE.Color("#cfe6f2"); // 薄い空色
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 1000);

const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// lodSplatCount is how many splats stay resident (they get depth-sorted every
// frame, so it drives most of the cost). lodRenderScale below 1 picks finer LOD
// nodes per screen pixel. maxStdDev clips each splat's tails. blurAmount is
// anti-alias dilation and is essentially free. pixelRatio is fill cost: on a
// Retina display 2.0 means 4x the fragments of 1.0.
const QUALITY = {
  high: { lodSplatCount: 5_000_000, lodRenderScale: 0.5, maxStdDev: 3.5, blurAmount: 0.2, pixelRatio: 2 },
  medium: { lodSplatCount: 2_500_000, lodRenderScale: 1.0, maxStdDev: 2.83, blurAmount: 0.2, pixelRatio: 1.5 },
  low: { lodSplatCount: 1_200_000, lodRenderScale: 1.0, maxStdDev: 2.83, blurAmount: 0.3, pixelRatio: 1 },
};

const spark = new SparkRenderer({
  renderer,
  // Keep camera motion smooth at the cost of the splat ordering lagging a
  // frame or two behind. By default Spark re-walks the LOD tree and re-sorts
  // every resident splat synchronously inside onBeforeRender, so each camera
  // move stalls the frame it happens on.
  preUpdate: false, // defer that work off the render path
  minSortIntervalMs: 33, // and re-sort at most ~30x/sec instead of every frame
});
scene.add(spark);

function applyQuality(name) {
  const q = QUALITY[name];
  spark.lodSplatCount = q.lodSplatCount;
  spark.lodRenderScale = q.lodRenderScale;
  spark.maxStdDev = q.maxStdDev;
  spark.blurAmount = q.blurAmount;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  spark.lodDirty = true;
  spark.setDirty();
}

const controls = new SparkControls({ canvas: renderer.domElement });
controls.pointerControls.reverseRotate = isMobile();

// OrbitControls is used only for the walk scene (mouse-drag orbit + wheel zoom
// around the avatar), so the keyboard is free to drive the avatar. Disabled by
// default; loadCurrent toggles it against SparkControls per scene.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.enabled = false;
let useOrbit = false;

const statsEl = document.getElementById("stats");
const sceneSelect = document.getElementById("scene-select");
const formatSelect = document.getElementById("format-select");
const qualitySelect = document.getElementById("quality-select");

qualitySelect.addEventListener("change", () => applyQuality(qualitySelect.value));
applyQuality(qualitySelect.value);

let currentMesh = null;
let loadLine = "";

// Populate the scene dropdown once, then repopulate formats whenever the scene
// changes so only the variants that exist for that scene are offered.
for (const [key, s] of Object.entries(SCENES)) {
  sceneSelect.add(new Option(s.label, key));
}

function populateFormats(sceneKey) {
  formatSelect.textContent = "";
  const fmts = SCENES[sceneKey].formats;
  if (!fmts) {
    // Compound scenes (e.g. the walk rig) have no single-file format choice.
    formatSelect.disabled = true;
    return;
  }
  formatSelect.disabled = false;
  for (const [key, f] of Object.entries(fmts)) {
    formatSelect.add(new Option(f.label, key));
  }
}

// Tracks everything currently in the scene so we can tear it down on switch,
// whether it's one mesh or the multi-part walk rig.
let loadedMeshes = [];
let walkRig = null;

function disposeCurrent() {
  if (walkRig && walkRig.ground) {
    scene.remove(walkRig.ground);
    walkRig.ground.geometry?.dispose();
    walkRig.ground.material?.dispose?.();
  }
  walkRig = null;
  for (const m of loadedMeshes) {
    let obj = m;
    while (obj.parent && obj.parent !== scene) obj = obj.parent;
    scene.remove(obj);
    m.dispose?.();
  }
  loadedMeshes = [];
  currentMesh = null;
}

function loadCurrent() {
  const sceneKey = sceneSelect.value;
  const sceneDef = SCENES[sceneKey];

  camera.position.set(...sceneDef.camera.pos);
  camera.lookAt(...sceneDef.camera.look);
  disposeCurrent();

  if (sceneDef.walk) {
    // Walk scene: hand the camera to OrbitControls, free the keyboard for the
    // avatar by disabling SparkControls' FPS movement.
    useOrbit = true;
    orbit.enabled = true;
    controls.fpsMovement.enable = false;
    loadWalkRig(sceneDef);
    return;
  }

  // Non-walk scenes: standard SparkControls (FPS + look), OrbitControls off.
  useOrbit = false;
  orbit.enabled = false;
  controls.fpsMovement.enable = true;

  const url = sceneDef.formats[formatSelect.value].file;
  loadLine = `Loading ${url} ...`;
  statsEl.textContent = loadLine;
  const startTime = performance.now();

  // Raw .ply/.splat have no LOD tree, so the whole file loads flat and every
  // splat stays resident. RAD/SPZ carry the tree and stream/foveate.
  const isLod = url.endsWith(".rad") || url.endsWith(".spz");

  // The quality presets mostly drive LOD (resident splat count, LOD node
  // selection), which does nothing without a tree. Disable the control for raw
  // formats so it doesn't imply an effect it can't have.
  qualitySelect.disabled = !isLod;
  qualitySelect.title = isLod ? "" : "生PLY/.splat はLOD無のため画質指定は効きません";

  const mesh = new SplatMesh({
    url,
    lod: isLod,
    nonLod: true,
    onLoad: () => {
      const loadMs = (performance.now() - startTime).toFixed(0);
      loadLine = `${url} loaded in ${loadMs}ms`;
      // The LOD system only walks the tree when it sees the camera move, so a
      // freshly loaded mesh stays at zero splats (black screen) until the user
      // happens to drag. Nudge the camera once to kick off the first traversal.
      // Must exceed SparkRenderer's 1e-3 "view changed" distance threshold.
      camera.position.x += 0.02;
    },
  });
  mesh.quaternion.set(1, 0, 0, 0);
  scene.add(mesh);
  loadedMeshes = [mesh];
  currentMesh = mesh;
  window.__mesh = mesh;
  window.__scene = scene;
  window.__camera = camera;
  window.__renderer = renderer;
  window.__spark = spark;
}

// Load body + legs as independent SplatMeshes and hang each leg off a hip
// pivot so it can be swung per frame. This demonstrates that Spark handles the
// pre-split part files: each part is just a normal SplatMesh in the scene graph.
function loadWalkRig(sceneDef) {
  qualitySelect.disabled = true; // raw parts, no LOD
  qualitySelect.title = "分割パーツ(生PLY)のため画質指定は効きません";
  loadLine = "Loading 分割パーツ (body + 脚L + 脚R) ...";
  statsEl.textContent = loadLine;
  const startTime = performance.now();

  const { body: bodyUrl, legs: legUrls, pivot } = sceneDef.walk;
  const FOOT_Y = 0.4969; // parts_meta foot_ellipse.y — sole height in the parts frame

  // Nesting, outer to inner:
  //   moveRoot   — locomotion: position.x/z on the ground, rotation.y heading,
  //                position.y lifts the flipped avatar so its soles sit at y=0
  //     swayGroup  — whole-body walk sway (X roll + Y twist) and vertical bob
  //       flipGroup — y/z flip (180° about X) so a -Y-up avatar faces the
  //                   +Y-up camera, matching the single-mesh path
  //         body    — includes the ground shadow splats; static within the rig
  //         hipL/hipR — swing each leg about the hip pivot P
  const moveRoot = new THREE.Group();
  moveRoot.position.y = FOOT_Y; // flip put soles at y=-FOOT_Y; lift to y=0
  const swayGroup = new THREE.Group();
  const flipGroup = new THREE.Group();
  flipGroup.rotation.x = Math.PI;
  moveRoot.add(swayGroup);
  swayGroup.add(flipGroup);
  scene.add(moveRoot);

  const body = new SplatMesh({ url: bodyUrl });
  flipGroup.add(body);
  loadedMeshes.push(body);

  const hips = [];
  legUrls.forEach((legUrl) => {
    const hip = new THREE.Group();
    hip.position.set(...pivot);
    const leg = new SplatMesh({ url: legUrl });
    // The leg PLY is stored relative to the hip pivot P (P was subtracted at
    // split time), so it needs no local offset: placing the hip group at P puts
    // the leg back at its authored spot, and rotating the hip swings the leg
    // about the joint. (An earlier -P offset canceled the +P and left the legs
    // riding up inside the coat, so no feet showed below the hem.)
    leg.position.set(0, 0, 0);
    hip.add(leg);
    flipGroup.add(hip);
    hips.push(hip);
    loadedMeshes.push(leg);
  });

  // A fixed ground grid at y=0. The avatar (in moveRoot) moves over it, so
  // real translation — not a treadmill — reads as walking. Added directly to
  // the scene, not moveRoot, so it stays put as the avatar walks across it.
  const ground = new THREE.GridHelper(20, 40, 0x99b7c7, 0xbcd3de);
  ground.position.y = 0;
  scene.add(ground);

  walkRig = {
    moveRoot, swayGroup, hips, ground,
    phase: 0, lastTime: 0,
    char: { x: 0, z: 0 }, heading: 0,
    keys: {},
  };

  // Orbit around the avatar's mid-height, viewed from its front (+X), where
  // the legs/shoes are visible below the coat (from the side the coat hides
  // them).
  orbit.target.set(0, 0.45, 0);
  camera.position.set(2.0, 0.55, 0);
  orbit.update();

  Promise.all(loadedMeshes.map((m) => m.initialized)).then(() => {
    const loadMs = (performance.now() - startTime).toFixed(0);
    loadLine = `walk rig loaded in ${loadMs}ms`;
    camera.position.x += 0.02; // kick LOD/sort once
  });

  window.__scene = scene;
  window.__camera = camera;
  window.__renderer = renderer;
  window.__spark = spark;
  window.__walkRig = walkRig;
}

const walkControls = document.getElementById("walk-controls");
const walkPlay = document.getElementById("walk-play");
const walkSpeed = document.getElementById("walk-speed");
const walkAmp = document.getElementById("walk-amp");
const walkBob = document.getElementById("walk-bob");
const walkSway = document.getElementById("walk-sway");

// Keyboard drives the avatar (only in the walk scene, where walkRig exists).
// W/S forward-back, A/D turn, Q/E strafe.
const WALK_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
addEventListener("keydown", (e) => {
  if (!walkRig) return;
  const k = e.key.toLowerCase();
  if (WALK_KEYS.has(k)) { walkRig.keys[k] = true; e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  if (!walkRig) return;
  const k = e.key.toLowerCase();
  if (WALK_KEYS.has(k)) walkRig.keys[k] = false;
});

sceneSelect.addEventListener("change", () => {
  populateFormats(sceneSelect.value);
  walkControls.style.display = SCENES[sceneSelect.value].walk ? "block" : "none";
  loadCurrent();
});
formatSelect.addEventListener("change", loadCurrent);

populateFormats(sceneSelect.value);
loadCurrent();

let lastFrameTime = 0;
let smoothedFrameMs = 0;

const WALK_MOVE_SPEED = 0.6; // world units/sec at slider=1
const WALK_TURN_SPEED = 2.2; // radians/sec

renderer.setAnimationLoop((time) => {
  if (useOrbit) orbit.update();
  else controls.update(camera);

  if (walkRig) {
    const dt = walkRig.lastTime ? Math.min(0.05, (time - walkRig.lastTime) / 1000) : 0;
    walkRig.lastTime = time;

    // --- locomotion: QWEASD drive the avatar over the fixed ground ---
    const k = walkRig.keys;
    if (k.a) walkRig.heading += WALK_TURN_SPEED * dt;
    if (k.d) walkRig.heading -= WALK_TURN_SPEED * dt;
    const h = walkRig.heading;
    const spd = WALK_MOVE_SPEED * Number(walkSpeed.value) * dt;
    // Model front at heading 0 is +X; rotation.y=h maps local +X→(cos h,-sin h).
    const fwd = { x: Math.cos(h), z: -Math.sin(h) };
    const right = { x: Math.sin(h), z: Math.cos(h) };
    let moved = false;
    if (k.w) { walkRig.char.x += fwd.x * spd; walkRig.char.z += fwd.z * spd; moved = true; }
    if (k.s) { walkRig.char.x -= fwd.x * spd; walkRig.char.z -= fwd.z * spd; moved = true; }
    if (k.q) { walkRig.char.x -= right.x * spd; walkRig.char.z -= right.z * spd; moved = true; }
    if (k.e) { walkRig.char.x += right.x * spd; walkRig.char.z += right.z * spd; moved = true; }
    const walking = moved || k.a || k.d;

    walkRig.moveRoot.position.x = walkRig.char.x;
    walkRig.moveRoot.position.z = walkRig.char.z;
    walkRig.moveRoot.rotation.y = walkRig.heading;

    // --- walk cycle (ported from viewer_walk.html) ---
    // Animate while moving; the 歩行 checkbox forces it on for an in-place demo.
    const anim = walkPlay.checked || walking;
    if (anim) walkRig.phase += dt * Number(walkSpeed.value) * 3;
    const phase = walkRig.phase;
    const amp = anim ? (Number(walkAmp.value) * Math.PI) / 180 : 0;
    const sway = anim ? Number(walkSway.value) : 0;
    const bob = anim ? Number(walkBob.value) : 0;

    walkRig.hips[0].rotation.z = amp * Math.sin(phase);
    if (walkRig.hips[1]) walkRig.hips[1].rotation.z = amp * Math.sin(phase + Math.PI);
    walkRig.swayGroup.rotation.x = sway * Math.sin(phase); // 左右体重移動(ロール)
    walkRig.swayGroup.rotation.y = sway * 0.5 * Math.sin(phase); // ひねり
    walkRig.swayGroup.position.y = bob * Math.abs(Math.sin(phase)); // 上下バウンド

    // camera orbits around the moving avatar
    orbit.target.set(walkRig.char.x, 0.45, walkRig.char.z);
  }

  renderer.render(scene, camera);

  if (lastFrameTime) {
    const dt = time - lastFrameTime;
    smoothedFrameMs = smoothedFrameMs ? smoothedFrameMs * 0.9 + dt * 0.1 : dt;
  }
  lastFrameTime = time;

  if (smoothedFrameMs && loadedMeshes.length) {
    const fps = (1000 / smoothedFrameMs).toFixed(0);
    const ms = smoothedFrameMs.toFixed(1);
    const total = loadedMeshes.reduce((n, m) => n + (m.numSplats || 0), 0);
    const splats = (total / 1e6).toFixed(2);
    statsEl.textContent = `${loadLine} — ${fps} fps (${ms}ms), ${splats}M splats`;
  }
});

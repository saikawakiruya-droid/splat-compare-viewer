import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh, SparkControls, isMobile, SplatFileType } from "@sparkjsdev/spark";

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
  shrine_clean: {
    label: "shrine_clean (SH3, 軽量化前)",
    camera: { pos: [-6, 3.2, 6], look: [2, 3.0, -1] },
    formats: {
      // RAD(LOD)のみ共有。生PLY(1.1GB)は巨大なため除外。
      rad: { file: "/shrine_clean-lod.rad", label: "RAD — LOD (307MB, SH3)" },
    },
  },
  // shrine 原本(shrine.ply)は 1.18GB の生PLY のみで、共有できる非生アセットが
  // 無いためシーンごと除外。ローカルに実データがあれば SCENES に追記で復活可。
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
  shrine_walk: {
    label: "神社を歩く (kiruya + shrine)",
    camera: { pos: [3, 2, 4], look: [0, 1, 0] },
    // Same walk rig, but with the shrine as the environment splat and a flat
    // walkable plane at the shrine's ground height. The avatar moves over the
    // plane (no terrain following). groundY/scale are starting values; on-screen
    // sliders tune them live since the exact ground height depends on the data.
    walk: {
      env: "/shrine_light-lod.rad", // environment (LOD streams)
      body: "/part_body.ply",
      legs: ["/part_legL.ply", "/part_legR.ply"],
      pivot: [0.0497, 0.2502, 0.0],
      groundY: 0.95, // display-space ground height (data ground y≈-0.97, flipped)
      scale: 1.5, // avatar scale relative to the shrine
    },
  },
};

// Hosted build (GitHub Pages) bundles only the small kiruya assets; the large
// shrine files can't be served from Pages (100MB/file limit), so drop those
// scenes when built with VITE_HOSTED=1.
if (import.meta.env.VITE_HOSTED) {
  delete SCENES.shrine_light;
  delete SCENES.shrine_clean;
  delete SCENES.shrine_walk; // needs the large shrine asset, absent on Pages
}

// Asset paths in SCENES are site-root-absolute ("/kiruya-lod.rad"). Under a
// Pages subpath (base=/repo/) they must be prefixed with BASE_URL.
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");
const asset = (p) => BASE + p;

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
window.__controls = controls; // exposed for debugging/headless verification

// Spark's default move speed is 1 unit/sec — painfully slow in a scene that
// spans tens of units (a shrine) or sits ~170 units out (the 28M scan). Scale
// keyboard + wheel speed to the scene so it always takes ~1s to cross the
// framing distance, whatever the scale. Hold Shift for a 5x burst (built in).
function applyNavSpeed(refDist) {
  // A scene's coordinates can span huge ranges, but the things you actually
  // navigate around (a shrine, a person) stay roughly the same size — so speed
  // should NOT track scene extent linearly (that made wide scans race). Scale
  // by sqrt (weak dependence) and hard-cap. The cap also neutralizes outliers:
  // a few stray far splats inflating the bounds can't blow up the speed.
  const d = Math.max(0.5, refDist || 3);
  const s = Math.sqrt(d);
  controls.fpsMovement.moveSpeed = Math.min(6, 0.55 * s); // WASD / arrows (Shift = 5x)
  controls.pointerControls.scrollSpeed = Math.min(24, 2.2 * s); // mouse wheel dolly
}
applyNavSpeed(3);
window.__applyNavSpeed = applyNavSpeed;

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
// The scene whose camera is currently framed. Switching *format* within the
// same scene must keep the camera where the user left it (that's the whole
// point of a comparison viewer — compare the same viewpoint across formats),
// so we only (re)frame the camera when the scene key actually changes.
let framedSceneKey = null;

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

function loadCurrent(avoid = []) {
  const sceneKey = sceneSelect.value;
  const sceneDef = SCENES[sceneKey];

  // Only reframe when the scene actually changed. A format switch (same scene)
  // keeps the current camera so you compare the identical viewpoint. The walk
  // scene always reframes (it re-rigs the avatar).
  const keepCamera = sceneKey === framedSceneKey && !sceneDef.walk;
  framedSceneKey = sceneKey;

  // Static scenes ship a hand-tuned camera; dynamically registered scenes
  // (add-scene.sh) have none, so they get auto-framed from the mesh bounds on
  // load instead (see the onLoad handlers below).
  if (!keepCamera && sceneDef.camera) {
    camera.position.set(...sceneDef.camera.pos);
    camera.lookAt(...sceneDef.camera.look);
    // Scale nav speed to how far the camera sits from what it's looking at.
    const p = sceneDef.camera.pos, l = sceneDef.camera.look;
    applyNavSpeed(Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]));
  }
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

  // All non-walk scenes (presets AND registered/dropped) use SparkControls:
  // WASD/arrows move, drag looks, mouse-wheel dollies forward/back. Keeping
  // registered scenes on the same controls as presets means the keyboard works
  // everywhere and you can always move closer (wheel or W). OrbitControls is
  // reserved for the walk scene, where the keyboard must drive the avatar.
  useOrbit = false;
  orbit.enabled = false;
  controls.fpsMovement.enable = true;

  const fmt = sceneDef.formats[formatSelect.value];
  // A format either lives on the server (fmt.file, loaded by URL) or was dropped
  // by the user and lives in memory (fmt.blob, a File — used for the client-side
  // comparison scenes that work on the static host with no server).
  const fmtKey = formatSelect.value;
  const isLod = fmtKey === "rad" || fmtKey === "spz";

  // The quality presets mostly drive LOD (resident splat count, LOD node
  // selection), which does nothing without a tree. Disable the control for raw
  // formats so it doesn't imply an effect it can't have.
  qualitySelect.disabled = !isLod;
  qualitySelect.title = isLod ? "" : "生PLY/.splat はLOD無のため画質指定は効きません";

  const label = fmt.blob ? `(ローカル) ${fmt.blob.name}` : asset(fmt.file);
  loadLine = `Loading ${label} ...`;
  statsEl.textContent = loadLine;
  const startTime = performance.now();

  const onLoad = (mesh) => {
    const loadMs = (performance.now() - startTime).toFixed(0);
    loadLine = `${label} loaded in ${loadMs}ms`;
    // On a format switch (keepCamera) leave the camera alone and just nudge to
    // kick the LOD tree. Otherwise frame the scene: preset scenes only need the
    // nudge (their camera was set above), dynamic/client scenes frame from the
    // mesh bounds. The nudge must exceed SparkRenderer's 1e-3 "view changed"
    // distance threshold so the freshly loaded mesh actually draws.
    if (keepCamera || sceneDef.camera) camera.position.x += 0.02;
    else frameCamera(mesh);
  };

  // If the selected format can't load (missing file / 404 / decode error),
  // don't leave a blank screen: auto-fall back to another format in the same
  // scene so the object still renders. `avoid` tracks formats already tried so
  // we can't loop. Guarded so onError and a rejected `initialized` (either may
  // fire) only trigger one fallback.
  let handled = false;
  const onFail = (err) => {
    if (handled) return;
    handled = true;
    const others = Object.keys(sceneDef.formats).filter((k) => k !== fmtKey && !avoid.includes(k));
    if (others.length) {
      loadLine = `${label} を読み込めません → ${others[0].toUpperCase()} に切替えて表示します。`;
      statsEl.textContent = loadLine;
      formatSelect.value = others[0];
      loadCurrent([...avoid, fmtKey]);
    } else {
      loadLine = `この形式を読み込めませんでした（${(err && err.message) || err || "不明なエラー"}）。`;
      statsEl.textContent = loadLine;
    }
  };
  const watchMesh = (mesh) => {
    if (mesh.initialized && mesh.initialized.catch) mesh.initialized.catch(onFail);
  };

  const finishMesh = (mesh) => {
    mesh.quaternion.set(1, 0, 0, 0);
    scene.add(mesh);
    loadedMeshes = [mesh];
    currentMesh = mesh;
    window.__mesh = mesh;
    window.__scene = scene;
    window.__camera = camera;
    window.__renderer = renderer;
    window.__spark = spark;
  };

  if (fmt.blob) {
    // Client-side: decode the dropped File's bytes in-browser. Async read, but
    // disposeCurrent already cleared the old mesh so a fast format re-switch is
    // safe (a late arrival just adds its mesh; the next switch disposes it).
    const fileType = EXT_TO_TYPE[fmt.blob.name.split(".").pop().toLowerCase()];
    fmt.blob.arrayBuffer().then((ab) => {
      const mesh = new SplatMesh({
        fileBytes: new Uint8Array(ab),
        fileType,
        fileName: fmt.blob.name,
        lod: isLod,
        nonLod: true,
        onLoad: () => onLoad(mesh),
        onError: onFail,
      });
      finishMesh(mesh);
      watchMesh(mesh);
    }, onFail);
    return;
  }

  // Server-hosted: load by URL. Raw .ply/.splat have no LOD tree, so the whole
  // file loads flat and every splat stays resident. RAD/SPZ carry the tree.
  const mesh = new SplatMesh({
    url: asset(fmt.file),
    lod: isLod,
    nonLod: true,
    onLoad: () => onLoad(mesh),
    onError: onFail,
  });
  finishMesh(mesh);
  watchMesh(mesh);
}

// Load body + legs as independent SplatMeshes and hang each leg off a hip
// pivot so it can be swung per frame. This demonstrates that Spark handles the
// pre-split part files: each part is just a normal SplatMesh in the scene graph.
function loadWalkRig(sceneDef) {
  qualitySelect.disabled = true; // raw parts, no LOD
  qualitySelect.title = "分割パーツ(生パーツ)のため画質指定は効きません";
  loadLine = "Loading 分割パーツ (body + 脚L + 脚R) ...";
  statsEl.textContent = loadLine;
  const startTime = performance.now();

  const { body: bodyUrl, legs: legUrls, pivot, env } = sceneDef.walk;
  const FOOT_Y = 0.4969; // parts_meta foot_ellipse.y — sole height in the parts frame
  const groundY = sceneDef.walk.groundY ?? 0; // display-space plane height
  const avatarScale = sceneDef.walk.scale ?? 1;

  // Optional environment splat (e.g. the shrine). Flipped like every other
  // scene so its -Y-up data faces the +Y-up camera; it's static scenery the
  // avatar walks through.
  if (env) {
    const isLod = env.endsWith(".rad") || env.endsWith(".spz");
    const envMesh = new SplatMesh({ url: asset(env), lod: isLod, nonLod: true });
    envMesh.quaternion.set(1, 0, 0, 0);
    scene.add(envMesh);
    loadedMeshes.push(envMesh);
    window.__envMesh = envMesh;
  }

  // Nesting, outer to inner:
  //   moveRoot   — locomotion: position.x/z on the plane, position.y = groundY,
  //                rotation.y heading
  //     scaleGroup — avatarScale (fit the avatar to the environment)
  //       liftGroup — position.y = FOOT_Y so the flipped soles sit on the plane
  //         swayGroup — whole-body walk sway (X roll + Y twist) and vertical bob
  //           flipGroup — y/z flip (180° about X) so a -Y-up avatar stands up
  //             body    — includes the ground shadow splats; static within rig
  //             hipL/hipR — swing each leg about the hip pivot P
  const moveRoot = new THREE.Group();
  moveRoot.position.y = groundY;
  const scaleGroup = new THREE.Group();
  scaleGroup.scale.setScalar(avatarScale);
  const liftGroup = new THREE.Group();
  liftGroup.position.y = FOOT_Y; // flip puts soles at y=-FOOT_Y; lift to 0
  const swayGroup = new THREE.Group();
  const flipGroup = new THREE.Group();
  flipGroup.rotation.x = Math.PI;
  moveRoot.add(scaleGroup);
  scaleGroup.add(liftGroup);
  liftGroup.add(swayGroup);
  swayGroup.add(flipGroup);
  scene.add(moveRoot);

  const body = new SplatMesh({ url: asset(bodyUrl) });
  flipGroup.add(body);
  loadedMeshes.push(body);

  const hips = [];
  legUrls.forEach((legUrl) => {
    const hip = new THREE.Group();
    hip.position.set(...pivot);
    const leg = new SplatMesh({ url: asset(legUrl) });
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

  // Flat walkable plane at groundY: a grid the avatar moves over so real
  // translation (not a treadmill) reads as walking. Sized to the environment
  // when present. Kept in the scene (not moveRoot) so it stays put underfoot.
  const gridSize = env ? 40 : 20;
  const ground = new THREE.GridHelper(gridSize, gridSize * 2, 0x99b7c7, 0xbcd3de);
  ground.position.y = groundY;
  ground.material.transparent = true;
  ground.material.opacity = env ? 0.25 : 1; // subtle over the shrine
  scene.add(ground);

  walkRig = {
    moveRoot, swayGroup, hips, ground,
    phase: 0, lastTime: 0,
    char: { x: 0, z: 0 }, heading: 0,
    keys: {},
    groundY, scaleGroup,
  };

  if (env) {
    // Third-person: behind and above the avatar, looking at its upper body.
    orbit.target.set(0, groundY + 0.6 * avatarScale, 0);
    camera.position.set(2.2 * avatarScale, groundY + 1.0 * avatarScale, 2.2 * avatarScale);
  } else {
    // Front view (+X); legs/shoes visible below the coat.
    orbit.target.set(0, 0.45, 0);
    camera.position.set(2.0, 0.55, 0);
  }
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
const envWalkControls = document.getElementById("env-walk-controls");
const walkGround = document.getElementById("walk-ground");
const walkScale = document.getElementById("walk-scale");

// Live-tune the shrine walk: ground plane height and avatar scale. Adjusting
// these moves the walkable plane and resizes the avatar so its soles stay on
// the plane (moveRoot.position.y = groundY; the FOOT_Y lift is inside the
// scaled group, so scale keeps the feet grounded).
function applyEnvWalkTuning() {
  if (!walkRig || !walkRig.scaleGroup) return;
  const g = Number(walkGround.value);
  const s = Number(walkScale.value);
  walkRig.groundY = g;
  walkRig.moveRoot.position.y = g;
  walkRig.scaleGroup.scale.setScalar(s);
  if (walkRig.ground) walkRig.ground.position.y = g;
}
walkGround.addEventListener("input", applyEnvWalkTuning);
walkScale.addEventListener("input", applyEnvWalkTuning);

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
  const def = SCENES[sceneSelect.value];
  populateFormats(sceneSelect.value);
  walkControls.style.display = def.walk ? "block" : "none";
  // Ground/scale sliders only apply to a walk scene with an environment. Seed
  // them from the scene's defaults so tuning starts from a sensible place.
  const hasEnv = !!(def.walk && def.walk.env);
  envWalkControls.style.display = hasEnv ? "block" : "none";
  if (hasEnv) {
    walkGround.value = def.walk.groundY ?? 0;
    walkScale.value = def.walk.scale ?? 1;
  }
  loadCurrent();
});
formatSelect.addEventListener("change", loadCurrent);

// --- Drop a local file to view it -------------------------------------------
// Lets anyone drag their own .ply/.spz/.splat/.rad onto the page and view it,
// fully client-side (Spark decodes in-browser; no server/upload). View-only —
// format generation still happens offline.
const EXT_TO_TYPE = {
  ply: SplatFileType.PLY,
  spz: SplatFileType.SPZ,
  splat: SplatFileType.SPLAT,
  rad: SplatFileType.RAD,
};

function frameCamera(mesh) {
  // Dropped files have unknown scale, so fit the camera after load.
  // getBoundingBox() is local-space; the mesh applies a y/z flip
  // (quaternion 1,0,0,0), so flip the center to world space.
  try {
    const box = mesh.getBoundingBox(true);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // LOD meshes (RAD/SPZ) may report an unpopulated box right after load
    // (null/NaN coords) before the tree has streamed in. Bail to a safe default
    // rather than driving the camera to NaN (which blanks the view for good).
    const finite = [c.x, c.y, c.z, size.x, size.y, size.z].every(Number.isFinite);
    if (!finite) throw new Error("bounding box not ready");
    const wc = new THREE.Vector3(c.x, -c.y, -c.z);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim * 0.6) / Math.tan((camera.fov * Math.PI) / 360) + maxDim * 0.5;
    camera.position.set(wc.x, wc.y, wc.z + dist);
    camera.lookAt(wc);
    applyNavSpeed(dist); // scale nav speed to this object's size
    camera.position.x += 0.02; // nudge to kick LOD traversal
  } catch (_) {
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    applyNavSpeed(3);
    camera.position.x += 0.02;
  }
}

async function loadDroppedFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const fileType = EXT_TO_TYPE[ext];
  if (!fileType) {
    loadLine = `未対応の形式: .${ext}（.ply/.spz/.splat/.rad のみ）`;
    statsEl.textContent = loadLine;
    return;
  }
  disposeCurrent();
  walkControls.style.display = "none";
  framedSceneKey = null; // a viewed drop isn't a scene; next scene load reframes
  // Same controls as every non-walk scene: SparkControls (WASD move, drag look,
  // wheel dolly). Keyboard works and you can move closer.
  useOrbit = false;
  orbit.enabled = false;
  controls.fpsMovement.enable = true;

  const isLod = fileType === SplatFileType.RAD || fileType === SplatFileType.SPZ;
  qualitySelect.disabled = !isLod;

  loadLine = `Loading (ドロップ) ${file.name} ...`;
  statsEl.textContent = loadLine;
  const startTime = performance.now();
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  const mesh = new SplatMesh({
    fileBytes,
    fileType,
    fileName: file.name,
    lod: isLod,
    nonLod: true,
    onLoad: () => {
      loadLine = `${file.name} loaded in ${(performance.now() - startTime).toFixed(0)}ms`;
      frameCamera(mesh);
    },
  });
  mesh.quaternion.set(1, 0, 0, 0);
  scene.add(mesh);
  loadedMeshes = [mesh];
  currentMesh = mesh;
  window.__mesh = mesh;
}

addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) document.body.classList.remove("dragging");
});
// Dropping a .ply REGISTERS it: the file is uploaded to the local dev server,
// which runs scripts/add-scene.sh (build-lod + ply_to_splat.py) to generate the
// RAD/SPZ/.splat comparison formats, then the new scene is added to the Scene
// dropdown and selected. RAD/SPZ generation is native and can't run in-browser,
// which is why it goes through the server. Dropping an already-built
// .rad/.spz/.splat just views it (no comparison set to generate).
async function registerDroppedPly(file) {
  const label = file.name.replace(/\.[^.]+$/, "");
  loadLine = `登録中 (${file.name}) … RAD/SPZ/.splat を生成中（数秒〜十数秒）`;
  statsEl.textContent = loadLine;
  try {
    const q = new URLSearchParams({ name: label, label, filename: file.name });
    const res = await fetch(`/api/register-ply?${q.toString()}`, {
      method: "POST",
      body: await file.arrayBuffer(),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!data.ok) throw new Error(data.error || "登録に失敗しました");

    const entry = (data.scenes?.scenes || []).find((s) => s.key === data.key);
    applyDynamicScene(entry);
    sceneSelect.value = data.key;
    populateFormats(data.key);
    walkControls.style.display = "none";
    loadLine = `登録完了: ${label}`;
    statsEl.textContent = loadLine;
    loadCurrent();
  } catch (err) {
    // Registration needs the dev server (npx vite). If it isn't reachable
    // (e.g. the hosted build) or the tool failed, fall back to view-only so the
    // drop still shows something, and say why.
    loadLine = `登録できませんでした（${err.message}）。表示のみ行います。npx vite で起動中か確認してください。`;
    statsEl.textContent = loadLine;
    loadDroppedFile(file);
  }
}

// Register several already-built format files as ONE client-side comparison
// scene — fully in-browser, no server. This is how the static host (GitHub
// Pages) supports comparison: generate the formats once locally (add-scene.sh /
// npx vite), then drop the resulting .rad/.spz/.splat/.ply set here to compare
// the same object across formats with the Format dropdown. Files stay in memory
// (each format keeps its File; bytes are read on demand when selected).
let clientSceneCounter = 0;
function registerLocalFiles(files) {
  // One file per format; a later drop of the same extension replaces it.
  const FMT_LABEL = { rad: "RAD — LOD", spz: "SPZ — LOD", ply: "生PLY — LOD無", splat: ".splat — LOD無" };
  const byFmt = {};
  const names = [];
  for (const f of files) {
    const ext = f.name.split(".").pop().toLowerCase();
    if (!EXT_TO_TYPE[ext]) continue;
    byFmt[ext] = f;
    names.push(f.name);
  }
  const keys = Object.keys(byFmt);
  if (!keys.length) {
    loadLine = "対応形式(.ply/.spz/.splat/.rad)がドロップされていません。";
    statsEl.textContent = loadLine;
    return;
  }

  // Scene label: longest common filename prefix (strip -lod/format suffixes),
  // falling back to the first file's base name.
  const bases = names.map((n) => n.replace(/\.[^.]+$/, "").replace(/-lod$/i, ""));
  let base = bases[0];
  for (const b of bases) { while (!b.startsWith(base)) base = base.slice(0, -1); }
  base = base.replace(/[-_]$/, "") || bases[0];

  const formats = {};
  for (const k of ["rad", "spz", "ply", "splat"]) {
    if (!byFmt[k]) continue;
    const mb = byFmt[k].size / 1024 / 1024;
    const human = mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(byFmt[k].size / 1024))}KB`;
    formats[k] = { file: null, blob: byFmt[k], label: `${FMT_LABEL[k]} (${human})` };
  }

  const key = `local_${clientSceneCounter++}`;
  SCENES[key] = { label: `${base} (ローカル)`, formats, camera: null, dynamic: true, clientSide: true };
  sceneSelect.add(new Option(`+ ${base} (ローカル)`, key));
  sceneSelect.value = key;
  populateFormats(key);
  walkControls.style.display = "none";
  loadLine = `ローカル比較シーンを登録: ${base} — ${keys.map((k) => k.toUpperCase()).join(" / ")}`;
  statsEl.textContent = loadLine;
  loadCurrent();
}

addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;

  const splatFiles = files.filter((f) => EXT_TO_TYPE[f.name.split(".").pop().toLowerCase()]);

  // Multiple splat files at once → treat them as one object in several formats
  // and build a client-side comparison scene (works on the static host).
  if (splatFiles.length >= 2) {
    registerLocalFiles(splatFiles);
    return;
  }

  // Single file: a .ply tries server-side registration (local dev only, which
  // generates the other formats); anything else just gets viewed. Both fall
  // back to client-side view when there's no server.
  const file = files[0];
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "ply") registerDroppedPly(file);
  else loadDroppedFile(file);
});

// Scenes registered by scripts/add-scene.sh live in public/scenes.json (not in
// the SCENES literal above), so teammates can add their own .ply comparisons
// without editing this file. Merge them in before the first load. Missing file
// (nobody has registered a scene yet) is fine — the catch keeps the presets.
// Register one scenes.json entry into SCENES + the dropdown. Adds a new option
// or refreshes an existing one (re-registration). Returns the scene key.
function applyDynamicScene(s) {
  if (!s || !s.key || !s.formats) return null;
  const isNew = !SCENES[s.key];
  // add-scene.sh embeds a camera computed from the PLY bounds; if it's missing
  // (older entry) loadCurrent auto-frames from the mesh instead.
  SCENES[s.key] = { label: s.label || s.key, formats: s.formats, camera: s.camera || null, dynamic: true };
  if (isNew) sceneSelect.add(new Option(`+ ${s.label || s.key}`, s.key));
  return s.key;
}

async function mergeDynamicScenes() {
  try {
    const res = await fetch(asset("/scenes.json"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    for (const s of data.scenes || []) applyDynamicScene(s);
  } catch (_) {
    /* no scenes.json / bad JSON — keep the built-in presets */
  }
}

await mergeDynamicScenes();
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

    // camera orbits around the moving avatar (at its mid-height above ground)
    const eyeY = walkRig.groundY + 0.45 * (walkRig.scaleGroup ? walkRig.scaleGroup.scale.x : 1);
    orbit.target.set(walkRig.char.x, eyeY, walkRig.char.z);
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

/* Home twin viewer — three.js
 *
 * Loads ../model/house.glb (Z-up, mm units) and shows it with an orbit
 * camera. Phase 2 features:
 *  - 2D/3D/Walk toggle: 2D = orthographic top-down; Walk = first-person
 *  - floor isolation: show one storey only
 *  - external / internal walls, rooms, the structural floor, the flooring and the roof can be hidden independently
 *  - room list with stable ids; click a room to isolate its floor and centre the camera
 *  - Blocks / Real: solid coloured volumes, or brick, shiplap, roof tiles, plaster, carpet, tile, timber and tarmac
 *
 * Units: the model is in mm; scaled by 0.001 at load (scene in metres).
 * The GLB is Z-up; we set camera.up = +Z and orbit around the model.
 * Layout axes are X east, Y south, Z up — left-handed. Each mesh is
 * mirrored on X at load so a right-handed camera matches the house
 * (from the patio, looking south, the carport is on the right).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { initFurniture } from './furniture.js';
import { initLights } from './lights.js';
import { isInteriorSurface, scopeMaterialToRoom, twinRoomForEntry, syncIndoorLightRoomIds, EXTERIOR_ROOMS } from './layers.js';
import {
  getSunPosition,
  getApproxMoonPosition,
  skyDirectionScene,
  dayFactorFromAltitude,
  formatLondonHM,
  HOME_LAT,
  HOME_LON,
} from './sunPosition.js';

/** Assets live under the app's vite base (e.g. /twin/) in production. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const MM = 0.001;
const FLOOR_Z = [0, 2650, 5300]; // mm, matches model/gen_3d.py
const CEILING = 2300;
const SIDEBAR_PX = 232;         // #rooms width + left offset, for 2D centring
/** Docked left rooms panel offset; 0 when the panel is a drawer / hidden. */
function sidebarOffsetPx() {
  if (state.mode === 'walk') return 0;
  if (window.matchMedia('(max-width: 800px)').matches) return 0;
  return SIDEBAR_PX;
}

const state = {
  mode: '3d',            // '3d' | '2d' | 'walk'
  look: 'blocks',        // 'blocks' | 'real'
  floor: 'all',          // 'all' | 0 | 1 | 2
  walls: { external: true, internal: true },
  // Furniture defaults off on mobile — GLBs are huge; lazy-loaded when toggled.
  show: { room: true, floor: true, flooring: true, door: true, window: true, roof: true, furniture: true, lights: true },
  selected: null,        // manifest entry
  meshes: [],
  bounds: null,
  // Real-mode time-of-day: null = live Europe/London clock; else hour 0..24
  // (fractional). Drives sun/moon when look === 'real'.
  timeHour: null,
};

/* ---------- renderer / scene / cameras ---------- */

const view3d = document.getElementById('view3d');

// iPhone Safari OOMs on uncapped DPR + 4K shadows + ~150MB of furniture
// GLBs. Detect constrained devices once; ?mobile=1 / ?quality=low force it.
const _qs = new URLSearchParams(location.search);
const LOW_POWER = _qs.has('mobile') || _qs.get('quality') === 'low'
  || /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches);
const MAX_DPR = LOW_POWER ? 1.5 : 2;

function showFatal(err) {
  console.error('[home-twin]', err);
  let el = document.getElementById('fatal-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal-banner';
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'top:12px', 'z-index:9999',
      'background:#3b1212', 'color:#ffe8e8', 'border:1px solid #a33',
      'border-radius:8px', 'padding:12px 14px', 'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.45)', 'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(el);
  }
  const msg = err && (err.message || String(err));
  el.textContent = `Viewer error (reload may help): ${msg}`;
}
window.addEventListener('error', (ev) => showFatal(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => showFatal(ev.reason));

const renderer = new THREE.WebGLRenderer({
  antialias: !LOW_POWER,
  powerPreference: LOW_POWER ? 'low-power' : 'high-performance',
  failIfMajorPerformanceCaveat: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
renderer.shadowMap.enabled = !LOW_POWER;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
view3d.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);

// Image-based ambient (a small room lit by area lights, prefiltered via
// PMREM). Skipped on LOW_POWER — PMREM + RoomEnvironment is a big GPU hit
// on iOS; Real mode bumps hemisphere instead (see applyLighting).
let pmrem = null;
if (!LOW_POWER) {
  pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}
scene.environmentIntensity = 0;

// Must run after LOW_POWER is known (state object is declared above).
state.show.furniture = !LOW_POWER;

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
camera.up.set(0, 0, 1);
camera.position.set(-14, -16, 13);

const camera2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
// Top-down: world −Y (north) is up the screen.
camera2d.up.set(0, -1, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// First-person walk. PointerLockControls assumes Y-up look; this scene is
// Z-up, so we keep its lock/unlock + isLocked API and drive yaw/pitch
// ourselves. enabled=false stops its YXZ mousemove from rewriting the
// camera quaternion (pointerSpeed 0 is not enough — it still round-trips
// through YXZ euler).
const walkControls = new PointerLockControls(camera, renderer.domElement);
walkControls.enabled = false;

// Outdoor lights. Blocks keeps a static bright key/fill so colours read.
// Real mode steers sun / moon / sky from solar altitude at LE19 4BH
// (see sunPosition.js) — live clock or an optional hour override.
const hemi = new THREE.HemisphereLight(0xd7e6f5, 0x3d342c, 0.7);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff1df, 3.0);
sun.castShadow = !LOW_POWER;
sun.shadow.mapSize.set(LOW_POWER ? 1024 : 4096, LOW_POWER ? 1024 : 4096);
sun.shadow.radius = LOW_POWER ? 0 : 4;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.04;
scene.add(sun);
scene.add(sun.target);
const fill = new THREE.DirectionalLight(0xc5d4e8, 1.15);
scene.add(fill);
scene.add(fill.target);
const moon = new THREE.DirectionalLight(0xc5d0e8, 0);
moon.castShadow = false;
scene.add(moon);
scene.add(moon.target);

const DAY_BG = new THREE.Color(0x87a0b8);
const TWILIGHT_BG = new THREE.Color(0x2a3340);
const NIGHT_BG = new THREE.Color(0x07090c);
const BLOCKS_BG = new THREE.Color(0x101418);

/** @type {{ span: number, ready: boolean }} */
const outdoorRig = { span: 12, ready: false };
let _sunCache = { t: 0, altitude: 0.6, azimuth: Math.PI };

function dateForOutdoor() {
  if (state.timeHour == null) return new Date();
  // Build a Europe/London wall-clock instant for "today" + override hour.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const h = state.timeHour;
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  // Interpret as London local via a timestamp that Date parses as local
  // box time — the box is set to Europe/London, so this matches wall clock.
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function refreshSunCache(force = false) {
  const now = performance.now();
  if (!force && now - _sunCache.t < 30_000 && state.timeHour == null) return;
  // When overriding time, refresh every call so the slider is snappy.
  if (!force && state.timeHour != null && now - _sunCache.t < 100) return;
  const sunPos = getSunPosition(dateForOutdoor(), HOME_LAT, HOME_LON);
  _sunCache = { t: now, altitude: sunPos.altitude, azimuth: sunPos.azimuth };
}

function placeBody(light, altitude, azimuth, dist) {
  const c = homeCenter;
  const dir = skyDirectionScene(altitude, azimuth);
  light.position.set(
    c.x + dir.x * dist,
    c.y + dir.y * dist,
    c.z + dir.z * dist,
  );
  light.target.position.copy(c);
  light.target.updateMatrixWorld();
}

function placeLights() {
  const c = homeCenter;
  const size = state.bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 8);
  outdoorRig.span = span;
  outdoorRig.ready = true;
  sun.target.position.copy(c);
  moon.target.position.copy(c);
  fill.position.copy(c).add(new THREE.Vector3(span * 0.5, span * 0.75, span * 0.55));
  fill.target.position.copy(c);
  const cam = sun.shadow.camera;
  const d = span * 1.2;
  cam.left = -d;
  cam.right = d;
  cam.top = d;
  cam.bottom = -d;
  cam.near = span * 0.05;
  cam.far = span * 4;
  cam.updateProjectionMatrix();
  // Static Blocks/default pose until Real applyLighting moves the sun.
  sun.position.copy(c).add(new THREE.Vector3(-span * 0.65, -span * 0.8, span * 1.25));
}

function lerpColorHex(out, a, b, t) {
  out.set(a).lerp(b, t);
}

// Blocks stays bright and even so the colours read. Real uses a time-of-day
// sun/moon + sky. The plan is evenly lit in both looks.
function applyLighting() {
  const threeD = state.mode === '3d' || state.mode === 'walk';
  const real = state.look === 'real';
  ambient.intensity = threeD && !real ? 0.45 : 0;
  if (!threeD) {
    sun.intensity = 0;
    sun.castShadow = false;
    fill.intensity = 0;
    moon.intensity = 0;
    ambient.intensity = 0.85;
    hemi.intensity = real ? 0.9 : 1.1;
    hemi.color.setHex(0xd7e6f5);
    hemi.groundColor.setHex(0x3d342c);
    scene.environmentIntensity = 0;
    scene.background.copy(BLOCKS_BG);
    renderer.toneMappingExposure = 1.15;
    return;
  }
  if (!real) {
    // Blocks 3D — static bright key (unchanged look).
    sun.castShadow = false;
    sun.color.setHex(0xfff1df);
    sun.intensity = 1.15;
    fill.intensity = 0.9;
    moon.intensity = 0;
    hemi.color.setHex(0xd7e6f5);
    hemi.groundColor.setHex(0x3d342c);
    hemi.intensity = 0.85;
    scene.environmentIntensity = 0;
    scene.background.copy(BLOCKS_BG);
    renderer.toneMappingExposure = 1.12;
    if (outdoorRig.ready) {
      const c = homeCenter;
      const span = outdoorRig.span;
      sun.position.copy(c).add(new THREE.Vector3(-span * 0.65, -span * 0.8, span * 1.25));
      sun.target.position.copy(c);
    }
    return;
  }

  // ---- Real 3D: sun / moon from solar altitude ----
  refreshSunCache(true);
  const alt = _sunCache.altitude;
  const az = _sunCache.azimuth;
  const day = dayFactorFromAltitude(alt);
  const night = 1 - day;
  const span = outdoorRig.span;
  const dist = span * 1.6;

  // Sun colour: warm dawn/dusk, neutral midday, extinguished at night.
  const sunCol = new THREE.Color();
  if (day > 0.001) {
    const elev = Math.max(0, Math.min(1, alt / (Math.PI / 2)));
    sunCol.setHex(0xffc58a).lerp(new THREE.Color(0xfff1df), elev);
  } else {
    sunCol.setHex(0xfff1df);
  }
  sun.color.copy(sunCol);
  // Intensity scales with altitude; full day peaks near 3.0 as before.
  const sunI = day * (0.35 + 2.65 * Math.max(0, Math.sin(Math.max(alt, 0))));
  sun.intensity = sunI;
  sun.castShadow = !LOW_POWER && day > 0.15 && alt > 0.04;
  if (outdoorRig.ready) {
    // Keep the disk just above the horizon for direction during twilight.
    const placeAlt = alt > 0.02 ? alt : 0.02;
    placeBody(sun, placeAlt, az, dist);
  }

  // Cool bounce opposite the sun by day; fades at night.
  fill.color.setHex(0xc5d4e8);
  fill.intensity = 0.15 + 0.7 * day;
  if (outdoorRig.ready) {
    const c = homeCenter;
    fill.position.copy(c).add(new THREE.Vector3(span * 0.5, span * 0.75, span * 0.55));
    fill.target.position.copy(c);
    fill.target.updateMatrixWorld();
  }

  // Moon: opposite-ish ecliptic stand-in, only meaningful at night.
  const moonPos = getApproxMoonPosition({ altitude: alt, azimuth: az });
  moon.color.setHex(0xc8d2ea);
  moon.intensity = night * 0.22;
  if (outdoorRig.ready) placeBody(moon, moonPos.altitude, moonPos.azimuth, dist * 0.9);

  // Sky hemisphere + clear colour.
  const skyDay = new THREE.Color(0xd7e6f5);
  const skyNight = new THREE.Color(0x1a2230);
  const groundDay = new THREE.Color(0x3d342c);
  const groundNight = new THREE.Color(0x0a0c10);
  hemi.color.copy(skyDay).lerp(skyNight, night);
  hemi.groundColor.copy(groundDay).lerp(groundNight, night);
  // Soft IBL bounce (desktop). On LOW_POWER there is no env map — lift
  // hemisphere / ambient so Real mode stays readable indoors.
  if (LOW_POWER) {
    hemi.intensity = 0.35 + 0.45 * day + 0.12 * night;
    ambient.intensity = 0.10 + 0.06 * day;
    scene.environmentIntensity = 0;
  } else {
    hemi.intensity = 0.12 + 0.28 * day + 0.06 * night;
    scene.environmentIntensity = 0.08 + 0.16 * day;
  }

  if (day >= 0.99) scene.background.copy(DAY_BG);
  else if (day <= 0.01) scene.background.copy(NIGHT_BG);
  else if (day > 0.5) lerpColorHex(scene.background, TWILIGHT_BG, DAY_BG, (day - 0.5) * 2);
  else lerpColorHex(scene.background, NIGHT_BG, TWILIGHT_BG, day * 2);

  // Night: open exposure a touch so Hue-lit rooms read; day stays as before.
  renderer.toneMappingExposure = 1.08 + 0.12 * night;
}

/* ---------- palette ---------- */

const COLORS = {
  external: 0x5a6470,
  internal: 0x7d8794,
  block: 0xc4bfb4,
  plaster: 0xe7e0d4,
  structure: 0xb7b2a8,
  soffit: 0xc5c1b8,
  stairs: 0xc8a86a,
  floor: 0x7f97a8,
  cladding: 0xc8cbc6,
  roof: 0x3e4248,
  fascia: 0xe6e4de,
  glazing: 0xc5d8ea,
  door: 0x8d6a43,
  'door-out': 0x3c4248,
  'door-in': 0xf3f1ec,
  frame: 0xe6e4de,
  'frame-out': 0x3a4046,
  'frame-in': 0xf4f2ed,
  bar: 0x2a2e32,
  metal: 0xd5d8dc,
  obscure: 0xd5e0e6,
  rail: 0xe6e4de,
};
const roomPalette = [0x7da7c4, 0x8fbf9f, 0xc4a17d, 0xb58fc4, 0x9fc4b0, 0xc4b58f, 0x8f9fc4, 0xc49f9f];
function colorOf(entry, roomIndex) {
  if (entry.kind === 'floor' && entry.wall) return COLORS[entry.wall] ?? COLORS.floor;
  const roomId = entry.kind === 'room' ? entry.id : entry.room;
  const tinted = entry.kind === 'flooring' || entry.kind === 'room'
    || entry.kind === 'plaster' || entry.kind === 'ceiling';
  if (tinted && roomId != null && roomIndex.has(roomId)) {
    return roomPalette[roomIndex.get(roomId) % roomPalette.length];
  }
  return COLORS[entry.kind] ?? 0x888888;
}

/* ---------- realistic textures (1 metre per tile) ---------- */

function canvasTexture(draw, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// Dulux Almond White (https://www.dulux.co.uk/en/colour-details/almond-white).
// The map is a near-white grain; the material colour is the paint.
const ALMOND = 0xefe7da;
// Johnstone's Washable Matt. Digital matches from allpaintcolours
// (Johnstone's does not publish hex). Natural Sage is Argos 8805111;
// Vintage Denim is Argos 1407743.
const SAGE = 0xb1bcac;
const DENIM = 0x47637f;
const plasterMap = canvasTexture((g, s) => {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, s, s);
  const img = g.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
});

/* Beige cut-pile carpet. Sampled from the reference photo:
   mean RGB 158,142,126, fibre tips near 194,177,160 and roots
   near 128,112,97. One tile is 450mm so the pile stays visible
   in the room view. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Exterior brick: Ibstock Leicester Multi Red, from the Lubbesthorpe
   R9 material palette (19/1033/RM, H5854_025_01).
   Face 240×60mm, 10mm joint: module 250×70mm, stretcher bond.
   The multi is three tones sampled from that swatch: dark 144,80,64,
   body 160,88,71, light 169,104,83. Mortar is the buff joint, near
   152,128,102. The tile is 8 bricks by 16 courses so the half-bond repeats. */
function makeBrickMap() {
  const pxPerMm = 2;
  const brickMm = 240;
  const courseMm = 60;
  const jointMm = 10;
  const modX = brickMm + jointMm;
  const modY = courseMm + jointMm;
  const cols = 8;
  const rows = 16;
  const tileW = cols * modX * pxPerMm;
  const tileH = rows * modY * pxPerMm;
  const bw = brickMm * pxPerMm;
  const bh = courseMm * pxPerMm;

  const canvas = document.createElement('canvas');
  canvas.width = tileW;
  canvas.height = tileH;
  const g = canvas.getContext('2d');

  g.fillStyle = 'rgb(152,128,102)';
  g.fillRect(0, 0, tileW, tileH);
  const mortar = g.getImageData(0, 0, tileW, tileH);
  const md = mortar.data;
  const mortarRnd = mulberry32(0xb41c);
  for (let y = 0; y < tileH; y += 2) {
    for (let x = 0; x < tileW; x += 2) {
      const n = (mortarRnd() - 0.5) * 16;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y + dy) * tileW + (x + dx)) * 4;
          md[i] += n;
          md[i + 1] += n * 0.9;
          md[i + 2] += n * 0.85;
        }
      }
    }
  }
  g.putImageData(mortar, 0, 0);

  const face = document.createElement('canvas');
  face.width = bw;
  face.height = bh;
  const fg = face.getContext('2d');

  function stamp(img, x, y) {
    g.drawImage(img, x, y);
    if (x < 0) g.drawImage(img, x + tileW, y);
    else if (x + bw > tileW) g.drawImage(img, x - tileW, y);
  }

  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * (modX * pxPerMm) / 2;
    for (let col = -1; col < cols; col++) {
      const x = col * modX * pxPerMm + offset;
      if (x >= tileW || x + bw <= 0) continue;
      const rnd = mulberry32(0xb10000 + row * 64 + (col + 1));
      const tone = rnd();
      const base = tone < 0.33 ? [144, 80, 64]
        : tone < 0.67 ? [160, 88, 71]
        : [169, 104, 83];
      const r = base[0] + (rnd() + rnd() - 1) * 12;
      const gv = base[1] + (rnd() + rnd() - 1) * 10;
      const b = base[2] + (rnd() + rnd() - 1) * 8;
      fg.fillStyle = `rgb(${r | 0},${gv | 0},${b | 0})`;
      fg.fillRect(0, 0, bw, bh);

      const img = fg.getImageData(0, 0, bw, bh);
      const d = img.data;
      for (let py = 0; py < bh; py += 2) {
        for (let px = 0; px < bw; px += 2) {
          const n = (rnd() - 0.5) * 14;
          for (let dy = 0; dy < 2; dy++) {
            const i = ((py + dy) * bw + px) * 4;
            d[i] += n;
            d[i + 1] += n;
            d[i + 2] += n * 0.9;
            d[i + 4] += n;
            d[i + 5] += n;
            d[i + 6] += n * 0.9;
          }
        }
      }
      fg.putImageData(img, 0, 0);

      const stains = rnd() < 0.16 ? 1 + (rnd() < 0.35 ? 1 : 0) : 0;
      for (let s = 0; s < stains; s++) {
        const cx = 30 + rnd() * (bw - 60);
        const cy = 12 + rnd() * (bh - 24);
        const rx = 28 + rnd() * 70;
        const ry = 8 + rnd() * 18;
        fg.fillStyle = `rgba(176,122,86,${0.28 + rnd() * 0.35})`;
        fg.beginPath();
        fg.ellipse(cx, cy, rx, ry, (rnd() - 0.5) * 0.6, 0, Math.PI * 2);
        fg.fill();
      }
      if (rnd() < 0.06) {
        fg.strokeStyle = `rgba(210,196,184,${0.25 + rnd() * 0.35})`;
        fg.lineWidth = 1 + rnd() * 2;
        fg.beginPath();
        const sy = 8 + rnd() * (bh - 16);
        fg.moveTo(8, sy);
        fg.lineTo(bw - 8, sy + (rnd() - 0.5) * 8);
        fg.stroke();
      }

      stamp(face, x, row * modY * pxPerMm);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / (cols * modX * MM), 1 / (rows * modY * MM));
  return tex;
}
const brickMap = makeBrickMap();

/* Front shiplap: Hardie Plank Monterey Taupe, from the Lubbesthorpe
   R9 material palette. Board face near RGB 126,119,97; the lap
   shadow is near 96,90,74. Cover is 150mm, joint 8mm. */
function makeShiplapMap() {
  const pxPerMm = 2;
  const boardMm = 150;
  const jointMm = 8;
  const modY = boardMm + jointMm;
  const rows = 8;
  const tileW = 512;
  const tileH = rows * modY * pxPerMm;
  const canvas = document.createElement('canvas');
  canvas.width = tileW;
  canvas.height = tileH;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgb(96,90,74)';
  g.fillRect(0, 0, tileW, tileH);
  for (let row = 0; row < rows; row++) {
    const y = row * modY * pxPerMm;
    const rnd = mulberry32(0xc1ad00 + row * 17);
    const shade = (rnd() - 0.5) * 8;
    const faceR = 126 + shade;
    const faceG = 119 + shade;
    const faceB = 97 + shade * 0.8;
    g.fillStyle = `rgb(${faceR | 0},${faceG | 0},${faceB | 0})`;
    g.fillRect(0, y + jointMm * pxPerMm, tileW, boardMm * pxPerMm);
    const img = g.getImageData(0, y, tileW, modY * pxPerMm);
    const d = img.data;
    for (let py = jointMm * pxPerMm; py < img.height; py += 2) {
      const n = (rnd() - 0.5) * 8;
      for (let px = 0; px < tileW; px += 2) {
        const i = (py * tileW + px) * 4;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
        d[i + 4] += n;
        d[i + 5] += n;
        d[i + 6] += n;
      }
    }
    g.putImageData(img, 0, y);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / (tileW / pxPerMm * MM), 1 / (rows * modY * MM));
  return tex;
}
const shiplapMap = makeShiplapMap();

/* Forticrete SL8 Slate Grey, from the Lubbesthorpe R9 material palette.
   Tile face near RGB 62,58,52; the lap shadow near 40,37,33.
   One course is 320mm, so the repeat reads as overlapping tiles. */
function makeRoofTileMap() {
  const pxPerMm = 2;
  const courseMm = 320;
  const lapMm = 28;
  const rows = 4;
  const tileW = 640;
  const tileH = rows * courseMm * pxPerMm;
  const canvas = document.createElement('canvas');
  canvas.width = tileW;
  canvas.height = tileH;
  const g = canvas.getContext('2d');
  for (let row = 0; row < rows; row++) {
    const y = row * courseMm * pxPerMm;
    const h = courseMm * pxPerMm;
    const rnd = mulberry32(0x710f00 + row * 29);
    const shade = (rnd() - 0.5) * 8;
    g.fillStyle = `rgb(${(62 + shade) | 0},${(58 + shade) | 0},${(52 + shade) | 0})`;
    g.fillRect(0, y, tileW, h);
    g.fillStyle = 'rgb(40,37,33)';
    g.fillRect(0, y, tileW, lapMm * pxPerMm);
    const img = g.getImageData(0, y, tileW, h);
    const d = img.data;
    for (let py = lapMm * pxPerMm; py < h; py += 2) {
      for (let px = 0; px < tileW; px += 2) {
        const n = (rnd() - 0.5) * 12;
        const i = (py * tileW + px) * 4;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
        d[i + 4] += n;
        d[i + 5] += n;
        d[i + 6] += n;
      }
    }
    g.putImageData(img, 0, y);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / (tileW / pxPerMm * MM), 1 / (rows * courseMm * MM));
  return tex;
}
const roofTileMap = makeRoofTileMap();

/* Ground-floor grey oak. Boards run north–south (layout Y).
   Each board is 180mm wide × 1200mm long. Neighbouring columns
   sit on a 240mm joint grid (1200/240 = 5 positions) and never
   share a joint with the column beside them. The repeat is
   10 columns × 180mm by one board length. */
function greyOakFloorMap() {
  const pxPerMm = 2;
  const plankW = 180;
  const plankL = 1200;
  const offsets = [0, 720, 240, 960, 480, 960, 240, 720, 0, 480];
  const cols = offsets.length;
  const tile = document.createElement('canvas');
  tile.width = cols * plankW * pxPerMm;
  tile.height = plankL * pxPerMm;
  const tg = tile.getContext('2d');
  tg.fillStyle = '#3e3a34';
  tg.fillRect(0, 0, tile.width, tile.height);

  const boardW = (plankW - 1.5) * pxPerMm;
  const boardH = plankL * pxPerMm;
  for (let c = 0; c < cols; c++) {
    const rnd = mulberry32(0x0a4e1000 + c * 97);
    const board = document.createElement('canvas');
    board.width = boardW;
    board.height = boardH;
    const g = board.getContext('2d');
    const hue = 28 + rnd() * 8;
    const lit = 48 + rnd() * 14;
    g.fillStyle = `hsl(${hue}, ${6 + rnd() * 6}%, ${lit}%)`;
    g.fillRect(0, 0, boardW, boardH);

    const img = g.getImageData(0, 0, boardW, boardH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 16) {
      const n = (rnd() - 0.5) * 16;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n * 0.75;
    }
    g.putImageData(img, 0, 0);

    const streaks = 14 + Math.floor(rnd() * 10);
    for (let i = 0; i < streaks; i++) {
      const x = rnd() * boardW;
      const amp = 3 + rnd() * 16;
      const pale = rnd() < 0.4;
      g.strokeStyle = pale
        ? `rgba(236, 232, 224, ${0.14 + rnd() * 0.2})`
        : `rgba(58, 52, 44, ${0.16 + rnd() * 0.28})`;
      g.lineWidth = 0.7 + rnd() * 2.4;
      g.beginPath();
      g.moveTo(x, 0);
      const segs = 8;
      for (let s = 1; s <= segs; s++) {
        const y = (s / segs) * boardH;
        g.lineTo(x + Math.sin(s * 1.3 + rnd() * 4) * amp, y);
      }
      g.stroke();
    }

    if (rnd() < 0.8) {
      const cx = boardW * (0.28 + rnd() * 0.44);
      const cy = boardH * (0.12 + rnd() * 0.72);
      const rx = boardW * (0.10 + rnd() * 0.18);
      const ry = boardH * (0.035 + rnd() * 0.07);
      for (let k = 4; k >= 1; k--) {
        g.strokeStyle = `rgba(78, 68, 56, ${0.08 + k * 0.035})`;
        g.lineWidth = 1.1;
        g.beginPath();
        g.ellipse(cx, cy, (rx * k) / 4, (ry * k) / 4, 0, 0, Math.PI * 2);
        g.stroke();
      }
    }

    const edge = g.createLinearGradient(0, 0, boardW, 0);
    edge.addColorStop(0, 'rgba(36, 32, 26, 0.42)');
    edge.addColorStop(0.045, 'rgba(36, 32, 26, 0)');
    edge.addColorStop(0.955, 'rgba(36, 32, 26, 0)');
    edge.addColorStop(1, 'rgba(36, 32, 26, 0.42)');
    g.fillStyle = edge;
    g.fillRect(0, 0, boardW, boardH);
    g.fillStyle = 'rgba(36, 32, 26, 0.55)';
    g.fillRect(0, 0, boardW, pxPerMm * 1.5);

    const x = c * plankW * pxPerMm;
    const y = offsets[c] * pxPerMm;
    tg.drawImage(board, x, y);
    if (y > 0) tg.drawImage(board, x, y - boardH);
  }

  const tex = new THREE.CanvasTexture(tile);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / (cols * plankW * MM), 1 / (plankL * MM));
  return tex;
}
const greyOakMap = greyOakFloorMap();

// Vertical composite-door grain. UVs on a door face are world x, z in
// metres, so one tile is a board 0.28m wide and a full leaf tall.
function doorGrainMap(hex, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(seed);
  g.fillStyle = hex;
  g.fillRect(0, 0, 256, 512);
  const rgb = hex.match(/\w\w/g).map((c) => parseInt(c, 16));
  for (let i = 0; i < 110; i++) {
    const x = rnd() * 256;
    const shade = rnd() < 0.5 ? -1 : 1;
    const amp = 8 + rnd() * 28;
    g.strokeStyle = `rgba(${rgb.map((c) => Math.max(0, Math.min(255, c + shade * amp)) | 0).join(',')}, ${0.18 + rnd() * 0.45})`;
    g.lineWidth = 0.6 + rnd() * 2.2;
    g.beginPath();
    g.moveTo(x, 0);
    const segs = 6;
    for (let s = 1; s <= segs; s++) {
      g.lineTo(x + Math.sin(s * 1.7 + rnd() * 3) * (rnd() * 5), (s / segs) * 512);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / 0.28, 1 / 2.01);
  return tex;
}
const doorOutMap = doorGrainMap('#3c4248', 0xd001);
const doorInMap = doorGrainMap('#f3f1ec', 0xd002);

function beigeCarpetMap() {
  const tileM = 0.45;
  const size = 384;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(0xbe16e0c8);
  g.fillStyle = '#d2c2ae';
  g.fillRect(0, 0, size, size);

  function paintWrapped(x, y, rad, drawAt) {
    const xs = [x];
    const ys = [y];
    if (x - rad < 0) xs.push(x + size);
    if (x + rad > size) xs.push(x - size);
    if (y - rad < 0) ys.push(y + size);
    if (y + rad > size) ys.push(y - size);
    for (const sx of xs) for (const sy of ys) drawAt(sx, sy);
  }

  for (let i = 0; i < 36; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rad = size * (0.08 + rnd() * 0.16);
    const lift = (rnd() - 0.5) * 22;
    const r = 210 + lift;
    const gc = 194 + lift * 0.9;
    const b = 174 + lift * 0.75;
    paintWrapped(x, y, rad, (sx, sy) => {
      const cloud = g.createRadialGradient(sx, sy, 0, sx, sy, rad);
      cloud.addColorStop(0, `rgba(${r | 0},${gc | 0},${b | 0},0.35)`);
      cloud.addColorStop(1, `rgba(${r | 0},${gc | 0},${b | 0},0)`);
      g.fillStyle = cloud;
      g.beginPath();
      g.arc(sx, sy, rad, 0, Math.PI * 2);
      g.fill();
    });
  }

  for (let i = 0; i < 14000; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rx = 1.1 + rnd() * 2.6;
    const ry = rx * (0.65 + rnd() * 0.55);
    const rot = rnd() * Math.PI;
    const lit = rnd();
    const tip = lit > 0.84;
    const root = lit < 0.1;
    const r = root ? 168 + rnd() * 20 : tip ? 228 + rnd() * 24 : 188 + lit * 48;
    const gc = root ? 150 + rnd() * 18 : tip ? 210 + rnd() * 22 : 172 + lit * 44;
    const b = root ? 128 + rnd() * 16 : tip ? 186 + rnd() * 20 : 150 + lit * 40;
    g.fillStyle = `rgb(${r | 0},${gc | 0},${b | 0})`;
    paintWrapped(x, y, rx, (sx, sy) => {
      g.beginPath();
      g.ellipse(sx, sy, rx, ry, rot, 0, Math.PI * 2);
      g.fill();
    });
  }

  for (let i = 0; i < 90; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const brown = rnd() < 0.22;
    g.fillStyle = brown ? 'rgba(122, 86, 52, 0.85)' : 'rgba(62, 52, 44, 0.8)';
    const rad = 0.6 + rnd() * 0.9;
    paintWrapped(x, y, rad, (sx, sy) => {
      g.beginPath();
      g.arc(sx, sy, rad, 0, Math.PI * 2);
      g.fill();
    });
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / tileM, 1 / tileM);
  return tex;
}
const carpetMap = beigeCarpetMap();

/* Wet-room porcelain. 240mm squares, 3mm pale grout, fine mineral
   speckle. Four tiles across so neighbouring squares can differ
   slightly; the grout sits on the repeat boundary so the grid is
   continuous. Albedo is darker than the photo so it lands on that
   mid-grey under the sun. The photo's dirt is left out. */
function greyTileFloorMap() {
  const tileMm = 240;
  const groutMm = 3;
  const pxPerMm = 2;
  const across = 4;
  const tilePx = tileMm * pxPerMm;
  const groutPx = groutMm * pxPerMm;
  const size = across * tilePx;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');

  function clipTile(tx, ty, draw) {
    g.save();
    g.beginPath();
    g.rect(tx * tilePx, ty * tilePx, tilePx, tilePx);
    g.clip();
    draw();
    g.restore();
  }

  for (let ty = 0; ty < across; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const rnd = mulberry32(0x71e0a11 + tx * 131 + ty * 977);
      const lit = 46 + rnd() * 6;
      g.fillStyle = `hsl(${32 + rnd() * 8}, ${3 + rnd() * 2}%, ${lit}%)`;
      g.fillRect(tx * tilePx, ty * tilePx, tilePx, tilePx);

      clipTile(tx, ty, () => {
        for (let i = 0; i < 5; i++) {
          const cx = tx * tilePx + rnd() * tilePx;
          const cy = ty * tilePx + rnd() * tilePx;
          const rad = tilePx * (0.18 + rnd() * 0.28);
          const lift = (rnd() - 0.5) * 36;
          const cloud = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
          cloud.addColorStop(0, `rgba(${128 + lift},${126 + lift},${118 + lift},0.28)`);
          cloud.addColorStop(1, `rgba(${186 + lift},${184 + lift},${176 + lift},0)`);
          g.fillStyle = cloud;
          g.beginPath();
          g.arc(cx, cy, rad, 0, Math.PI * 2);
          g.fill();
        }
        const streaks = 22 + Math.floor(rnd() * 10);
        for (let i = 0; i < streaks; i++) {
          const x = tx * tilePx + rnd() * tilePx;
          const pale = rnd() < 0.45;
          g.strokeStyle = pale
            ? `rgba(214, 210, 200, ${0.07 + rnd() * 0.08})`
            : `rgba(62, 60, 54, ${0.07 + rnd() * 0.1})`;
          g.lineWidth = 0.6 + rnd() * 1.6;
          g.beginPath();
          g.moveTo(x, ty * tilePx);
          g.lineTo(x + (rnd() - 0.5) * 14, (ty + 1) * tilePx);
          g.stroke();
        }
      });
    }
  }

  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const noise = mulberry32(0x6a11c0de);
  for (let i = 0; i < d.length; i += 4) {
    const n = (noise() - 0.5) * 22;
    const speck = noise() < 0.06 ? (noise() - 0.5) * 48 : 0;
    d[i] += n + speck;
    d[i + 1] += n * 0.98 + speck;
    d[i + 2] += n * 0.9 + speck * 0.82;
  }
  g.putImageData(img, 0, 0);

  function band(x, y, w, h) {
    const x0 = ((x % size) + size) % size;
    const y0 = ((y % size) + size) % size;
    const xSplit = x0 + w > size;
    const ySplit = y0 + h > size;
    const w1 = xSplit ? size - x0 : w;
    const h1 = ySplit ? size - y0 : h;
    g.fillRect(x0, y0, w1, h1);
    if (xSplit) g.fillRect(0, y0, w - w1, h1);
    if (ySplit) g.fillRect(x0, 0, w1, h - h1);
    if (xSplit && ySplit) g.fillRect(0, 0, w - w1, h - h1);
  }

  g.fillStyle = '#c9c6be';
  for (let i = 0; i < across; i++) {
    band(i * tilePx - groutPx / 2, 0, groutPx, size);
    band(0, i * tilePx - groutPx / 2, size, groutPx);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / (across * tileMm * MM), 1 / (across * tileMm * MM));
  return tex;
}
const greyTileMap = greyTileFloorMap();

/* Rolled asphalt for the carport. One metre of charcoal binder with
   stone chips. The repeat is seamless. The soffit under Bedroom 1
   and the underside of the slab stay concrete. */
function tarmacMap() {
  const tileM = 1;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(0x7a2c0d11);

  g.fillStyle = '#6a6e74';
  g.fillRect(0, 0, size, size);

  function paintWrapped(x, y, rad, drawAt) {
    const xs = [x];
    const ys = [y];
    if (x - rad < 0) xs.push(x + size);
    if (x + rad > size) xs.push(x - size);
    if (y - rad < 0) ys.push(y + size);
    if (y + rad > size) ys.push(y - size);
    for (const sx of xs) for (const sy of ys) drawAt(sx, sy);
  }

  for (let i = 0; i < 28; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rad = size * (0.08 + rnd() * 0.16);
    const lift = (rnd() - 0.5) * 36;
    const c = 96 + lift;
    paintWrapped(x, y, rad, (sx, sy) => {
      const cloud = g.createRadialGradient(sx, sy, 0, sx, sy, rad);
      cloud.addColorStop(0, `rgba(${c | 0},${c | 0},${(c + 2) | 0},0.45)`);
      cloud.addColorStop(1, `rgba(${c | 0},${c | 0},${(c + 2) | 0},0)`);
      g.fillStyle = cloud;
      g.beginPath();
      g.arc(sx, sy, rad, 0, Math.PI * 2);
      g.fill();
    });
  }

  const stones = [
    [168, 164, 156],
    [196, 190, 176],
    [120, 118, 114],
    [78, 78, 82],
    [210, 204, 190],
    [52, 52, 56],
  ];
  for (let i = 0; i < 4200; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const chip = rnd() < 0.18;
    const rx = chip ? 3.5 + rnd() * 7 : 0.8 + rnd() * 2.2;
    const ry = rx * (0.55 + rnd() * 0.7);
    const rot = rnd() * Math.PI;
    const tone = stones[(rnd() * stones.length) | 0];
    const shade = 0.75 + rnd() * 0.5;
    g.fillStyle = `rgb(${tone[0] * shade | 0},${tone[1] * shade | 0},${tone[2] * shade | 0})`;
    paintWrapped(x, y, Math.max(rx, ry), (sx, sy) => {
      g.beginPath();
      g.ellipse(sx, sy, rx, ry, rot, 0, Math.PI * 2);
      g.fill();
    });
  }

  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ 0x51a0c0de;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      const grain = ((((n ^ (n >>> 16)) >>> 0) / 4294967296) - 0.5) * 18;
      const i = (y * size + x) * 4;
      d[i] += grain;
      d[i + 1] += grain;
      d[i + 2] += grain * 0.92;
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(1 / tileM, 1 / tileM);
  return tex;
}
const tarmacTex = tarmacMap();

const TARMAC = new Set(['carport']);
const WET_FLOOR = new Set(['wc', 'bathroom', 'ensuite-1', 'ensuite-2']);
const GREY_OAK = new Set([
  'family-dining', 'kitchen', 'utility-0', 'hall-0', 'understair-0', 'dining-patio',
]);

function realisticStyle(entry) {
  const surface = entry.room ?? entry.id;
  if (entry.kind === 'flooring' && TARMAC.has(surface)) {
    return { color: new THREE.Color(0xffffff), map: tarmacTex, roughness: 0.94 };
  }
  if (entry.kind === 'external' || entry.wall === 'external') {
    return { color: new THREE.Color(0xffffff), map: brickMap, roughness: 0.9 };
  }
  if (entry.kind === 'block' || entry.wall === 'block') {
    return { color: new THREE.Color(0xd9d3c7), map: null, roughness: 0.92 };
  }
  if (entry.kind === 'structure' || entry.kind === 'soffit'
      || (entry.kind === 'floor' && !entry.wall)) {
    return { color: new THREE.Color(0xc5c1b8), map: null, roughness: 0.96 };
  }
  if (entry.kind === 'plaster' || entry.kind === 'ceiling' || entry.wall === 'plaster') {
    const paint = entry.paint === 'sage' ? SAGE : entry.paint === 'denim' ? DENIM : ALMOND;
    return { color: new THREE.Color(paint), map: plasterMap, roughness: 0.92 };
  }
  if (entry.kind === 'cladding') {
    return { color: new THREE.Color(0xffffff), map: shiplapMap, roughness: 0.72 };
  }
  if (entry.kind === 'roof') {
    return { color: new THREE.Color(0xffffff), map: roofTileMap, roughness: 0.86 };
  }
  if (entry.kind === 'fascia' || entry.kind === 'rail' || entry.kind === 'frame') {
    return { color: new THREE.Color(0xe7e4dc), map: null, roughness: 0.55 };
  }
  if (entry.kind === 'frame-out') {
    return { color: new THREE.Color(0x3a4046), map: null, roughness: 0.42 };
  }
  if (entry.kind === 'frame-in') {
    return { color: new THREE.Color(0xf4f2ed), map: null, roughness: 0.4 };
  }
  if (entry.kind === 'glazing') {
    return { color: new THREE.Color(0xd7e7f2), map: null, roughness: 0.05 };
  }
  if (entry.kind === 'obscure') {
    return { color: new THREE.Color(0xe4edf2), map: null, roughness: 0.72 };
  }
  if (entry.kind === 'bar') {
    return { color: new THREE.Color(0x2a2e32), map: null, roughness: 0.38, metalness: 0.2 };
  }
  if (entry.kind === 'metal') {
    return { color: new THREE.Color(0xd8dbdf), map: null, roughness: 0.22, metalness: 0.88 };
  }
  if (entry.kind === 'door-out') {
    return { color: new THREE.Color(0xffffff), map: doorOutMap, roughness: 0.58 };
  }
  if (entry.kind === 'door-in') {
    return { color: new THREE.Color(0xffffff), map: doorInMap, roughness: 0.5 };
  }
  if (entry.kind === 'door') {
    return { color: new THREE.Color(0xffffff), map: greyOakMap, roughness: 0.55 };
  }
  if (entry.kind === 'flooring') {
    if (WET_FLOOR.has(entry.room)) {
      return { color: new THREE.Color(0xffffff), map: greyTileMap, roughness: 0.72 };
    }
    if (GREY_OAK.has(entry.room)) {
      return { color: new THREE.Color(0xffffff), map: greyOakMap, roughness: 0.5 };
    }
    return { color: new THREE.Color(0xffffff), map: carpetMap, roughness: 0.62 };
  }
  if (entry.kind === 'stairs') {
    return { color: new THREE.Color(0xffffff), map: carpetMap, roughness: 0.62 };
  }
  const color = new THREE.Color(ALMOND);
  if (entry.kind === 'room') color.lerp(new THREE.Color(colorOf(entry, roomIndex)), 0.18);
  return { color, map: plasterMap, roughness: 0.92 };
}

// Unweld so each face can take its own projection. Corner vertices
// otherwise share an averaged normal and the brick pattern stretches.
function bakeSurface(geometry) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = src.getAttribute('position');
  // The X mirror reverses winding, so the front side is the interior.
  // Swap each triangle and the outside faces the camera.
  for (let i = 0; i < pos.count; i += 3) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
    pos.setXYZ(i + 2, x, y, z);
  }
  const uv = new Float32Array(pos.count * 2);
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    va.fromBufferAttribute(pos, i);
    vb.fromBufferAttribute(pos, i + 1);
    vc.fromBufferAttribute(pos, i + 2);
    n.crossVectors(vb.clone().sub(va), vc.clone().sub(va));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k), y = pos.getY(i + k), z = pos.getZ(i + k);
      let u, v;
      if (az >= ax && az >= ay) { u = x; v = y; }
      else if (ax >= ay) { u = y; v = z; }
      else { u = x; v = z; }
      uv[(i + k) * 2] = u * MM;
      uv[(i + k) * 2 + 1] = v * MM;
    }
  }
  src.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  src.computeVertexNormals();
  return src;
}

// Roof tiles are sloped, so a plan projection stretches the courses.
// U runs along the ridge. V runs up the slope. The main ridge runs
// north–south; the carport ridge runs east–west.
function applySlopeUv(geometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const ridge = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.lengthSq() < 1e-8) continue;
    n.normalize();
    const h = Math.hypot(n.x, n.y);
    if (h < 1e-4) continue;
    ridge.set(-n.y / h, n.x / h, 0);
    up.crossVectors(n, ridge);
    if (up.z < 0) up.negate();
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      uv.setXY(i + k, (x * ridge.x + y * ridge.y) * MM, (x * up.x + y * up.y + z * up.z) * MM);
    }
  }
  uv.needsUpdate = true;
}

/* ---------- load model + manifest ---------- */

const loader = new GLTFLoader();
// model/ is symlinked into public/ (viewer/public/model -> ../model),
// so both dev and preview serve it at /model/.
let gltf, summary;
try {
  [gltf, summary] = await Promise.all([
    loader.loadAsync(`${BASE}/model/house.glb`),
    fetch(`${BASE}/model/house-summary.json`).then((r) => {
      if (!r.ok) throw new Error(`house-summary.json ${r.status}`);
      return r.json();
    }),
  ]);
} catch (err) {
  showFatal(err);
  throw err;
}

const manifest = summary.manifest;
const roomIndex = new Map(
  manifest.filter((e) => e.kind === 'room').map((e, i) => [e.id, i]),
);
const root = gltf.scene;
root.scale.setScalar(MM);
scene.add(root);

const byNode = new Map(manifest.map((e) => [e.node, e]));
const meshes = [];
// QA hook for smoke.mjs — module scope hides these from page.evaluate.
window.__twin = { meshes, state, camera, controls, walkControls, furniture: null, lights: null, applyLighting, refreshSunCache, LOW_POWER };
const baked = new Map();
root.traverse((o) => {
  if (!o.isMesh) return;
  if (!baked.has(o.geometry)) {
    o.geometry.scale(-1, 1, 1);
    baked.set(o.geometry, bakeSurface(o.geometry));
  }
  o.geometry = baked.get(o.geometry);
  const entry = byNode.get(o.name)
    ?? { id: o.name, kind: 'room', name: o.name, floor: 0, node: o.name };
  o.userData.entry = entry;
  if (entry.kind === 'roof') applySlopeUv(o.geometry);
  o.userData.baseColor = new THREE.Color(colorOf(entry, roomIndex));
  const real = realisticStyle(entry);
  o.userData.realColor = real.color;
  const clad = entry.kind === 'cladding';
  const frosted = entry.kind === 'obscure';
  const glass = entry.kind === 'glazing' || frosted;
  o.castShadow = !glass && !LOW_POWER;
  o.receiveShadow = !glass && !LOW_POWER;
  o.userData.blockMat = glass
    ? new THREE.MeshPhysicalMaterial({
      color: frosted ? 0xdfe7ec : 0xc5d8ea,
      roughness: frosted ? 0.55 : 0.08,
      metalness: 0,
      transmission: frosted ? 0.35 : 0.65,
      transparent: true,
      opacity: frosted ? 0.82 : 0.55,
      side: THREE.DoubleSide,
    })
    : new THREE.MeshStandardMaterial({
    color: o.userData.baseColor.clone(),
    roughness: 0.78,
    metalness: real.metalness ?? 0,
    side: THREE.FrontSide,
    polygonOffset: clad,
    polygonOffsetFactor: clad ? -2 : 0,
    polygonOffsetUnits: clad ? -2 : 0,
  });
  o.userData.realMat = glass
    ? new THREE.MeshPhysicalMaterial({
      color: real.color.clone(),
      roughness: frosted ? 0.72 : 0.05,
      metalness: 0,
      transmission: frosted ? 0.45 : 0.9,
      thickness: 0.02,
      transparent: true,
      opacity: frosted ? 0.92 : 1,
      side: THREE.DoubleSide,
    })
    : new THREE.MeshStandardMaterial({
      color: real.color.clone(),
      map: real.map,
      roughness: real.roughness,
      metalness: real.metalness ?? 0,
      side: THREE.FrontSide,
      polygonOffset: clad,
      polygonOffsetFactor: clad ? -2 : 0,
      polygonOffsetUnits: clad ? -2 : 0,
    });
  o.material = o.userData.blockMat;
  meshes.push(o);
});

// Interior paint. Real mode shows Dulux Almond White on internal walls,
// on the room side of external walls, and on ceilings. A face that looks
// into the carport keeps the exterior finish (brick on the wall, concrete
// on the soffit under Bedroom 1). The underside of the house — every
// downward face of the ground slab — is concrete, except the external
// walls, which stay brick. Blocks mode is unchanged.
// Carport stays exterior. The patio face of the house wall is outside too;
// the patio ceiling is still painted, below.
const WALL_SKIP = new Set(['carport', 'dining-patio']);
const SOFFIT = { color: new THREE.Color(0xc5c1b8), map: null, roughness: 0.96 };
const almondReal = { color: new THREE.Color(ALMOND), map: plasterMap, roughness: 0.92 };
const sageReal = { color: new THREE.Color(SAGE), map: plasterMap, roughness: 0.92 };
const denimReal = { color: new THREE.Color(DENIM), map: plasterMap, roughness: 0.92 };
const PAINT_LOOK = { almond: almondReal, sage: sageReal, denim: denimReal };

function faceRecords(geometry) {
  const pos = geometry.getAttribute('position');
  const out = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const len = n.length();
    if (len < 1e-4) continue;
    n.multiplyScalar(1 / len);
    out.push({
      i,
      nx: n.x, ny: n.y, nz: n.z,
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
      z: (a.z + b.z + c.z) / 3,
    });
  }
  return out;
}

function subsetGeometry(geometry, faces) {
  if (!faces.length) return null;
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const newPos = new Float32Array(faces.length * 9);
  const newUv = uv ? new Float32Array(faces.length * 6) : null;
  let p = 0;
  let u = 0;
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      newPos[p++] = pos.getX(f.i + k);
      newPos[p++] = pos.getY(f.i + k);
      newPos[p++] = pos.getZ(f.i + k);
      if (newUv) {
        newUv[u++] = uv.getX(f.i + k);
        newUv[u++] = uv.getY(f.i + k);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  if (newUv) g.setAttribute('uv', new THREE.BufferAttribute(newUv, 2));
  g.computeVertexNormals();
  return g;
}

function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const den = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(den) < 1e-8) return false;
  const inv = 1 / den;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -1e-4 && v >= -1e-4 && (u + v) <= 1 + 1e-4;
}

const roomTris = new Map();
for (const m of meshes) {
  const e = m.userData.entry;
  if (e.kind !== 'flooring' || !e.room) continue;
  const tops = faceRecords(m.geometry).filter((f) => f.nz > 0.9);
  const list = roomTris.get(e.floor) ?? [];
  for (const f of tops) {
    const pos = m.geometry.getAttribute('position');
    list.push({
      room: e.room,
      ax: pos.getX(f.i), ay: pos.getY(f.i),
      bx: pos.getX(f.i + 1), by: pos.getY(f.i + 1),
      cx: pos.getX(f.i + 2), cy: pos.getY(f.i + 2),
    });
  }
  roomTris.set(e.floor, list);
}

function roomAt(floor, x, y) {
  for (const t of roomTris.get(floor) ?? []) {
    if (pointInTri(x, y, t.ax, t.ay, t.bx, t.by, t.cx, t.cy)) return t.room;
  }
  return null;
}

// Mesh X is mirrored (layout x = -mesh x). The main shell's inner face
// is the 300mm inset of the 4820×9380 ring. Stair voids are inside this
// box even though they are not a room slab, so the inner face of the
// shell paints as one surface instead of per triangle.
function insideMain(x, y) {
  const layoutX = -x;
  return layoutX >= 300 && layoutX <= 4520 && y >= 300 && y <= 9080;
}

// A storey-tall wall quad is two triangles. Classifying each by its
// centroid paints one half and leaves the other brick, with the split
// running along the diagonal. Subdivide until the paint follows the
// room edge.
const PAINT_CELL = 200;

function faceClass(floor, nx, ny, x, y) {
  const room = roomAt(floor, x + nx * 50, y + ny * 50);
  if (room && WALL_SKIP.has(room)) return 'brick';
  if (room) return 'paint';
  if (insideMain(x + nx * 50, y + ny * 50)) return 'paint';
  return 'brick';
}

// Feature walls. Mesh X is mirrored, so a face normal of +X points west
// in the plan: that face is the east wall of the room it looks into.
function paintStyle(floor, n, x, y) {
  if (faceClass(floor, n.x, n.y, x, y) === 'brick') return 'brick';
  if (n.x > 0.7) {
    const room = roomAt(floor, x + n.x * 50, y + n.y * 50);
    if (floor === 0 && room === 'study') return 'sage';
    if (floor === 1 && room === 'lounge') return 'denim';
  }
  return 'almond';
}

// Plaster is a 12.5mm board. The face that looks into a room is the
// painted side. The stud or cavity face is dropped, so a camera on that
// side sees through the board. Top and bottom stay, so the plan still
// shows the wall. A soffit board (the patio head) keeps only its
// underside. The patio wrap faces the dining patio, which the house
// wall itself treats as outside.
function plasterRoomSide(floor, nx, ny, nz, x, y, opts) {
  if (Math.abs(nz) > 0.7) return opts?.undersideOnly ? nz < -0.7 : true;
  if (Math.abs(nx) < 0.7 && Math.abs(ny) < 0.7) return false;
  const skip = opts?.skip ?? WALL_SKIP;
  const occupied = (px, py) => {
    const room = roomAt(floor, px, py);
    return Boolean(room) && !skip.has(room);
  };
  if (occupied(x + nx * 25, y + ny * 25)) return true;
  // Stairwell: further along the normal is still open shell. A cavity
  // face is only ~90mm from the room on the other side of the stud,
  // so the same step lands in that room and this face is dropped.
  if (!occupied(x + nx * 120, y + ny * 120) && insideMain(x + nx * 120, y + ny * 120)) return true;
  if (occupied(x - nx * 25, y - ny * 25)) return false;
  // Stair void: this side is open shell, and the far probe would only
  // hit a room if the normal pointed back across the stud.
  if (occupied(x + nx * 150, y + ny * 150)) return false;
  return insideMain(x + nx * 25, y + ny * 25);
}

function midpt(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function edgeLen(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function classifyTris(floor, n, a, b, c, depth, buckets) {
  const ca = paintStyle(floor, n, a.x, a.y);
  const cb = paintStyle(floor, n, b.x, b.y);
  const cc = paintStyle(floor, n, c.x, c.y);
  const longest = Math.max(edgeLen(a, b), edgeLen(b, c), edgeLen(c, a));
  if ((ca === cb && cb === cc) || longest < PAINT_CELL || depth > 10) {
    const cls = (ca === cb && cb === cc)
      ? ca
      : paintStyle(floor, n, (a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3);
    (buckets[cls] ?? (buckets[cls] = [])).push([a, b, c]);
    return;
  }
  const ab = midpt(a, b);
  const bc = midpt(b, c);
  const ac = midpt(c, a);
  classifyTris(floor, n, a, ab, ac, depth + 1, buckets);
  classifyTris(floor, n, ab, b, bc, depth + 1, buckets);
  classifyTris(floor, n, ac, bc, c, depth + 1, buckets);
  classifyTris(floor, n, ab, bc, ac, depth + 1, buckets);
}

function uvOf(v, n) {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const u = az >= ax && az >= ay ? v.x : ax >= ay ? v.y : v.x;
  const t = az >= ax && az >= ay ? v.y : ax >= ay ? v.z : v.z;
  return [u * MM, t * MM];
}

function trisGeometry(tris) {
  if (!tris.length) return null;
  const pos = new Float32Array(tris.length * 9);
  const uv = new Float32Array(tris.length * 6);
  let p = 0;
  let u = 0;
  const n = { x: 0, y: 0, z: 0 };
  for (const [a, b, c] of tris) {
    n.x = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    n.y = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    n.z = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (const v of [a, b, c]) {
      pos[p++] = v.x;
      pos[p++] = v.y;
      pos[p++] = v.z;
      const st = uvOf(v, n);
      uv[u++] = st[0];
      uv[u++] = st[1];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function attachTwin(source, geometry, entry, real) {
  const mesh = new THREE.Mesh(geometry);
  mesh.position.copy(source.position);
  mesh.quaternion.copy(source.quaternion);
  mesh.scale.copy(source.scale);
  mesh.name = `${source.name}-paint`;
  mesh.userData.entry = entry;
  mesh.userData.baseColor = entry.kind === 'ceiling'
    ? new THREE.Color(ALMOND)
    : new THREE.Color(colorOf(entry, roomIndex));
  mesh.userData.realColor = real.color.clone();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.blockMat = new THREE.MeshStandardMaterial({
    color: mesh.userData.baseColor.clone(),
    roughness: 0.78,
    metalness: 0,
    side: THREE.FrontSide,
  });
  mesh.userData.realMat = new THREE.MeshStandardMaterial({
    color: real.color.clone(),
    map: real.map,
    roughness: real.roughness,
    metalness: 0,
    side: THREE.FrontSide,
    polygonOffset: entry.kind === 'ceiling',
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  mesh.material = mesh.userData.blockMat;
  source.parent.add(mesh);
  meshes.push(mesh);
  return mesh;
}

const twins = [];
for (const m of meshes) {
  const e = m.userData.entry;
  const src = m.geometry;
  const faces = faceRecords(src);
  if (e.kind === 'external') {
    const posAttr = src.getAttribute('position');
    const buckets = { brick: [] };
    for (const f of faces) {
      const a = { x: posAttr.getX(f.i), y: posAttr.getY(f.i), z: posAttr.getZ(f.i) };
      const b = { x: posAttr.getX(f.i + 1), y: posAttr.getY(f.i + 1), z: posAttr.getZ(f.i + 1) };
      const c = { x: posAttr.getX(f.i + 2), y: posAttr.getY(f.i + 2), z: posAttr.getZ(f.i + 2) };
      if (Math.abs(f.nz) >= 0.7) buckets.brick.push([a, b, c]);
      else classifyTris(e.floor, { x: f.nx, y: f.ny, z: f.nz }, a, b, c, 0, buckets);
    }
    const painted = Object.entries(buckets).filter(([style, tris]) => style !== 'brick' && tris.length);
    if (painted.length) {
      m.geometry = trisGeometry(buckets.brick) ?? new THREE.BufferGeometry();
      for (const [style, tris] of painted) {
        twins.push([m, trisGeometry(tris), e, PAINT_LOOK[style]]);
      }
    }
  } else if (e.kind === 'plaster') {
    // The patio wrap is an internal board. The dining patio is the room
    // it faces, and the head is a soffit, so only the underside is painted.
    const wrap = e.id === 'patio-head-plaster' || /^patio-jamb-[we]-plaster$/.test(e.id);
    const opts = wrap
      ? { skip: new Set(['carport']), undersideOnly: e.id === 'patio-head-plaster' }
      : undefined;
    const keep = faces.filter((f) => plasterRoomSide(e.floor, f.nx, f.ny, f.nz, f.x, f.y, opts));
    if (keep.length && keep.length < faces.length) m.geometry = subsetGeometry(src, keep);
  } else if (e.kind === 'ceiling' || e.kind === 'soffit') {
    // The board sits on the ceiling plane. Only the underside faces the
    // room, so a camera above the board sees through it. The carport's
    // masonry soffit is its ceiling, so it behaves the same way.
    const underside = faces.filter((f) => f.nz < -0.7);
    if (underside.length && underside.length < faces.length) m.geometry = subsetGeometry(src, underside);
  } else if (e.kind === 'flooring') {
    // The finish is the top face only. Edges and the underside are
    // dropped, so a camera below the sheet sees through it.
    const top = faces.filter((f) => f.nz > 0.7);
    if (top.length && top.length < faces.length) m.geometry = subsetGeometry(src, top);
  } else if (e.kind === 'stairs') {
    const soffit = faces.filter((f) => f.nz < -0.9);
    if (soffit.length && soffit.length < faces.length) {
      m.geometry = subsetGeometry(src, faces.filter((f) => f.nz >= -0.9));
      twins.push([m, subsetGeometry(src, soffit), { ...e, id: `${e.id}-soffit` }, almondReal]);
    }
  } else if (e.kind === 'floor' && e.floor === 0 && e.wall !== 'external') {
    const underside = faces.filter((f) => f.nz < -0.9);
    if (underside.length && underside.length < faces.length) {
      m.geometry = subsetGeometry(src, faces.filter((f) => f.nz >= -0.9));
      twins.push([m, subsetGeometry(src, underside), { ...e, id: `${e.id}-underside` }, SOFFIT]);
    }
  }
}
for (const [source, geometry, entry, real] of twins) {
  if (geometry) attachTwin(source, geometry, entry, real);
}

// Room-scoped Hue lighting with portal leakage (see layers.js / portals.js).
// Walls block (coupling 0 with no opening path); doors/windows/openings/stairs
// attenuate spill into neighbours. Exterior shell (no room) gets no Hue.
// Carport / patio are exterior rooms — only receive Hue via real openings
// (e.g. family west window → carport). Sun/moon Directional + hemi/IBL remain.
function inferMeshTwinRoom(m) {
  const e = m.userData.entry;
  let room = twinRoomForEntry(e, m.name);
  if (room) return room;
  // Carport soffit under Bedroom 1 (no 'carport' in id).
  if (e?.id === 'soffit-f1' || m.name === 'soffit-f1') return 'carport';
  if (e?.id === 'soffit-f2' || m.name === 'soffit-f2') return null;
  // Untagged interior (ext-wall paint twins, stair plaster): probe flooring.
  if (!isInteriorSurface(e, m.name)) return null;
  const g = m.geometry;
  if (!g?.attributes?.position) {
    if (/stair/.test(`${e?.id || ''} ${m.name || ''}`)) {
      const f = e?.floor ?? 0;
      return f === 0 ? 'hall-0' : f === 1 ? 'landing-1' : 'landing-2';
    }
    return null;
  }
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const floor = e?.floor ?? 0;
  const tryAt = (x, y) => {
    const hit = roomAt(floor, x, y);
    return hit && !EXTERIOR_ROOMS.has(hit) ? hit : null;
  };
  let hit = tryAt(cx, cy);
  if (hit) return hit;
  for (const [dx, dy] of [[60, 0], [-60, 0], [0, 60], [0, -60], [120, 0], [-120, 0], [0, 120], [0, -120]]) {
    hit = tryAt(cx + dx, cy + dy);
    if (hit) return hit;
  }
  if (/stair/.test(`${e?.id || ''} ${m.name || ''}`)) {
    return floor === 0 ? 'hall-0' : floor === 1 ? 'landing-1' : 'landing-2';
  }
  return null;
}

for (const m of meshes) {
  const room = inferMeshTwinRoom(m);
  m.userData.twinRoom = room;
  if (m.userData.entry && room && !m.userData.entry.room) {
    // Keep entry immutable-ish; room lives on userData for lighting.
  }
  if (m.userData.realMat) scopeMaterialToRoom(m.userData.realMat, room);
}

state.meshes = meshes;
state.bounds = new THREE.Box3().setFromObject(root);

// Unselected orbit pivots on the house, not the plan origin (the patio end).
const homeCenter = state.bounds.getCenter(new THREE.Vector3());
function lookAtHouse() {
  const delta = homeCenter.clone().sub(controls.target);
  controls.target.copy(homeCenter);
  camera.position.add(delta);
}

/* ---------- selection / floor filter ---------- */

function applyFilter() {
  for (const m of meshes) {
    const e = m.userData.entry;
    const onFloor = state.floor === 'all' || e.floor === state.floor;
    // The front shiplap is part of the external skin — it hides with the
    // external walls, not as a kind of its own.
    const shellKind = e.kind === 'block' ? 'external'
      : e.kind === 'plaster' ? 'internal'
      : e.kind === 'cladding' ? 'external' : e.kind;
    const wallOn = (shellKind !== 'external' && shellKind !== 'internal') || state.walls[shellKind];
    // Room volumes are the coloured blocks. Real mode shows the building
    // shell only, so that toggle does not apply there.
    // Walk hides the translucent room volumes so you can see the shell.
    const roomsOn = state.look === 'blocks' && state.show.room && state.mode !== 'walk';
    // Plaster and ceilings share a face with the room blocks. Hide them
    // while those blocks are showing so the two surfaces do not fight.
    const layerOn = e.kind === 'room' ? roomsOn
      : e.kind === 'ceiling' || e.kind === 'plaster' || e.kind === 'soffit' ? !roomsOn
      : e.kind === 'roof' || e.kind === 'fascia' ? state.show.roof
      : e.kind === 'flooring' ? state.show.flooring
      // Doors and windows are many mesh kinds (leaf, frame, glazing,
      // hardware) — the manifest's group field says which toggle owns them.
      : e.group ? state.show[e.group]
      : (e.kind !== 'floor' && e.kind !== 'structure' && e.kind !== 'soffit') || state.show.floor;
    // The plan view stays a floor plan. The pitched roofs would cover it.
    const shellOn = state.mode !== '2d' || (e.kind !== 'roof' && e.kind !== 'fascia');
    m.visible = onFloor && wallOn && layerOn && shellOn;
    const blocks = state.look === 'blocks';
    const mat = blocks ? m.userData.blockMat : m.userData.realMat;
    m.material = mat;
    if (blocks) {
      mat.color.copy(m.userData.baseColor);
      mat.emissive.setHex(0x000000);
    } else {
      mat.color.copy(m.userData.realColor);
      mat.emissive.setHex(0x000000);
    }
  }
  window.__twin?.furniture?.applyVisibility?.();
  window.__twin?.lights?.applyVisibility?.();
}

// Floor / external-wall settings to restore when a room focus is cleared.
let focusRestore = null;

function syncFloorButtons() {
  for (const x of floorSeg.children)
    x.classList.toggle('active', x.dataset.floor === String(state.floor));
}

function syncWallButtons() {
  for (const x of wallSeg.children) {
    if (!x.dataset.wall) continue;
    const on = !!state.walls[x.dataset.wall];
    x.classList.toggle('active', on);
    x.setAttribute('aria-pressed', String(on));
  }
}

function clearRoomFocus() {
  state.selected = null;
  if (focusRestore) {
    state.floor = focusRestore.floor;
    state.walls.external = focusRestore.external;
    focusRestore = null;
    syncFloorButtons();
    syncWallButtons();
  }
  applyFilter();
  renderRoomList();
  setStatus('');
  if (state.mode === '3d') lookAtHouse();
  else if (state.mode === '2d') fit2d();
}

function focusRoom(entry, { frame = true } = {}) {
  state.selected = entry;
  // Mobile drawer: picking a room dismisses the sheet.
  if (window.matchMedia('(max-width: 800px)').matches) setRoomsOpen(false);
  if (entry.kind === 'room') {
    if (focusRestore == null) {
      focusRestore = { floor: state.floor, external: state.walls.external };
    }
    // Show only this storey so floors above do not sit in the way.
    if (state.floor !== entry.floor) {
      state.floor = entry.floor;
      syncFloorButtons();
    }
    // Drop the external shell so the room is open to the camera.
    if (state.walls.external) {
      state.walls.external = false;
      syncWallButtons();
    }
  }
  applyFilter();
  renderRoomList();
  setStatus(`<b>${entry.name}</b> · ${entry.id} · floor ${entry.floor}`);
  // Keep the current orbit angle and zoom; only slide the pivot.
  if (!frame || entry.kind !== 'room') return;
  const m = meshes.find((x) => x.userData.entry.id === entry.id);
  if (!m) return;
  const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
  if (state.mode === '3d') {
    const delta = c.clone().sub(controls.target);
    controls.target.copy(c);
    camera.position.add(delta);
  } else if (state.mode === '2d') {
    const worldPerPx = (camera2d.top - camera2d.bottom) / view3d.clientHeight;
    const cx = c.x + (sidebarOffsetPx() / 2) * worldPerPx;
    const cy = c.y;
    camera2d.position.set(cx, cy, 100);
    camera2d.lookAt(cx, cy, 0);
  }
}

/* ---------- 2D mode ---------- */

function fit2d() {
  // Frame the visible meshes only (floor isolation), else the whole house.
  const b = new THREE.Box3();
  let any = false;
  for (const m of meshes) {
    if (!m.visible) continue;
    b.expandByObject(m);
    any = true;
  }
  if (!any) return;
  const w = (b.max.x - b.min.x) * 1.08, h = (b.max.y - b.min.y) * 1.08;
  const aspect = view3d.clientWidth / view3d.clientHeight || 1;
  const halfH = Math.max(h / 2, (w / 2) / aspect);
  // Centre in the VISIBLE area: the sidebar overlays the left ~232px.
  const worldPerPx = (2 * halfH) / view3d.clientHeight;
  const cx = (b.min.x + b.max.x) / 2 + (sidebarOffsetPx() / 2) * worldPerPx;
  const cy = (b.min.y + b.max.y) / 2;
  camera2d.left = -halfH * aspect;
  camera2d.right = halfH * aspect;
  camera2d.top = halfH;
  camera2d.bottom = -halfH;
  camera2d.position.set(cx, cy, 100);
  camera2d.lookAt(cx, cy, 0);
  camera2d.updateProjectionMatrix();
}

/* ---------- walk mode (Z-up first person) ---------- */

const EYE_HEIGHT = 1.6;
const WALK_SPEED = 3.2;          // m/s
const PLAYER_RADIUS = 0.22;
const WALL_KINDS = new Set(['plaster', 'block', 'external']);
const FLOOR_KINDS = new Set(['floor', 'flooring', 'stairs']);
// Chest-height probes (metres above the feet) for horizontal collision.
const COLLIDE_HEIGHTS = [0.45, 1.15];

const orbitSave = {
  pos: new THREE.Vector3(),
  target: new THREE.Vector3(),
};
let walkYaw = 0;    // rad around +Z; 0 looks toward −Y (north / rear)
let walkPitch = 0;  // rad; + looks up
const walkKeys = Object.create(null);
const walkRay = new THREE.Raycaster();
const _walkDir = new THREE.Vector3();
const _walkRight = new THREE.Vector3();
const _walkWish = new THREE.Vector3();
const _walkLook = new THREE.Vector3();
const _walkOrigin = new THREE.Vector3();
const _walkDown = new THREE.Vector3(0, 0, -1);

function wallMeshes() {
  return meshes.filter((m) => WALL_KINDS.has(m.userData.entry?.kind));
}
function floorMeshes() {
  return meshes.filter((m) => FLOOR_KINDS.has(m.userData.entry?.kind));
}

function applyWalkLook() {
  // Yaw around world Z, pitch around local right. camera.up stays +Z.
  const cp = Math.cos(walkPitch);
  const sp = Math.sin(walkPitch);
  const cy = Math.cos(walkYaw);
  const sy = Math.sin(walkYaw);
  _walkLook.set(sy * cp, -cy * cp, sp);
  camera.up.set(0, 0, 1);
  camera.lookAt(
    camera.position.x + _walkLook.x,
    camera.position.y + _walkLook.y,
    camera.position.z + _walkLook.z,
  );
}

function blockedMove(fromX, fromY, dx, dy) {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-8) return false;
  _walkDir.set(dx / dist, dy / dist, 0);
  const reach = dist + PLAYER_RADIUS;
  const feetZ = camera.position.z - EYE_HEIGHT;
  const walls = wallMeshes();
  for (const h of COLLIDE_HEIGHTS) {
    _walkOrigin.set(fromX, fromY, feetZ + h);
    walkRay.near = 0;
    walkRay.far = reach;
    walkRay.set(_walkOrigin, _walkDir);
    const hit = walkRay.intersectObjects(walls, false)[0];
    if (hit && hit.distance < reach) return true;
  }
  return false;
}

function tryWalkMove(dx, dy) {
  const x0 = camera.position.x;
  const y0 = camera.position.y;
  // Slide: try full, then each axis alone.
  if (!blockedMove(x0, y0, dx, dy)) {
    camera.position.x = x0 + dx;
    camera.position.y = y0 + dy;
    return;
  }
  if (dx && !blockedMove(x0, y0, dx, 0)) camera.position.x = x0 + dx;
  if (dy && !blockedMove(x0, y0, 0, dy)) camera.position.y = y0 + dy;
}

function snapWalkToFloor() {
  // Cast from above the eyes down onto floor / stairs / flooring.
  _walkOrigin.set(camera.position.x, camera.position.y, camera.position.z + 0.35);
  walkRay.near = 0;
  walkRay.far = EYE_HEIGHT + 3.0;
  walkRay.set(_walkOrigin, _walkDown);
  const hit = walkRay.intersectObjects(floorMeshes(), false)[0];
  if (hit) camera.position.z = hit.point.z + EYE_HEIGHT;
}

function prefersTouchWalk() {
  // Tablets / phones: coarse pointer or no hover. Pointer Lock is unreliable
  // on iOS Safari, so these devices get on-screen stick + touch look.
  return window.matchMedia('(pointer: coarse)').matches
    || window.matchMedia('(hover: none)').matches;
}

const TOUCH_LOOK_SENS = 0.005;   // rad / css-pixel (finger)
const STICK_DEADZONE = 0.12;
const STICK_MAX_PX = 40;         // knob travel radius inside the 112px pad

const walkStick = {
  active: false,
  x: 0,   // −1..1, + = strafe right
  y: 0,   // −1..1, + = screen-down = move backward
};
let lookTouchId = null;
let lookLastX = 0;
let lookLastY = 0;
let stickTouchId = null;
let walkHintTimer = 0;

const walkHudEl = document.getElementById('walk-hud');
const walkHintEl = document.getElementById('walk-hint');
const walkStickEl = document.getElementById('walk-stick');
const walkKnobEl = document.getElementById('walk-stick-knob');

function setStickVisual(nx, ny) {
  // nx/ny in −1..1; screen y+ is down, matching stick.y.
  walkKnobEl.style.transform = `translate(${nx * STICK_MAX_PX}px, ${ny * STICK_MAX_PX}px)`;
}

function resetStick() {
  walkStick.active = false;
  walkStick.x = 0;
  walkStick.y = 0;
  stickTouchId = null;
  setStickVisual(0, 0);
}

function resetLookTouch() {
  lookTouchId = null;
}

function syncWalkHud() {
  const touch = state.mode === 'walk' && prefersTouchWalk();
  document.body.classList.toggle('walk-mode', state.mode === 'walk');
  document.body.classList.toggle('walk-touch', touch);
  walkHudEl.setAttribute('aria-hidden', touch ? 'false' : 'true');
  if (touch) {
    walkHintEl.classList.remove('fade');
    clearTimeout(walkHintTimer);
    walkHintTimer = setTimeout(() => walkHintEl.classList.add('fade'), 4000);
  } else {
    clearTimeout(walkHintTimer);
    walkHintEl.classList.remove('fade');
  }
}

function enterWalk() {
  orbitSave.pos.copy(camera.position);
  orbitSave.target.copy(controls.target);
  controls.enabled = false;

  const hall = meshes.find((m) => m.userData.entry?.id === 'hall-0');
  if (hall) {
    const c = new THREE.Box3().setFromObject(hall).getCenter(new THREE.Vector3());
    camera.position.set(c.x, c.y, FLOOR_Z[0] * MM + EYE_HEIGHT);
  } else {
    camera.position.set(homeCenter.x, homeCenter.y, FLOOR_Z[0] * MM + EYE_HEIGHT);
  }
  walkYaw = 0;
  walkPitch = 0;
  applyWalkLook();
  snapWalkToFloor();
  resetStick();
  resetLookTouch();
  syncWalkHud();
  if (prefersTouchWalk()) {
    setStatus('Drag to look · stick to move');
  } else {
    setStatus('Click the view to look · WASD move · Esc release · furniture drag off');
  }
}

function exitWalk() {
  if (walkControls.isLocked) walkControls.unlock();
  for (const k of Object.keys(walkKeys)) walkKeys[k] = false;
  resetStick();
  resetLookTouch();
  document.body.classList.remove('walk-mode', 'walk-touch');
  walkHudEl.setAttribute('aria-hidden', 'true');
  clearTimeout(walkHintTimer);
  camera.up.set(0, 0, 1);
  camera.position.copy(orbitSave.pos);
  controls.target.copy(orbitSave.target);
  controls.enabled = true;
  controls.update();
}

function updateWalk(dt) {
  // Desktop: move only while pointer-locked. Touch: stick drives move
  // without needing Pointer Lock (unreliable / absent on iOS).
  const forward = (walkKeys.KeyW || walkKeys.ArrowUp ? 1 : 0)
    - (walkKeys.KeyS || walkKeys.ArrowDown ? 1 : 0)
    - walkStick.y;
  const strafe = (walkKeys.KeyD || walkKeys.ArrowRight ? 1 : 0)
    - (walkKeys.KeyA || walkKeys.ArrowLeft ? 1 : 0)
    + walkStick.x;
  const stickMag = Math.hypot(walkStick.x, walkStick.y);
  const allowMove = walkControls.isLocked || stickMag > STICK_DEADZONE
    || (prefersTouchWalk() && (forward || strafe));
  if (allowMove && (forward || strafe)) {
    // Horizontal look basis (ignore pitch so movement stays level).
    _walkDir.set(Math.sin(walkYaw), -Math.cos(walkYaw), 0);
    _walkRight.set(Math.cos(walkYaw), Math.sin(walkYaw), 0);
    _walkWish.set(0, 0, 0)
      .addScaledVector(_walkDir, forward)
      .addScaledVector(_walkRight, strafe);
    if (_walkWish.lengthSq() > 1e-8) {
      _walkWish.normalize().multiplyScalar(WALK_SPEED * dt);
      tryWalkMove(_walkWish.x, _walkWish.y);
    }
  }
  snapWalkToFloor();
}

document.addEventListener('keydown', (ev) => {
  if (state.mode !== 'walk') return;
  if (ev.code in walkKeys || ev.code.startsWith('Key') || ev.code.startsWith('Arrow')) {
    walkKeys[ev.code] = true;
  }
  // Avoid page scroll / browser shortcuts while locked or on touch walk.
  if ((walkControls.isLocked || prefersTouchWalk()) && (
    ev.code === 'KeyW' || ev.code === 'KeyA' || ev.code === 'KeyS' || ev.code === 'KeyD'
    || ev.code.startsWith('Arrow') || ev.code === 'Space'
  )) ev.preventDefault();
});
document.addEventListener('keyup', (ev) => {
  walkKeys[ev.code] = false;
});

document.addEventListener('mousemove', (ev) => {
  if (state.mode !== 'walk' || !walkControls.isLocked) return;
  walkYaw -= ev.movementX * 0.0025;
  walkPitch -= ev.movementY * 0.0025;
  const lim = Math.PI / 2 - 0.05;
  walkPitch = Math.max(-lim, Math.min(lim, walkPitch));
  applyWalkLook();
});

walkControls.addEventListener('lock', () => {
  if (state.mode === 'walk' && !prefersTouchWalk()) {
    setStatus('WASD move · mouse look · Esc release');
  }
});
walkControls.addEventListener('unlock', () => {
  if (state.mode === 'walk' && !prefersTouchWalk()) {
    setStatus('Click the view to look · WASD move · Esc release');
  }
});

/* ---- touch look (one-finger drag on the canvas) ---- */
function onLookTouchStart(ev) {
  if (state.mode !== 'walk') return;
  // Ignore touches that began on the joystick.
  for (const t of ev.changedTouches) {
    if (stickTouchId !== null && t.identifier === stickTouchId) continue;
    if (lookTouchId === null) {
      lookTouchId = t.identifier;
      lookLastX = t.clientX;
      lookLastY = t.clientY;
      ev.preventDefault();
      return;
    }
  }
}
function onLookTouchMove(ev) {
  if (state.mode !== 'walk' || lookTouchId === null) return;
  for (const t of ev.changedTouches) {
    if (t.identifier !== lookTouchId) continue;
    const dx = t.clientX - lookLastX;
    const dy = t.clientY - lookLastY;
    lookLastX = t.clientX;
    lookLastY = t.clientY;
    walkYaw -= dx * TOUCH_LOOK_SENS;
    walkPitch -= dy * TOUCH_LOOK_SENS;
    const lim = Math.PI / 2 - 0.05;
    walkPitch = Math.max(-lim, Math.min(lim, walkPitch));
    applyWalkLook();
    ev.preventDefault();
    return;
  }
}
function onLookTouchEnd(ev) {
  for (const t of ev.changedTouches) {
    if (t.identifier === lookTouchId) {
      lookTouchId = null;
      return;
    }
  }
}
renderer.domElement.addEventListener('touchstart', onLookTouchStart, { passive: false });
renderer.domElement.addEventListener('touchmove', onLookTouchMove, { passive: false });
renderer.domElement.addEventListener('touchend', onLookTouchEnd);
renderer.domElement.addEventListener('touchcancel', onLookTouchEnd);

/* ---- virtual joystick ---- */
function stickFromEvent(t) {
  const r = walkStickEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let dx = t.clientX - cx;
  let dy = t.clientY - cy;
  const len = Math.hypot(dx, dy) || 1;
  const max = STICK_MAX_PX;
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  let nx = dx / max;
  let ny = dy / max;
  const mag = Math.hypot(nx, ny);
  if (mag < STICK_DEADZONE) { nx = 0; ny = 0; }
  walkStick.x = nx;
  walkStick.y = ny;
  setStickVisual(nx, ny);
}

function onStickStart(ev) {
  if (state.mode !== 'walk') return;
  const t = ev.changedTouches[0];
  if (!t) return;
  stickTouchId = t.identifier;
  walkStick.active = true;
  // Don't also treat this as a look drag.
  if (lookTouchId === stickTouchId) lookTouchId = null;
  stickFromEvent(t);
  ev.preventDefault();
  ev.stopPropagation();
}
function onStickMove(ev) {
  if (!walkStick.active || stickTouchId === null) return;
  for (const t of ev.changedTouches) {
    if (t.identifier !== stickTouchId) continue;
    stickFromEvent(t);
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
}
function onStickEnd(ev) {
  for (const t of ev.changedTouches) {
    if (t.identifier === stickTouchId) {
      resetStick();
      ev.preventDefault();
      return;
    }
  }
}
walkStickEl.addEventListener('touchstart', onStickStart, { passive: false });
walkStickEl.addEventListener('touchmove', onStickMove, { passive: false });
walkStickEl.addEventListener('touchend', onStickEnd, { passive: false });
walkStickEl.addEventListener('touchcancel', onStickEnd, { passive: false });

/* ---------- UI ---------- */

const btn3d = document.getElementById('btn-3d');
const btn2d = document.getElementById('btn-2d');
const btnWalk = document.getElementById('btn-walk');
const lookSeg = document.getElementById('look-seg');
const floorSeg = document.getElementById('floor-seg');
const wallSeg = document.getElementById('wall-seg');
const showSeg = document.getElementById('show-seg');
const showMenu = document.getElementById('show-menu');
const btnShow = document.getElementById('btn-show');
const btnRooms = document.getElementById('btn-rooms');
const btnRoomsClose = document.getElementById('btn-rooms-close');
const roomsBackdrop = document.getElementById('rooms-backdrop');
const roomsEl = document.getElementById('rooms-body') || document.getElementById('rooms');
const statusEl = document.getElementById('status');

function setRoomsOpen(open) {
  if (state.mode === 'walk') open = false;
  document.body.classList.toggle('rooms-open', !!open);
  btnRooms?.setAttribute('aria-expanded', String(!!open));
  if (roomsBackdrop) roomsBackdrop.hidden = !open;
}

function setShowMenuOpen(open) {
  showMenu?.classList.toggle('open', !!open);
  btnShow?.setAttribute('aria-expanded', String(!!open));
}

function closeChromeMenus() {
  setRoomsOpen(false);
  setShowMenuOpen(false);
}

btnRooms?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const next = !document.body.classList.contains('rooms-open');
  setShowMenuOpen(false);
  setRoomsOpen(next);
});
btnRoomsClose?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  setRoomsOpen(false);
});
roomsBackdrop?.addEventListener('click', () => setRoomsOpen(false));

btnShow?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const next = !showMenu.classList.contains('open');
  setRoomsOpen(false);
  setShowMenuOpen(next);
});
showSeg?.addEventListener('click', (ev) => ev.stopPropagation());

document.addEventListener('click', (ev) => {
  if (showMenu && !showMenu.contains(ev.target)) setShowMenuOpen(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeChromeMenus();
});
window.addEventListener('resize', () => {
  // Crossing the desktop/mobile breakpoint: force drawer closed so we don't
  // leave a phantom rooms-open state on wide screens.
  if (!window.matchMedia('(max-width: 800px)').matches) setRoomsOpen(false);
});

function setMode(mode) {
  const prev = state.mode;
  if (prev === 'walk' && mode !== 'walk') exitWalk();
  state.mode = mode;
  applyLighting();
  btn3d.classList.toggle('active', mode === '3d');
  btn2d.classList.toggle('active', mode === '2d');
  btnWalk.classList.toggle('active', mode === 'walk');
  if (mode === 'walk') closeChromeMenus();
  applyFilter();
  if (mode === 'walk') enterWalk();
  else if (mode === '2d') fit2d();
  onResize();
}
btn3d.addEventListener('click', () => setMode('3d'));
btn2d.addEventListener('click', () => setMode('2d'));
btnWalk.addEventListener('click', () => setMode('walk'));

function syncShowControls() {
  const roomsBtn = showSeg.querySelector('[data-show="room"]');
  const roomsLocked = state.look === 'real';
  roomsBtn.disabled = roomsLocked;
  roomsBtn.classList.toggle('active', !roomsLocked && state.show.room);
  roomsBtn.setAttribute('aria-pressed', String(!roomsLocked && state.show.room));
  roomsBtn.title = roomsLocked ? 'Room blocks are hidden in Real' : '';

  // Furniture and Hue lights only belong in Real mode.
  for (const kind of ['furniture', 'lights']) {
    const btn = showSeg.querySelector(`[data-show="${kind}"]`);
    if (!btn) continue;
    const locked = state.look === 'blocks';
    btn.disabled = locked;
    btn.classList.toggle('active', !locked && state.show[kind]);
    btn.setAttribute('aria-pressed', String(!locked && state.show[kind]));
    btn.title = locked
      ? (kind === 'lights' ? 'Lights are hidden in Blocks' : 'Furniture is hidden in Blocks')
      : '';
  }

  // Time-of-day override only makes sense in Real mode.
  const tod = document.getElementById('tod-seg');
  if (tod) {
    tod.hidden = state.look !== 'real';
    syncTodLabel();
  }
}

function londonHourNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hh + mm / 60;
}

function syncTodLabel() {
  const label = document.getElementById('tod-label');
  const liveBtn = document.getElementById('tod-live');
  const slider = document.getElementById('tod-slider');
  if (!label || !slider) return;
  if (state.timeHour == null) {
    label.textContent = formatLondonHM(new Date());
    if (liveBtn) liveBtn.classList.add('active');
    if (document.activeElement !== slider) slider.value = String(londonHourNow());
  } else {
    const h = Math.floor(state.timeHour) % 24;
    const m = Math.round((state.timeHour - Math.floor(state.timeHour)) * 60) % 60;
    label.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (liveBtn) liveBtn.classList.remove('active');
    if (document.activeElement !== slider) slider.value = String(state.timeHour);
  }
}

lookSeg.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !b.dataset.look) return;
  state.look = b.dataset.look;
  for (const x of lookSeg.children) x.classList.toggle('active', x === b);
  syncShowControls();
  applyLighting();
  applyFilter();
  if (state.mode === '2d') fit2d();
});

(function wireTimeOfDay() {
  const slider = document.getElementById('tod-slider');
  const liveBtn = document.getElementById('tod-live');
  if (!slider) return;
  slider.addEventListener('input', () => {
    state.timeHour = Number(slider.value);
    applyLighting();
    syncTodLabel();
  });
  liveBtn?.addEventListener('click', () => {
    state.timeHour = null;
    slider.value = String(londonHourNow());
    applyLighting();
    syncTodLabel();
  });
})();

floorSeg.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  state.floor = b.dataset.floor === 'all' ? 'all' : Number(b.dataset.floor);
  // User owns the floor filter now — put external walls back if a room
  // focus had turned them off.
  if (focusRestore) {
    state.walls.external = focusRestore.external;
    focusRestore = null;
    syncWallButtons();
  }
  for (const x of floorSeg.children) x.classList.toggle('active', x === b);
  // Drop a selection that's no longer visible — otherwise the status pill
  // and sidebar point at a room the viewport can't show.
  if (state.selected && state.floor !== 'all' && state.selected.floor !== state.floor) {
    state.selected = null;
    setStatus('');
    renderRoomList();
  }
  applyFilter();
  // Re-frame: 2D refits to the visible floor; 3D moves the orbit
  // target to the visible storey so isolation is actually visible.
  if (state.mode === '2d') fit2d();
  else if (state.floor !== 'all') {
    const z = FLOOR_Z[state.floor] * MM + CEILING * MM / 2;
    controls.target.set(controls.target.x, controls.target.y, z);
  }
});

showSeg.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !b.dataset.show || b.disabled) return;
  const kind = b.dataset.show;
  state.show[kind] = !state.show[kind];
  b.classList.toggle('active', state.show[kind]);
  b.setAttribute('aria-pressed', String(state.show[kind]));
  // Hiding a layer deselects anything that belongs to it — by kind, or
  // by group for the door/window meshes whose kind is leaf/frame/glazing.
  const owns = (entry) => entry.kind === kind || entry.group === kind;
  if (state.selected && owns(state.selected) && !state.show[kind]) {
    state.selected = null;
    setStatus('');
    renderRoomList();
    if (state.mode === '3d') lookAtHouse();
  }
  // Mobile: furniture GLBs are huge — only fetch when the user turns them on.
  if (kind === 'furniture' && state.show.furniture) {
    ensureFurniture().then(() => applyFilter()).catch((err) => {
      console.error('[furniture]', err);
      setStatus(`Furniture load failed: ${err.message || err}`);
    });
  }
  applyFilter();
  if (state.mode === '2d') fit2d();
});

wallSeg.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !b.dataset.wall) return;
  const kind = b.dataset.wall;
  state.walls[kind] = !state.walls[kind];
  // Manual wall toggle owns the setting from here — do not restore the
  // pre-focus external state when the room selection clears.
  if (focusRestore && kind === 'external') focusRestore.external = state.walls.external;
  b.classList.toggle('active', state.walls[kind]);
  b.setAttribute('aria-pressed', String(state.walls[kind]));
  applyFilter();
  if (state.mode === '2d') fit2d();
});

function renderRoomList() {
  const groups = [[], [], []];
  for (const e of manifest) if (e.kind === 'room') groups[e.floor].push(e);
  const names = ['Ground floor', 'First floor', 'Second floor'];
  roomsEl.innerHTML = '';
  groups.forEach((g, f) => {
    const h = document.createElement('h2');
    h.textContent = names[f];
    roomsEl.appendChild(h);
    for (const e of g) {
      const b = document.createElement('button');
      b.className = 'room' + (state.selected?.id === e.id ? ' selected' : '');
      b.innerHTML = `${e.name}<span class="id">${e.id}</span>`;
      b.addEventListener('click', () => focusRoom(e));
      roomsEl.appendChild(b);
    }
  });
}

function setStatus(html) { statusEl.innerHTML = html; }

/* picking */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(ev) {
  const el = renderer.domElement;
  const r = el.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, state.mode === '2d' ? camera2d : camera);
  const hit = ray.intersectObjects(meshes.filter((m) => m.visible))[0];
  if (hit) {
    const entry = hit.object.userData.entry;
    const room = (entry.kind === 'flooring' || entry.kind === 'ceiling' || entry.kind === 'plaster') && entry.room
      ? manifest.find((e) => e.id === entry.room) ?? entry
      : entry;
    focusRoom(room, { frame: room.kind === 'room' });
  }
  else clearRoomFocus();
}
// A drag that ends over a mesh still fires click. Only a near-stationary
// press should select or clear a room, so orbit/pan stays free.
const CLICK_SLOP_PX = 5;
let pointerDown = null;
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  pointerDown = { x: ev.clientX, y: ev.clientY };
});
renderer.domElement.addEventListener('click', (ev) => {
  if (state.mode === 'walk') {
    // iOS / tablets: no Pointer Lock — look/move via touch + stick.
    if (!prefersTouchWalk() && !walkControls.isLocked) walkControls.lock();
    return;
  }
  if (window.__twin?.furniture?.consumeClickSuppress?.()) return;
  if (window.__twin?.lights?.consumeClickSuppress?.()) return;
  if (pointerDown) {
    const dx = ev.clientX - pointerDown.x;
    const dy = ev.clientY - pointerDown.y;
    pointerDown = null;
    if (dx * dx + dy * dy > CLICK_SLOP_PX * CLICK_SLOP_PX) return;
  }
  pick(ev);
});

/* ---------- resize / loop ---------- */

function onResize() {
  const w = view3d.clientWidth, h = view3d.clientHeight;
  if (w && h) {
    // CSS sizes the canvas (index.html); this only sets the drawing buffer.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  if (state.mode === '2d') fit2d();
}
window.addEventListener('resize', onResize);

const _clock = new THREE.Clock();
let _lastOutdoorApply = 0;
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(_clock.getDelta(), 0.05);
  if (state.mode === 'walk') updateWalk(dt);
  else controls.update();
  // Real-mode sun: re-apply when the 30s solar cache rolls (or ~1s while
  // a time override is active so the slider feels live without per-frame cost).
  if (state.look === 'real' && (state.mode === '3d' || state.mode === 'walk')) {
    const t = performance.now();
    const interval = state.timeHour == null ? 30_000 : 1000;
    if (t - _lastOutdoorApply >= interval) {
      _lastOutdoorApply = t;
      applyLighting();
      if (state.timeHour == null) syncTodLabel();
    }
  }
  // Keep Point/Spot room-index uniforms aligned with WebGLRenderer light order.
  syncIndoorLightRoomIds(scene, state.mode === '2d' ? camera2d : camera);
  renderer.render(scene, state.mode === '2d' ? camera2d : camera);
}

applyFilter();
renderRoomList();
syncShowControls();
setStatus('Click a room to select · drag furniture to move (auto-saves)');
lookAtHouse();
placeLights();
setMode('3d');
onResize();

/** Lazy furniture loader — on LOW_POWER we skip until the user enables Show → Furniture. */
let _furniturePromise = null;
async function ensureFurniture() {
  if (window.__twin.furniture) return window.__twin.furniture;
  if (_furniturePromise) return _furniturePromise;
  _furniturePromise = (async () => {
    setStatus(LOW_POWER ? 'Loading furniture (may be heavy on phone)…' : 'Loading furniture…');
    const api = await initFurniture({
      scene, camera, camera2d, controls, renderer, state, MM, FLOOR_Z, setStatus,
      lowPower: LOW_POWER,
      // Skip multi‑MB scans on phones; proxy boxes keep footprints visible.
      maxAssetBytes: LOW_POWER ? 2_500_000 : Infinity,
    });
    window.__twin.furniture = api;
    api.applyVisibility();
    return api;
  })();
  try {
    return await _furniturePromise;
  } catch (err) {
    _furniturePromise = null;
    throw err;
  }
}

try {
  if (!LOW_POWER) {
    await ensureFurniture();
    if (state.mode !== 'walk') {
      setStatus('Drag furniture to move · click to select · R / buttons rotate 90° (auto-saves)');
    }
  } else if (state.mode !== 'walk') {
    setStatus('Mobile quality · Furniture off until you enable it under Show');
  }
} catch (err) {
  console.error('[furniture]', err);
  showFatal(err);
  setStatus(`Furniture load failed: ${err.message || err}`);
}

try {
  const lightsApi = await initLights({
    scene, camera, camera2d, controls, renderer, state, MM, FLOOR_Z, setStatus,
    lowPower: LOW_POWER,
  });
  window.__twin.lights = lightsApi;
  lightsApi.applyVisibility();
  if (state.mode !== 'walk' && !LOW_POWER) {
    setStatus(
      lightsApi.hueLive()
        ? 'Hue lights live · Furniture drag · Alt-drag lights to reposition'
        : 'Furniture drag · Alt-drag lights to reposition',
    );
  }
} catch (err) {
  console.error('[lights]', err);
  showFatal(err);
  setStatus(`Lights load failed: ${err.message || err}`);
}

loop();

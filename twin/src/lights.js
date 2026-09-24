/* Hue lights load + live on/off (bri/colour) sync.
 *
 * Assets are mm, Z-up, origin = footprint centre (see lights/catalogue.json).
 * Same X-mirror + scene pose convention as furniture.
 *
 * Polls GET /api/hue/lights every ~2.5s; updates emissive + room lights.
 * Kind-aware illumination (three.js physical units, candela):
 *   spot → SpotLight (GU10/downlight); nested Thea heads aim outward+down
 *   candle / bulb / play / panel / ceiling_disc → PointLight with
 *   distance/decay tuned so an on bulb fills its corner / room without
 *   blowing out the whole house when many are lit.
 * Soft per-room bounce fill (PointLight at room centroid) approximates
 * diffuse inter-reflection — three.js WebGLRenderer is not full GI.
 * Room-scoped Point/Spot via shader coupling (layers.js / portals.js):
 * same room = full; doors/windows/openings/stairs attenuate; solid walls
 * block (weight 0). Exterior shell gets no Hue. Distance caps are secondary.
 * Placements with null/empty hue_light_id are static fixtures (always-on dim
 * chrome, no light / no Hue poll key).
 * Optional parent_id + local_*_mm: child world = parent + R_z(parent.rot)·local
 * (layout X-mirror aware). Alt-drag parent moves nested children; child drag
 * updates local offsets. Optional drag-save via PUT /api/lights/placements (also refreshes room via layout polygons).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { roomAtLayoutOrNearest, ROOM_FLOORS } from './roomLookup.js';
import { EXTERIOR_ROOMS, scopeMaterialToRoom } from './layers.js';
import { roomIndex } from './portals.js';

/** Assets live under the app's vite base (e.g. /twin/) in production. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const POLL_MS = 2500;

/** Global scale on direct lamp candela (keep bri 0–254 → i0…i1 linear-ish). */
const DIRECT_CD_SCALE = 0.5;

/**
 * Per-catalogue-kind room-light rig. Intensities are candela (three.js
 * physical Point/SpotLight); bri 0–254 scales from floor→peak.
 * Spots: nested under a plate fan outward; lone spots aim −Z.
 */
const LIGHT_RIG = {
  spot: {
    type: 'spot',
    dist: 4.5,
    decay: 2,
    // Slightly wider than a tight GU10 so pools read as soft cones, not needles
    angle: 0.64,
    penumbra: 0.6,
    // Peak candela before DIRECT_CD_SCALE (bri scales i0→i1)
    i0: 18,
    i1: 95,
    zOffMm: -40,
  },
  candle: {
    type: 'point',
    dist: 2.8,
    decay: 2,
    i0: 6,
    i1: 32,
    zOffMm: -30,
  },
  bulb: {
    type: 'point',
    dist: 4.2,
    decay: 2,
    i0: 10,
    i1: 55,
    zOffMm: -60,
  },
  play: {
    type: 'point',
    dist: 3.5,
    decay: 2,
    i0: 8,
    i1: 42,
    zOffMm: 0,
  },
  panel: {
    type: 'point',
    dist: 4.5,
    decay: 2,
    i0: 16,
    i1: 85,
    zOffMm: -50,
  },
  ceiling_disc: {
    type: 'point',
    dist: 4.5,
    decay: 2,
    i0: 14,
    i1: 75,
    zOffMm: -50,
  },
  // Fallback for unknown Hue kinds
  default: {
    type: 'point',
    dist: 4.0,
    decay: 2,
    i0: 10,
    i1: 50,
    zOffMm: -80,
  },
};

/** Soft bounce fill at room centres (candela). Not true GI. */
const BOUNCE = {
  // Stay room-scale; outdoor shader strip is the primary cull.
  dist: 4.5,
  decay: 2,
  /** Base + per (on-light × bri-level), then capped. */
  iBase: 1.2,
  iPer: 1.4,
  iCap: 12,
  /** Mid-room height above floor (mm) — stand-in for wall/floor bounce. */
  zMm: 1100,
};

function rigForCatalogue(cat) {
  const kind = cat?.kind || 'default';
  return LIGHT_RIG[kind] || LIGHT_RIG.default;
}

/** Hue bri → near-linear level; keep low bri still readable. */
function briLevel(bri) {
  const t = Math.max(0, Math.min(1, (bri ?? 254) / 254));
  return t ** 0.85;
}

/** Layout-mm centroid of a twin room polygon, or null. */
function roomCentroidMm(floor, roomId) {
  const entry = ROOM_FLOORS.find((f) => f.floor === floor);
  const room = entry?.rooms?.find((r) => r.id === roomId);
  if (!room?.polygon_mm?.length) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of room.polygon_mm) {
    sx += x;
    sy += y;
  }
  const n = room.polygon_mm.length;
  return { x_mm: sx / n, y_mm: sy / n };
}

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.Camera} opts.camera
 * @param {THREE.OrthographicCamera} opts.camera2d
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} opts.controls
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {object} opts.state
 * @param {number} opts.MM
 * @param {number[]} opts.FLOOR_Z
 * @param {(html: string) => void} opts.setStatus
 */

function tagLightRoom(light, roomId) {
  if (!light) return;
  light.userData.twinRoom = roomId || null;
  light.userData.twinRoomIndex = roomIndex(roomId);
}

export async function initLights(opts) {
  const {
    scene, camera, camera2d, controls, renderer, state, MM, FLOOR_Z, setStatus,
    lowPower = false,
  } = opts;

  const group = new THREE.Group();
  group.name = 'lights';
  scene.add(group);

  // Soft global wash when Hue is on (Real only) — cheap bounce stand-in.
  // Kept tiny so daytime sun is not washed out.
  const bounceAmbient = new THREE.AmbientLight(0xffe6c8, 0);
  bounceAmbient.name = 'hue-bounce-ambient';
  scene.add(bounceAmbient);

  const bounceGroup = new THREE.Group();
  bounceGroup.name = 'hue-bounce-fill';
  scene.add(bounceGroup);
  /** @type {Map<string, THREE.PointLight>} */
  const bounceLights = new Map();

  const loader = new GLTFLoader();
  /** @type {Map<string, THREE.Object3D>} */
  const assetCache = new Map();

  const [placementsDoc, catalogue] = await Promise.all([
    fetch(`${BASE}/lights/placements.json`).then((r) => {
      if (!r.ok) throw new Error(`placements.json ${r.status}`);
      return r.json();
    }),
    fetch(`${BASE}/lights/catalogue.json`).then((r) => {
      if (!r.ok) throw new Error(`catalogue.json ${r.status}`);
      return r.json();
    }),
  ]);

  const byCat = new Map(catalogue.map((c) => [c.id, c]));
  /** @type {{
   *   root: THREE.Object3D,
   *   placement: object,
   *   meshes: THREE.Mesh[],
   *   pointLight: THREE.PointLight|THREE.SpotLight|null,
   *   spotTarget: THREE.Object3D|null,
   *   rig: object,
   *   baseEmissive: Map<THREE.Material, number>,
   *   isFixture: boolean,
   *   parent: object|null,
   *   children: object[],
   * }[]} */
  const items = [];

  async function loadAsset(relPath) {
    if (assetCache.has(relPath)) {
      return assetCache.get(relPath).clone(true);
    }
    const url = `${BASE}/lights/${relPath.replace(/^\/+/, '')}`;
    const gltf = await loader.loadAsync(url);
    const template = gltf.scene;
    const baked = new Map();
    template.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!baked.has(o.geometry)) {
        const g = o.geometry.clone();
        g.scale(-1, 1, 1);
        if (g.index) {
          const idx = g.index;
          for (let i = 0; i < idx.count; i += 3) {
            const a = idx.getX(i + 1);
            idx.setX(i + 1, idx.getX(i + 2));
            idx.setX(i + 2, a);
          }
          idx.needsUpdate = true;
        } else {
          const pos = g.getAttribute('position');
          for (let i = 0; i < pos.count; i += 3) {
            const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
            pos.setXYZ(i, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
            pos.setXYZ(i + 2, x, y, z);
          }
          pos.needsUpdate = true;
        }
        g.computeVertexNormals();
        baked.set(o.geometry, g);
      }
      o.geometry = baked.get(o.geometry);
      o.castShadow = false;
      o.receiveShadow = true;
    });
    assetCache.set(relPath, template);
    return template.clone(true);
  }

  function worldPosFromPlacement(p) {
    const floorZ = FLOOR_Z[p.floor] ?? 0;
    return new THREE.Vector3(
      -p.x_mm * MM,
      p.y_mm * MM,
      (floorZ + (p.z_mm ?? 0)) * MM,
    );
  }

  function applyPose(root, p) {
    root.position.copy(worldPosFromPlacement(p));
    root.rotation.set(0, 0, THREE.MathUtils.degToRad(p.rot_deg_z ?? 0));
    root.scale.setScalar(MM);
  }

  /**
   * Layout-mm offset of parent-local (lx,ly) after parent rot_deg_z.
   * Matches three.js Z-rot on roots whose scene X = −layout X (viewer X-mirror).
   *   dx = lx·cosθ + ly·sinθ
   *   dy = −lx·sinθ + ly·cosθ
   */
  function rotateLocalOffset(lx, ly, rotDeg) {
    const r = THREE.MathUtils.degToRad(rotDeg ?? 0);
    const c = Math.cos(r);
    const s = Math.sin(r);
    return {
      dx: lx * c + ly * s,
      dy: -lx * s + ly * c,
    };
  }

  /** Inverse of rotateLocalOffset: layout delta → parent-local. */
  function inverseRotateLocalOffset(dx, dy, rotDeg) {
    const r = THREE.MathUtils.degToRad(rotDeg ?? 0);
    const c = Math.cos(r);
    const s = Math.sin(r);
    return {
      lx: dx * c - dy * s,
      ly: dx * s + dy * c,
    };
  }

  /** Write child placement x/y/z from parent + local_* (or leave absolute if no parent). */
  function syncChildWorldFromParent(childPlacement, parentPlacement) {
    if (!parentPlacement) return false;
    const lx = childPlacement.local_x_mm ?? 0;
    const ly = childPlacement.local_y_mm ?? 0;
    const lz = childPlacement.local_z_mm ?? 0;
    const { dx, dy } = rotateLocalOffset(lx, ly, parentPlacement.rot_deg_z ?? 0);
    childPlacement.x_mm = Math.round(parentPlacement.x_mm + dx);
    childPlacement.y_mm = Math.round(parentPlacement.y_mm + dy);
    childPlacement.z_mm = Math.round((parentPlacement.z_mm ?? 0) + lz);
    // Keep child on the same floor as parent when nested
    if (parentPlacement.floor != null) childPlacement.floor = parentPlacement.floor;
    return true;
  }

  /** After dragging a child: refresh local_* from world delta vs parent. */
  function syncChildLocalFromWorld(childPlacement, parentPlacement) {
    if (!parentPlacement) return false;
    const dx = childPlacement.x_mm - parentPlacement.x_mm;
    const dy = childPlacement.y_mm - parentPlacement.y_mm;
    const { lx, ly } = inverseRotateLocalOffset(dx, dy, parentPlacement.rot_deg_z ?? 0);
    childPlacement.local_x_mm = Math.round(lx);
    childPlacement.local_y_mm = Math.round(ly);
    childPlacement.local_z_mm = Math.round(
      (childPlacement.z_mm ?? 0) - (parentPlacement.z_mm ?? 0),
    );
    return true;
  }

  /**
   * Aim SpotLight target. Lone spots: straight −Z.
   * Nested under a plate (e.g. Thea 6×GU10): fan outward from plate centre
   * using parent rot_deg_z · local_* so aims stay correct when the plate yaws,
   * plus a strong downward component toward the floor.
   * Positions are asset-mm (root.scale = MM).
   */
  function updateSpotAim(item) {
    if (!item.spotTarget || !item.pointLight) return;
    const rig = item.rig || LIGHT_RIG.spot;
    if (rig.type !== 'spot') return;
    const zOff = rig.zOffMm ?? -40;
    const parentPl = item.parent?.placement;
    const lx = item.placement.local_x_mm;
    const ly = item.placement.local_y_mm;
    if (
      parentPl
      && (lx != null || ly != null)
      && (Math.abs(lx ?? 0) > 1e-3 || Math.abs(ly ?? 0) > 1e-3)
    ) {
      const { dx, dy } = rotateLocalOffset(lx ?? 0, ly ?? 0, parentPl.rot_deg_z ?? 0);
      const len = Math.hypot(dx, dy) || 1;
      // ~1.0–1.4 m horizontal throw on the floor; ~2 m below the lamp.
      const outMm = 1000 + Math.min(450, len * 2.5);
      const downMm = 2000;
      // Scene X = −layout X; child root rot_deg_z is typically 0.
      item.spotTarget.position.set(
        (-dx / len) * outMm,
        (dy / len) * outMm,
        zOff - downMm,
      );
    } else {
      item.spotTarget.position.set(0, 0, zOff - 1200);
    }
  }

  /** Approximate Hue xy → linear RGB (CIE 1931, D65-ish). */
  function xyToRgb(x, y, bri = 254) {
    if (y <= 1e-6) return new THREE.Color(1, 1, 1);
    const Y = Math.max(0.01, (bri ?? 254) / 254);
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);
    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
    const max = Math.max(r, g, b, 1e-6);
    r = Math.min(1, Math.max(0, r / max));
    g = Math.min(1, Math.max(0, g / max));
    b = Math.min(1, Math.max(0, b / max));
    return new THREE.Color(r, g, b);
  }

  /** Hue CT (mirek) → warm/cool white RGB (chromaticity only; bri → intensity). */
  function ctToRgb(ct) {
    // 153 (cool) … 500 (warm). Map to kelvin-ish tint.
    const t = THREE.MathUtils.clamp(((ct ?? 350) - 153) / (500 - 153), 0, 1);
    const cool = new THREE.Color(0xdeeeff);
    const warm = new THREE.Color(0xffc878);
    return cool.clone().lerp(warm, t);
  }

  function colourFromState(st) {
    // Colour is tint only — room-light candela + emissive use bri separately.
    if (!st) return new THREE.Color(0xffe6b3);
    if (st.colormode === 'xy' && Array.isArray(st.xy) && st.xy.length >= 2) {
      return xyToRgb(st.xy[0], st.xy[1], 254);
    }
    if (st.ct != null) return ctToRgb(st.ct);
    if (Array.isArray(st.xy) && st.xy.length >= 2) {
      return xyToRgb(st.xy[0], st.xy[1], 254);
    }
    return new THREE.Color(0xffe6b3);
  }

  for (const p of placementsDoc.placements ?? []) {
    const cat = byCat.get(p.catalogue_id);
    if (!cat?.asset) {
      console.warn('[lights] missing catalogue entry', p.catalogue_id);
      continue;
    }
    let root;
    try {
      root = await loadAsset(cat.asset);
    } catch (err) {
      console.warn('[lights] failed to load', cat.asset, err);
      continue;
    }
    root.name = p.id;
    applyPose(root, p);
    const meshes = [];
    const baseEmissive = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m.clone())
        : o.material.clone();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (mat && mat.emissive) {
          mat.emissiveIntensity = mat.emissiveIntensity ?? 1;
          baseEmissive.set(mat, mat.emissiveIntensity);
        }
      }
      o.userData.lightId = p.id;
      o.userData.hueLightId = p.hue_light_id == null || p.hue_light_id === ''
        ? null
        : String(p.hue_light_id);
      o.userData.twinRoom = p.room || null;
      {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) scopeMaterialToRoom(mat, p.room || null);
      }
      meshes.push(o);
    });

    const isFixture = p.hue_light_id == null || p.hue_light_id === '';
    // Static fixtures (e.g. Thea plate / floor-lamp body): no room light.
    // Hue bulbs get a kind-aware PointLight or SpotLight.
    let pl = null;
    let spotTarget = null;
    const rig = rigForCatalogue(cat);
    if (!isFixture) {
      // Child positions are in asset-mm: root.scale = MM, so −80 → −80 mm world.
      const zOff = rig.zOffMm ?? -80;
      if (rig.type === 'spot') {
        pl = new THREE.SpotLight(0xffe6b3, 0, rig.dist, rig.angle, rig.penumbra, rig.decay);
        pl.castShadow = false;
        pl.position.set(0, 0, zOff);
        spotTarget = new THREE.Object3D();
        spotTarget.position.set(0, 0, zOff - 1200); // default −Z; nesting may fan
        root.add(spotTarget);
        pl.target = spotTarget;
        root.add(pl);
      } else {
        pl = new THREE.PointLight(0xffe6b3, 0, rig.dist, rig.decay);
        pl.castShadow = false;
        pl.position.set(0, 0, zOff);
        root.add(pl);
      }
    }

    if (pl) tagLightRoom(pl, p.room);
    root.userData.placement = p;
    root.userData.catalogue = cat;
    root.userData.isFixture = isFixture;
    group.add(root);
    items.push({
      root,
      placement: p,
      meshes,
      pointLight: pl,
      spotTarget,
      rig,
      baseEmissive,
      isFixture,
      parent: null,
      children: [],
    });
  }

  // ---- parent/child nesting (fixtures → bulbs) ----
  /** @type {Map<string, typeof items[number]>} */
  const byId = new Map(items.map((it) => [it.placement.id, it]));

  for (const it of items) {
    const pid = it.placement.parent_id;
    if (!pid) continue;
    const parentItem = byId.get(pid);
    if (!parentItem) {
      console.warn(
        '[lights] parent_id missing, using absolute pose',
        it.placement.id,
        '→',
        pid,
      );
      continue;
    }
    it.parent = parentItem;
    parentItem.children.push(it);
    it.root.userData.parentId = pid;
    // Derive world from parent + rotated local (keeps nest if parent was moved)
    if (
      it.placement.local_x_mm != null
      || it.placement.local_y_mm != null
      || it.placement.local_z_mm != null
    ) {
      syncChildWorldFromParent(it.placement, parentItem.placement);
      applyPose(it.root, it.placement);
    }
  }

  // After nesting, fan Thea (and any other nested) spots outward from plate.
  for (const it of items) updateSpotAim(it);

  /** @type {Map<string, object>} */
  let hueState = new Map();

  function applyHueVisual(item) {
    // Static fixture (no Hue id): always show as dim chrome, no PointLight sync
    if (item.isFixture || item.placement.hue_light_id == null || item.placement.hue_light_id === '') {
      for (const mesh of item.meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (!mat || !mat.emissive) continue;
          mat.emissive.setHex(0x8a9096);
          const base = item.baseEmissive.get(mat) ?? 1;
          mat.emissiveIntensity = 0.12 * base;
        }
      }
      if (item.pointLight) item.pointLight.intensity = 0;
      item.root.userData.hueOn = true; // treat as always "present"
      return;
    }
    const st = hueState.get(String(item.placement.hue_light_id));
    const on = !!(st && st.on && st.reachable !== false);
    const bri = st?.bri ?? 254;
    const colour = colourFromState(st);
    const level = briLevel(bri);
    // Emissive bulb glow (mesh feedback) — separate from room fill candela.
    const emissiveI = on ? 0.35 + 1.15 * level : 0.02;
    const rig = item.rig || LIGHT_RIG.default;
    const intensity = on
      ? (rig.i0 + (rig.i1 - rig.i0) * level) * DIRECT_CD_SCALE
      : 0;

    for (const mesh of item.meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || !mat.emissive) continue;
        mat.emissive.copy(colour);
        const base = item.baseEmissive.get(mat) ?? 1;
        mat.emissiveIntensity = on ? emissiveI * base : 0.04 * base;
        if (mat.color && on) {
          // Keep body slightly tinted when on
          if (!mesh.userData._baseColor) {
            mesh.userData._baseColor = mat.color.clone();
          }
        }
      }
    }
    if (item.pointLight) {
      item.pointLight.color.copy(colour);
      item.pointLight.intensity = intensity;
    }
    item.root.userData.hueOn = on;
    item.root.userData.hueLevel = on ? level : 0;
    item.root.userData.hueColour = colour;
  }

  /**
   * Approximate multi-bounce fill: one soft PointLight per room that has
   * ≥1 Hue lamp on. Intensity ∝ count × avg bri (capped). Not path-traced GI.
   */
  function updateBounceFills() {
    const real = state.look === 'real' && state.show.lights !== false;
    /** @type {Map<string, { floor: number, room: string, count: number, sumLevel: number, color: THREE.Color }>} */
    const agg = new Map();
    let onCount = 0;
    let sumLevelAll = 0;

    // Phones: skip per-room bounce PointLights (many dynamic lights = GPU death).
    // Keep the tiny bounceAmbient wash so night interiors are not black.
    if (lowPower) {
      // Still tally on-lights for ambient.
      if (real) {
        for (const it of items) {
          if (it.isFixture) continue;
          if (!it.root.userData.hueOn) continue;
          const level = it.root.userData.hueLevel ?? 0;
          if (level <= 0) continue;
          onCount += 1;
          sumLevelAll += level;
        }
      }
      for (const [key, light] of bounceLights) {
        bounceGroup.remove(light);
        light.dispose?.();
        bounceLights.delete(key);
      }
      if (real && onCount > 0) {
        const energy = Math.min(1, sumLevelAll / 6);
        bounceAmbient.intensity = 0.04 + 0.08 * energy;
        bounceAmbient.color.setHex(0xffe6c8);
      } else {
        bounceAmbient.intensity = 0;
      }
      bounceAmbient.visible = real;
      bounceGroup.visible = false;
      return;
    }

    if (real) {
      for (const it of items) {
        if (it.isFixture) continue;
        if (!it.root.userData.hueOn) continue;
        const room = it.placement.room;
        const floor = it.placement.floor ?? 0;
        if (!room || EXTERIOR_ROOMS.has(room)) continue;
        const level = it.root.userData.hueLevel ?? 0;
        if (level <= 0) continue;
        onCount += 1;
        sumLevelAll += level;
        const key = `${floor}:${room}`;
        let a = agg.get(key);
        if (!a) {
          a = {
            floor,
            room,
            count: 0,
            sumLevel: 0,
            color: new THREE.Color(0, 0, 0),
          };
          agg.set(key, a);
        }
        a.count += 1;
        a.sumLevel += level;
        const c = it.root.userData.hueColour;
        if (c) a.color.add(c);
      }
    }

    const liveKeys = new Set(agg.keys());
    for (const [key, light] of bounceLights) {
      if (!liveKeys.has(key)) {
        bounceGroup.remove(light);
        light.dispose?.();
        bounceLights.delete(key);
      }
    }

    for (const [key, a] of agg) {
      const cen = roomCentroidMm(a.floor, a.room);
      if (!cen) continue;
      const floorZ = FLOOR_Z[a.floor] ?? 0;
      const avgLevel = a.sumLevel / a.count;
      const energy = a.count * avgLevel;
      const intensity = Math.min(BOUNCE.iCap, BOUNCE.iBase + BOUNCE.iPer * energy);
      const col = a.color.multiplyScalar(1 / Math.max(1, a.count));

      let light = bounceLights.get(key);
      if (!light) {
        light = new THREE.PointLight(0xffe6b3, 0, BOUNCE.dist, BOUNCE.decay);
        light.castShadow = false;
        light.name = `bounce-${key}`;
        bounceGroup.add(light);
        bounceLights.set(key, light);
      }
      tagLightRoom(light, a.room);
      light.color.copy(col);
      light.intensity = intensity;
      light.position.set(
        -cen.x_mm * MM,
        cen.y_mm * MM,
        (floorZ + BOUNCE.zMm) * MM,
      );
      const onFloor = state.floor === 'all' || a.floor === state.floor;
      light.visible = real && onFloor;
    }

    // Global Hue ambient disabled: it ignored walls/portals and washed every
    // room. Per-room bounce PointLights (+ portal coupling) provide fill.
    bounceAmbient.intensity = 0;
    bounceAmbient.visible = false;
    bounceGroup.visible = real;
  }

  function applyAllHueVisuals() {
    for (const it of items) applyHueVisual(it);
    updateBounceFills();
  }

  async function pollHue() {
    try {
      const res = await fetch('/api/hue/lights');
      if (!res.ok) throw new Error(`hue ${res.status}`);
      const data = await res.json();
      const next = new Map();
      for (const [id, st] of Object.entries(data.lights ?? data)) {
        if (st && typeof st === 'object') next.set(String(id), st);
      }
      hueState = next;
      applyAllHueVisuals();
    } catch (err) {
      console.warn('[lights] poll failed', err.message || err);
    }
  }

  function applyVisibility() {
    const show = state.look === 'real' && state.show.lights !== false;
    for (const it of items) {
      const onFloor = state.floor === 'all' || it.placement.floor === state.floor;
      it.root.visible = show && onFloor;
      if (it.pointLight) it.pointLight.visible = it.root.visible;
    }
    updateBounceFills();
  }

  // ---- optional drag-save (does not steal furniture picks when idle) ----
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  const dragPlane = new THREE.Plane();
  const hit = new THREE.Vector3();
  let dragging = null;
  let dragMoved = false;
  let suppressClick = false;

  function activeCamera() {
    return state.mode === '2d' ? camera2d : camera;
  }

  function setNdc(ev) {
    const el = renderer.domElement;
    const r = el.getBoundingClientRect();
    ndc.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    );
  }

  function pickLight(ev) {
    setNdc(ev);
    ray.setFromCamera(ndc, activeCamera());
    const meshes = items.flatMap((it) => (it.root.visible ? it.meshes : []));
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const id = hits[0].object.userData.lightId;
    return items.find((it) => it.placement.id === id) ?? null;
  }

  async function persistPlacements() {
    const doc = { ...placementsDoc, placements: placementsDoc.placements };
    const res = await fetch('/api/lights/placements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `save ${res.status}`);
    }
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    if (state.mode === 'walk') return;
    if (state.look !== 'real' || state.show.lights === false) return;
    // Prefer furniture if both claim — furniture registers first; only
    // start light drag when Alt is held, or when no furniture suppress.
    if (!ev.altKey) return;
    const item = pickLight(ev);
    if (!item) return;
    const z = worldPosFromPlacement(item.placement).z;
    dragPlane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, z),
    );
    setNdc(ev);
    ray.setFromCamera(ndc, activeCamera());
    if (!ray.ray.intersectPlane(dragPlane, hit)) return;
    dragging = { item, offset: item.root.position.clone().sub(hit) };
    dragMoved = false;
    suppressClick = true;
    controls.enabled = false;
    renderer.domElement.setPointerCapture(ev.pointerId);
    const name = item.root.userData.catalogue?.name ?? item.placement.id;
    const nest = item.children.length
      ? ` +${item.children.length} nested`
      : item.parent
        ? ' (child)'
        : '';
    setStatus(`Dragging light <b>${name}</b>${nest} (Alt)…`);
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    setNdc(ev);
    ray.setFromCamera(ndc, activeCamera());
    if (!ray.ray.intersectPlane(dragPlane, hit)) return;
    const p = hit.clone().add(dragging.offset);
    const item = dragging.item;
    item.root.position.x = p.x;
    item.root.position.y = p.y;
    // Live-update nested children while dragging a parent
    if (item.children.length) {
      // Provisional layout mm from scene (same as save) so children track offset
      const px = -item.root.position.x / MM;
      const py = item.root.position.y / MM;
      const parentPlacement = {
        ...item.placement,
        x_mm: px,
        y_mm: py,
      };
      for (const ch of item.children) {
        const lx = ch.placement.local_x_mm ?? 0;
        const ly = ch.placement.local_y_mm ?? 0;
        const lz = ch.placement.local_z_mm ?? 0;
        const { dx, dy } = rotateLocalOffset(lx, ly, item.placement.rot_deg_z ?? 0);
        const cx = px + dx;
        const cy = py + dy;
        const cz = (item.placement.z_mm ?? 0) + lz;
        const floorZ = FLOOR_Z[item.placement.floor] ?? 0;
        ch.root.position.set(-cx * MM, cy * MM, (floorZ + cz) * MM);
      }
    }
    dragMoved = true;
    ev.preventDefault();
  }

  async function onPointerUp(ev) {
    if (!dragging) return;
    const { item } = dragging;
    dragging = null;
    controls.enabled = state.mode !== 'walk';
    try {
      renderer.domElement.releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    if (!dragMoved) return;
    const pos = item.root.position;
    item.placement.x_mm = Math.round(-pos.x / MM);
    item.placement.y_mm = Math.round(pos.y / MM);

    if (item.children.length) {
      // Parent drag: keep local_* ; write derived world for each child
      for (const ch of item.children) {
        syncChildWorldFromParent(ch.placement, item.placement);
        applyPose(ch.root, ch.placement);
        updateSpotAim(ch);
      }
    } else if (item.parent) {
      // Child drag: stay attached — refresh local_* from new world vs parent
      syncChildLocalFromWorld(item.placement, item.parent.placement);
      updateSpotAim(item);
    }

    const floor = item.placement.floor ?? 0;
    const nextRoom = roomAtLayoutOrNearest(floor, item.placement.x_mm, item.placement.y_mm);
    if (nextRoom) {
      item.placement.room = nextRoom;
      for (const ch of item.children) ch.placement.room = nextRoom;
      tagLightRoom(item.pointLight, nextRoom);
      for (const ch of item.children) tagLightRoom(ch.pointLight, nextRoom);
    }

    const name = item.root.userData.catalogue?.name ?? item.placement.id;
    const extra = item.children.length
      ? ` (+${item.children.length} nested)`
      : item.parent
        ? ` (local ${item.placement.local_x_mm},${item.placement.local_y_mm},${item.placement.local_z_mm})`
        : '';
    setStatus(`Saving light <b>${name}</b>${extra}…`);
    try {
      await persistPlacements();
      setStatus(
        `Saved light <b>${name}</b> → (${item.placement.x_mm}, ${item.placement.y_mm}) mm · ${item.placement.room}${extra}`,
      );
      updateBounceFills();
    } catch (err) {
      console.error(err);
      setStatus(`Light save failed: ${err.message || err}`);
    }
  }

  const el = renderer.domElement;
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);

  applyVisibility();
  await pollHue();
  const pollTimer = setInterval(pollHue, POLL_MS);

  return {
    group,
    items,
    placementsDoc,
    applyVisibility,
    pollHue,
    updateBounceFills,
    dispose() {
      clearInterval(pollTimer);
      scene.remove(bounceAmbient);
      scene.remove(bounceGroup);
      for (const light of bounceLights.values()) {
        light.dispose?.();
      }
      bounceLights.clear();
    },
    consumeClickSuppress() {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    },
  };
}

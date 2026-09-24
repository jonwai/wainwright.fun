/* Furniture load + drag-to-save + select/rotate.
 *
 * Assets are mm, Z-up, origin = footprint centre (see furniture/README.md).
 * House meshes are X-mirrored at load; furniture gets the same treatment so
 * layout x_mm/y_mm line up with rooms.
 *
 * Scene position: (−x_mm·MM, y_mm·MM, (FLOOR_Z[floor]+z_mm)·MM)
 * Drag / rotate write x_mm/y_mm / rot_deg_z / room via PUT /api/furniture/placements.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { roomAtLayoutOrNearest } from './roomLookup.js';
import { scopeMaterialToRoom, updateMaterialRoom } from './layers.js';

/** Assets live under the app's vite base (e.g. /twin/) in production. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.Camera} opts.camera
 * @param {THREE.OrthographicCamera} opts.camera2d
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} opts.controls
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {object} opts.state  — viewer state (mode, floor, show)
 * @param {number} opts.MM
 * @param {number[]} opts.FLOOR_Z
 * @param {(html: string) => void} opts.setStatus
 */
export async function initFurniture(opts) {
  const {
    scene, camera, camera2d, controls, renderer, state, MM, FLOOR_Z, setStatus,
    lowPower = false,
    maxAssetBytes = Infinity,
  } = opts;

  const group = new THREE.Group();
  group.name = 'furniture';
  scene.add(group);

  const loader = new GLTFLoader();
  /** @type {Map<string, THREE.Object3D>} */
  const assetCache = new Map();

  const [placementsDoc, catalogue] = await Promise.all([
    fetch(`${BASE}/furniture/placements.json`).then((r) => {
      if (!r.ok) throw new Error(`placements.json ${r.status}`);
      return r.json();
    }),
    fetch(`${BASE}/furniture/catalogue.json`).then((r) => {
      if (!r.ok) throw new Error(`catalogue.json ${r.status}`);
      return r.json();
    }),
  ]);

  const byCat = new Map(catalogue.map((c) => [c.id, c]));
  /** @type {{ root: THREE.Object3D, placement: object, meshes: THREE.Mesh[] }[]} */
  const items = [];

  /** Lightweight stand-in when a GLB is too large for LOW_POWER devices. */
  function proxyBox(cat) {
    const d = cat?.dims_mm || {};
    const wMm = d.w ?? cat?.width_mm ?? 800;
    const dMm = d.d ?? d.chaise_d ?? cat?.depth_mm ?? 800;
    const hMm = d.h ?? cat?.height_mm ?? 600;
    // Geometry in asset-mm; root.scale = MM converts to metres.
    const geo = new THREE.BoxGeometry(wMm, dMm, hMm);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a9aaa, roughness: 0.85, metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !lowPower;
    mesh.receiveShadow = !lowPower;
    mesh.position.z = hMm / 2; // sit on floor in asset-mm
    const root = new THREE.Group();
    root.add(mesh);
    root.userData.isProxy = true;
    return root;
  }

  async function loadAsset(relPath, cat) {
    if (assetCache.has(relPath)) {
      return assetCache.get(relPath).clone(true);
    }
    const url = `${BASE}/furniture/${relPath.replace(/^\/+/, '')}`;
    if (maxAssetBytes < Infinity) {
      // Known multi‑MB scans that OOM iOS even if HEAD is missing.
      if (/chaise|l-shaped-couch|airpods-max|mac-studio|macbook-pro/i.test(relPath)) {
        console.warn('[furniture] skip known-heavy asset on low-power', relPath);
        return proxyBox(cat);
      }
      try {
        const head = await fetch(url, { method: 'HEAD' });
        const len = Number(head.headers.get('content-length') || 0);
        if (len > maxAssetBytes) {
          console.warn('[furniture] skip large asset on low-power', relPath, `${(len / 1e6).toFixed(1)}MB`);
          return proxyBox(cat);
        }
      } catch (_) {
        // HEAD may fail on some static hosts — fall through to full load.
      }
    }
    const gltf = await loader.loadAsync(url);
    const template = gltf.scene;
    // Mirror X on every geometry (same as house) so +X width matches layout
    // east after the viewer convention. Scale mm → m on the root when placing.
    const baked = new Map();
    template.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!baked.has(o.geometry)) {
        const g = o.geometry.clone();
        g.scale(-1, 1, 1);
        // X-mirror flips winding; flip triangles so materials still face out.
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
      o.castShadow = !lowPower;
      o.receiveShadow = !lowPower;
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

  for (const p of placementsDoc.placements ?? []) {
    const cat = byCat.get(p.catalogue_id);
    if (!cat?.asset) {
      console.warn('[furniture] missing catalogue entry', p.catalogue_id);
      continue;
    }
    let root;
    try {
      root = await loadAsset(cat.asset, cat);
    } catch (err) {
      console.warn('[furniture] failed to load', cat.asset, err);
      continue;
    }
    root.name = p.id;
    applyPose(root, p);
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh) {
        // Per-instance materials so selection emissive does not leak across clones.
        o.material = Array.isArray(o.material)
          ? o.material.map((m) => m.clone())
          : o.material.clone();
        o.userData.furnitureId = p.id;
        o.userData.twinRoom = p.room || null;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) scopeMaterialToRoom(mat, p.room || null);
        meshes.push(o);
      }
    });
    root.userData.placement = p;
    root.userData.catalogue = cat;
    group.add(root);
    items.push({ root, placement: p, meshes });
  }

  function applyVisibility() {
    const show = state.look === 'real' && state.show.furniture !== false;
    for (const it of items) {
      const onFloor = state.floor === 'all' || it.placement.floor === state.floor;
      it.root.visible = show && onFloor;
    }
    if (selected && !selected.root.visible) clearSelection();
  }

  // ---- selection + rotate 90° ----
  /** @type {{ root: THREE.Object3D, placement: object, meshes: THREE.Mesh[] } | null} */
  let selected = null;

  function itemName(item) {
    return item.root.userData.catalogue?.name ?? item.placement.id;
  }

  function setSelectVisual(item, on) {
    for (const mesh of item.meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || !mat.emissive) continue;
        if (on) {
          if (mesh.userData._emiHex == null) {
            mesh.userData._emiHex = mat.emissive.getHex();
            mesh.userData._emiIntensity = mat.emissiveIntensity ?? 1;
          }
          mat.emissive.setHex(0x4fc3f7);
          mat.emissiveIntensity = 0.45;
        } else if (mesh.userData._emiHex != null) {
          mat.emissive.setHex(mesh.userData._emiHex);
          mat.emissiveIntensity = mesh.userData._emiIntensity ?? 1;
          delete mesh.userData._emiHex;
          delete mesh.userData._emiIntensity;
        }
      }
    }
  }

  function selectionStatus(item) {
    const rot = item.placement.rot_deg_z ?? 0;
    return (
      `Selected: <b>${itemName(item)}</b> · ${item.placement.room} · ` +
      `rot ${rot}° — R / E / ] +90°, Q / [ −90°, or buttons`
    );
  }

  function clearSelection() {
    if (selected) setSelectVisual(selected, false);
    selected = null;
  }

  function selectItem(item) {
    if (selected === item) {
      setStatus(selectionStatus(item));
      return;
    }
    clearSelection();
    selected = item;
    if (item) {
      setSelectVisual(item, true);
      setStatus(selectionStatus(item));
    }
  }

  function normalizeRot(deg) {
    return ((Math.round(deg) % 360) + 360) % 360;
  }

  async function persistPlacements() {
    const doc = {
      ...placementsDoc,
      placements: placementsDoc.placements,
    };
    const res = await fetch('/api/furniture/placements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `save ${res.status}`);
    }
  }

  async function rotateSelected(deltaDeg) {
    if (!selected) {
      setStatus('Click a piece of furniture first, then rotate');
      return;
    }
    if (state.mode === 'walk') return;
    if (state.look !== 'real' || state.show.furniture === false) return;
    if (dragging) return;
    const item = selected;
    const p = item.placement;
    p.rot_deg_z = normalizeRot((p.rot_deg_z ?? 0) + deltaDeg);
    item.root.rotation.z = THREE.MathUtils.degToRad(p.rot_deg_z);
    const name = itemName(item);
    setStatus(`Saving rotation <b>${name}</b> → ${p.rot_deg_z}°…`);
    try {
      await persistPlacements();
      setStatus(selectionStatus(item));
    } catch (err) {
      console.error(err);
      setStatus(`Save failed: ${err.message || err}`);
    }
  }

  // ---- drag on storey plane (z = FLOOR_Z[floor] + z_mm) ----
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  const dragPlane = new THREE.Plane();
  const hit = new THREE.Vector3();
  let dragging = null; // { item, offset: Vector3 }
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

  function pickFurniture(ev) {
    setNdc(ev);
    ray.setFromCamera(ndc, activeCamera());
    const meshes = items.flatMap((it) => (it.root.visible ? it.meshes : []));
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const id = hits[0].object.userData.furnitureId;
    return items.find((it) => it.placement.id === id) ?? null;
  }

  function planeFor(item) {
    const z = worldPosFromPlacement(item.placement).z;
    dragPlane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, z),
    );
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    if (state.mode === 'walk') return;
    if (state.look !== 'real' || state.show.furniture === false) return;
    const item = pickFurniture(ev);
    if (!item) {
      clearSelection();
      return;
    }
    selectItem(item);
    planeFor(item);
    setNdc(ev);
    ray.setFromCamera(ndc, activeCamera());
    if (!ray.ray.intersectPlane(dragPlane, hit)) return;
    dragging = {
      item,
      offset: item.root.position.clone().sub(hit),
    };
    dragMoved = false;
    suppressClick = true; // clicking furniture should not pick a room
    controls.enabled = false;
    renderer.domElement.setPointerCapture(ev.pointerId);
    setStatus(`Dragging <b>${itemName(item)}</b>…`);
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    setNdc(ev);
    ray.setFromCamera(ndc, activeCamera());
    if (!ray.ray.intersectPlane(dragPlane, hit)) return;
    const p = hit.clone().add(dragging.offset);
    dragging.item.root.position.x = p.x;
    dragging.item.root.position.y = p.y;
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
      /* already released */
    }
    const name = itemName(item);
    if (!dragMoved) {
      // Click without move = select only (already selected in pointerdown)
      setStatus(selectionStatus(item));
      return;
    }
    // Scene → layout mm (undo X mirror on position.x)
    const pos = item.root.position;
    item.placement.x_mm = Math.round(-pos.x / MM);
    item.placement.y_mm = Math.round(pos.y / MM);
    const floor = item.placement.floor ?? 0;
    const nextRoom = roomAtLayoutOrNearest(floor, item.placement.x_mm, item.placement.y_mm);
    if (nextRoom) {
      item.placement.room = nextRoom;
      for (const mesh of item.meshes) {
        mesh.userData.twinRoom = nextRoom;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) updateMaterialRoom(mat, nextRoom);
      }
    }
    setStatus(`Saving <b>${name}</b>…`);
    try {
      await persistPlacements();
      setStatus(
        `Saved <b>${name}</b> → (${item.placement.x_mm}, ${item.placement.y_mm}) mm · ${item.placement.room} · ${selectionStatus(item)}`,
      );
    } catch (err) {
      console.error(err);
      setStatus(`Save failed: ${err.message || err}`);
    }
  }

  function onKeyDown(ev) {
    if (state.mode === 'walk') return;
    if (state.look !== 'real' || state.show.furniture === false) return;
    if (dragging) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    const key = ev.key;
    if (key === 'r' || key === 'R' || key === 'e' || key === 'E' || key === ']') {
      ev.preventDefault();
      rotateSelected(90);
    } else if (key === 'q' || key === 'Q' || key === '[') {
      ev.preventDefault();
      rotateSelected(-90);
    } else if (key === 'Escape' && selected) {
      clearSelection();
      setStatus('Furniture deselected');
    }
  }

  const el = renderer.domElement;
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  const btnCcw = document.getElementById('btn-furn-rot-ccw');
  const btnCw = document.getElementById('btn-furn-rot-cw');
  if (btnCcw) btnCcw.addEventListener('click', () => rotateSelected(-90));
  if (btnCw) btnCw.addEventListener('click', () => rotateSelected(90));

  applyVisibility();

  return {
    group,
    items,
    placementsDoc,
    applyVisibility,
    isDragging: () => dragging != null,
    getSelected: () => selected,
    rotateSelected,
    clearSelection,
    consumeClickSuppress() {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    },
  };
}

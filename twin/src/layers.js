/* Indoor lighting scope for the home twin (Real mode).
 *
 * three.js PointLight/SpotLight do not occlude through walls (unless shadows
 * are used). WebGLRenderer also does NOT mask lights per-object via
 * THREE.Layers — uniforms are shared by every mesh.
 *
 * Approach:
 *   1. Tag every surface + Hue/bounce light with a twin room id.
 *   2. Patch Real materials so each Point/Spot is scaled by a room↔room
 *      coupling weight (see portals.js): 1 in-room, attenuated through
 *      doors/windows/openings/stairs, 0 when only a solid wall separates.
 *   3. Non-room exterior shell (roofs, fascias, outer brick with no room)
 *      uses room index 0 → coupling row is all zeros → no indoor Hue.
 *   4. Sun/moon Directional + Hemisphere + IBL are unchanged.
 */

import {
  MAX_ROOMS,
  ROOM_COUPLING,
  roomIndex,
} from './portals.js';

/** Outdoor / semi-outdoor rooms that participate in the portal graph. */
export const EXTERIOR_ROOMS = new Set(['carport', 'dining-patio']);

/** Shared light→room index lists (filled each frame by syncIndoorLightRoomIds). */
export const indoorLightRoomUniforms = {
  pointRooms: { value: new Float32Array(64) },
  spotRooms: { value: new Float32Array(64) },
  coupling: { value: ROOM_COUPLING },
};

/**
 * True when a house mesh should be treated as an interior (or exterior-room)
 * surface that can receive Hue via room coupling. Pure outdoor shell → false.
 */
export function isInteriorSurface(entry, meshName = '') {
  if (!entry) return false;
  const room = entry.room ?? (entry.kind === 'room' ? entry.id : null);
  if (room && EXTERIOR_ROOMS.has(room)) return false;
  if (entry.id && EXTERIOR_ROOMS.has(entry.id)) return false;

  // Underside / soffit twins of exterior structure — not room paint.
  if (typeof entry.id === 'string' && entry.id.endsWith('-underside')) return false;

  // Room-side paint split from an external brick leaf (name ends -paint).
  // Checked after underside so floor soffit twins stay outdoor.
  if (typeof meshName === 'string' && meshName.endsWith('-paint')) return true;

  const k = entry.kind;
  if (
    k === 'external'
    || k === 'cladding'
    || k === 'roof'
    || k === 'fascia'
    || k === 'soffit'
    || k === 'block'
  ) {
    return false;
  }
  if (k === 'floor') {
    if (entry.wall === 'external' || entry.wall === 'block') return false;
    const id = entry.id || '';
    if (/carport|patio|ext-/.test(id)) return false;
  }
  if (k === 'door-out' || k === 'frame-out') return false;

  return true;
}

/**
 * Resolve the twin room id for a house mesh (for light coupling).
 * Exterior shell with no room → null (index 0, no Hue).
 * Carport / patio meshes → their exterior room id (portal-attenuated Hue only).
 */
export function twinRoomForEntry(entry, meshName = '') {
  if (!entry) return null;
  if (entry.room) return entry.room;
  if (entry.kind === 'room' && entry.id) return entry.id;

  const id = entry.id || '';
  const name = meshName || '';
  const blob = `${id} ${name}`;

  if (/carport/.test(blob)) return 'carport';
  if (/patio|dining-patio/.test(blob)) return 'dining-patio';

  // Pure outdoor shell — roofs, fascias, outer brick/block, soffits, etc.
  if (!isInteriorSurface(entry, meshName)) return null;

  // Untagged interior (stair plaster, paint twins of ext walls): caller should
  // probe geometry; we return null here so main can fill from roomAt.
  return null;
}

/**
 * Walk visible lights in the same order WebGLRenderer gathers them and write
 * twin room indices into the shared uniform arrays.
 * @param {import('three').Scene} scene
 * @param {import('three').Camera} camera
 */
export function syncIndoorLightRoomIds(scene, camera) {
  const pr = indoorLightRoomUniforms.pointRooms.value;
  const sr = indoorLightRoomUniforms.spotRooms.value;
  pr.fill(0);
  sr.fill(0);
  let pi = 0;
  let si = 0;
  const layers = camera.layers;
  scene.traverseVisible((obj) => {
    if (!obj.isLight) return;
    if (!obj.layers.test(layers)) return;
    const idx = obj.userData?.twinRoomIndex ?? 0;
    if (obj.isPointLight) {
      if (pi < 64) pr[pi++] = idx;
    } else if (obj.isSpotLight) {
      if (si < 64) sr[si++] = idx;
    }
  });
}

/**
 * Patch a MeshStandard/Physical material so Point/Spot contribution is scaled
 * by room coupling (and AmbientLight Hue wash is dropped — per-room bounce
 * PointLights replace it). Sun/moon Directional + hemi + IBL still apply.
 * @param {import('three').Material} material
 * @param {string | null} roomId twin room, or null for exterior shell
 */
export function scopeMaterialToRoom(material, roomId) {
  if (!material || material.userData?._roomScope) return;
  material.userData = material.userData || {};
  material.userData._roomScope = true;
  material.userData.twinRoom = roomId || null;
  const myIndex = roomIndex(roomId);
  material.userData.twinRoomIndex = myIndex;

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);

    shader.uniforms.uMyRoom = { value: myIndex };
    shader.uniforms.uPointLightRoom = indoorLightRoomUniforms.pointRooms;
    shader.uniforms.uSpotLightRoom = indoorLightRoomUniforms.spotRooms;
    shader.uniforms.uRoomCoupling = indoorLightRoomUniforms.coupling;
    material.userData._roomScopeUniforms = {
      uMyRoom: shader.uniforms.uMyRoom,
    };

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform float uMyRoom;
uniform float uPointLightRoom[64];
uniform float uSpotLightRoom[64];
uniform float uRoomCoupling[${MAX_ROOMS * MAX_ROOMS}];
float twinRoomWeight(const in float lightRoom) {
  int mr = int(uMyRoom + 0.5);
  int lr = int(lightRoom + 0.5);
  if (mr <= 0 || lr <= 0) return 0.0;
  return uRoomCoupling[mr * ${MAX_ROOMS} + lr];
}
`,
    );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        /getPointLightInfo\( pointLight, geometryPosition, directLight \);/g,
        'getPointLightInfo( pointLight, geometryPosition, directLight ); directLight.color *= twinRoomWeight( uPointLightRoom[ UNROLLED_LOOP_INDEX ] );',
      )
      .replace(
        /getSpotLightInfo\( spotLight, geometryPosition, directLight \);/g,
        'getSpotLightInfo( spotLight, geometryPosition, directLight ); directLight.color *= twinRoomWeight( uSpotLightRoom[ UNROLLED_LOOP_INDEX ] );',
      );

    // Drop scene AmbientLight (Hue bounce wash). Per-room bounce PointLights
    // carry fill; a global ambient would ignore walls/portals.
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
      'vec3 irradiance = vec3( 0.0 ); // room-scope: no global Hue ambient',
    );
  };

  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => {
    const base = prevKey ? prevKey() : '';
    return `${base}|roomScope:${myIndex}`;
  };
  material.needsUpdate = true;
}

/** @deprecated use scopeMaterialToRoom(mat, null) — kept for call-site clarity */
export function stripIndoorLightsFromMaterial(material) {
  scopeMaterialToRoom(material, null);
}

/**
 * Update room id on an already-scoped material (placement drag).
 * @param {import('three').Material} material
 * @param {string | null} roomId
 */
export function updateMaterialRoom(material, roomId) {
  if (!material) return;
  if (!material.userData?._roomScope) {
    scopeMaterialToRoom(material, roomId);
    return;
  }
  const myIndex = roomIndex(roomId);
  material.userData.twinRoom = roomId || null;
  material.userData.twinRoomIndex = myIndex;
  // onBeforeCompile may have already run — patch live uniform if present.
  const u = material.userData._roomScopeUniforms;
  if (u?.uMyRoom) u.uMyRoom.value = myIndex;
  material.needsUpdate = true;
}

import { ROOM_FLOORS } from './roomLookup.js';

/* Portal graph for Real-mode indoor lighting.
 *
 * three.js Point/Spot lights do not occlude on walls. We approximate
 * "walls block, openings leak" by:
 *   1. Tagging every Hue/bounce light and every surface with a twin room id
 *   2. Multiplying each light's contribution by a room↔room coupling weight
 *
 * Coupling is 1 in the same room, and attenuates across doors / windows /
 * openings / stairs from layouts/*.json (plus a few synthetic gaps the
 * layout encodes as missing wall rather than an openings[] entry).
 * No path ⇒ weight 0 ⇒ no cross-room spill through solid walls.
 */

/** @type {{ floor: number, a: string, b: string, kind: string, id: string }[]} */
export const PORTALS = [
  // Ground — probed from layouts/ground-floor.json + synthetics
  { floor: 0, a: 'carport', b: 'family-dining', kind: 'window', id: 'win-g-family-w' },
  { floor: 0, a: 'kitchen', b: 'understair-0', kind: 'door', id: 'door-g-cupboard' },
  { floor: 0, a: 'hall-0', b: 'study', kind: 'door', id: 'door-g-study' },
  { floor: 0, a: 'hall-0', b: 'wc', kind: 'door', id: 'door-g-wc' },
  { floor: 0, a: 'hall-0', b: 'utility-0', kind: 'door', id: 'door-g-utility' },
  { floor: 0, a: 'family-dining', b: 'kitchen', kind: 'opening', id: 'kit-fam-open-950' },
  { floor: 0, a: 'dining-patio', b: 'family-dining', kind: 'opening', id: 'patio-opening' },
  // First
  { floor: 1, a: 'bedroom-1', b: 'ensuite-1', kind: 'door', id: 'door-1-ens' },
  { floor: 1, a: 'bathroom', b: 'landing-1', kind: 'door', id: 'door-1-bath' },
  { floor: 1, a: 'bedroom-1', b: 'landing-1', kind: 'door', id: 'door-1-bed1' },
  { floor: 1, a: 'landing-1', b: 'storage-1', kind: 'door', id: 'door-1-store' },
  { floor: 1, a: 'landing-1', b: 'lounge', kind: 'door', id: 'door-1-lounge' },
  { floor: 1, a: 'bedroom-1', b: 'landing-1', kind: 'opening', id: 'bed1-opening' },
  // Second
  { floor: 2, a: 'bedroom-3', b: 'landing-2', kind: 'door', id: 'door-2-bed3' },
  { floor: 2, a: 'bedroom-2', b: 'landing-2', kind: 'door', id: 'door-2-bed2' },
  { floor: 2, a: 'bedroom-2', b: 'ensuite-2', kind: 'door', id: 'door-2-ens' },
  { floor: 2, a: 'cylinder-2', b: 'landing-2', kind: 'door', id: 'door-2-cyl' },
  // Vertical circulation
  { floor: 0, a: 'hall-0', b: 'landing-1', kind: 'stair', id: 'stair-0-1' },
  { floor: 1, a: 'landing-1', b: 'landing-2', kind: 'stair', id: 'stair-1-2' },
];

/** Per-portal-kind attenuation when crossing into the neighbour. */
const EDGE_WEIGHT = {
  door: 0.42,
  window: 0.2,
  french: 0.35,
  opening: 0.55,
  stair: 0.16,
};

/** Max rooms in the coupling table (index 0 = non-room exterior shell). */
export const MAX_ROOMS = 32;

/** @type {string[]} index → room id; [0] is '' (exterior / no Hue) */
export const ROOM_BY_INDEX = [''];

/** @type {Map<string, number>} */
const INDEX_BY_ROOM = new Map();

function ensureRoom(id) {
  if (!id) return 0;
  let idx = INDEX_BY_ROOM.get(id);
  if (idx != null) return idx;
  if (ROOM_BY_INDEX.length >= MAX_ROOMS) {
    console.warn('[portals] MAX_ROOMS exceeded, ignoring', id);
    return 0;
  }
  idx = ROOM_BY_INDEX.length;
  ROOM_BY_INDEX.push(id);
  INDEX_BY_ROOM.set(id, idx);
  return idx;
}

// Register every layout room + portal endpoint so indices are stable before
// the coupling matrix is built.
for (const f of ROOM_FLOORS) {
  for (const r of f.rooms) ensureRoom(r.id);
}
for (const p of PORTALS) {
  ensureRoom(p.a);
  ensureRoom(p.b);
}

/**
 * @param {string | null | undefined} roomId
 * @returns {number} 0 = exterior shell (no indoor Hue)
 */
export function roomIndex(roomId) {
  if (!roomId) return 0;
  return ensureRoom(roomId);
}

/**
 * Build dense coupling[surfRoom * MAX + lightRoom] ∈ [0,1].
 * Same room → 1. Best product of edge weights across portal paths.
 */
export function buildCouplingMatrix() {
  const n = MAX_ROOMS;
  const out = new Float32Array(n * n);
  /** @type {Map<string, { id: string, w: number }[]>} */
  const adj = new Map();
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, w });
  };
  for (const p of PORTALS) {
    const w = EDGE_WEIGHT[p.kind] ?? 0.35;
    link(p.a, p.b, w);
    link(p.b, p.a, w);
  }

  /** Semi-outdoor rooms: only direct portal neighbours may spill in (no multi-hop). */
  const EXTERIOR = new Set(['carport', 'dining-patio']);

  const roomIds = ROOM_BY_INDEX.slice(1);
  for (const src of roomIds) {
    const si = roomIndex(src);
    out[si * n + si] = 1;
    // Dijkstra-style max-product. Do not route through exterior rooms.
    /** @type {Map<string, number>} */
    const best = new Map([[src, 1]]);
    const queue = [src];
    while (queue.length) {
      let qi = 0;
      for (let i = 1; i < queue.length; i++) {
        if ((best.get(queue[i]) ?? 0) > (best.get(queue[qi]) ?? 0)) qi = i;
      }
      const u = queue.splice(qi, 1)[0];
      // Lights in an exterior room still fill that room; they do not seed further hops.
      if (EXTERIOR.has(u) && u !== src) continue;
      const bu = best.get(u) ?? 0;
      for (const { id: v, w } of adj.get(u) ?? []) {
        const next = bu * w;
        if (next < 0.02) continue;
        // Exterior surfaces only accept 1-hop (direct door/window/opening).
        if (EXTERIOR.has(v) && u !== src) continue;
        if (next > (best.get(v) ?? 0)) {
          best.set(v, next);
          if (!queue.includes(v)) queue.push(v);
        }
      }
    }
    for (const [dst, w] of best) {
      if (dst === src) continue;
      out[roomIndex(dst) * n + si] = w;
    }
  }
  return out;
}

/** Shared coupling table (surfRoom row × lightRoom col). */
export const ROOM_COUPLING = buildCouplingMatrix();

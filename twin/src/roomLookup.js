/* Room point-in-polygon lookup from layouts/*.json (layout mm).
 * Used by furniture/lights drag-save to refresh placement.room.
 * Regenerated manually when room polygons change — keep in sync with layouts/.
 */

/** @type {{ floor: number, rooms: { id: string, polygon_mm: number[][] }[] }[]} */
export const ROOM_FLOORS = [
  {
    "floor": 0,
    "rooms": [
      {
        "id": "family-dining",
        "polygon_mm": [
          [
            300,
            300
          ],
          [
            4520,
            300
          ],
          [
            4520,
            3350
          ],
          [
            300,
            3350
          ]
        ]
      },
      {
        "id": "kitchen",
        "polygon_mm": [
          [
            1400,
            3350
          ],
          [
            2350,
            3350
          ],
          [
            2350,
            3450
          ],
          [
            4520,
            3450
          ],
          [
            4520,
            6550
          ],
          [
            2516,
            6550
          ],
          [
            2516,
            5190
          ],
          [
            1400,
            5190
          ]
        ]
      },
      {
        "id": "study",
        "polygon_mm": [
          [
            2516,
            6650
          ],
          [
            4520,
            6650
          ],
          [
            4520,
            9080
          ],
          [
            2516,
            9080
          ]
        ]
      },
      {
        "id": "wc",
        "polygon_mm": [
          [
            300,
            6274
          ],
          [
            1337,
            6274
          ],
          [
            1337,
            8043
          ],
          [
            300,
            8043
          ]
        ]
      },
      {
        "id": "utility-0",
        "polygon_mm": [
          [
            300,
            8143
          ],
          [
            1337,
            8143
          ],
          [
            1337,
            9080
          ],
          [
            300,
            9080
          ]
        ]
      },
      {
        "id": "hall-0",
        "polygon_mm": [
          [
            1300,
            5290
          ],
          [
            2416,
            5290
          ],
          [
            2416,
            9080
          ],
          [
            1437,
            9080
          ],
          [
            1437,
            6174
          ],
          [
            300,
            6174
          ],
          [
            300,
            5290
          ]
        ]
      },
      {
        "id": "understair-0",
        "polygon_mm": [
          [
            300,
            3450
          ],
          [
            1300,
            3450
          ],
          [
            1300,
            5190
          ],
          [
            300,
            5190
          ]
        ]
      },
      {
        "id": "carport",
        "polygon_mm": [
          [
            -3174,
            1800
          ],
          [
            0,
            1800
          ],
          [
            0,
            7886
          ],
          [
            -3174,
            7886
          ]
        ]
      },
      {
        "id": "dining-patio",
        "polygon_mm": [
          [
            1330,
            -1150
          ],
          [
            3510,
            -1150
          ],
          [
            3510,
            -60
          ],
          [
            3430,
            -60
          ],
          [
            3430,
            300
          ],
          [
            1430,
            300
          ],
          [
            1430,
            -60
          ],
          [
            1330,
            -60
          ]
        ]
      }
    ]
  },
  {
    "floor": 1,
    "rooms": [
      {
        "id": "bedroom-1",
        "polygon_mm": [
          [
            -3174,
            2100
          ],
          [
            0,
            2100
          ],
          [
            0,
            2454
          ],
          [
            1660,
            2454
          ],
          [
            1660,
            3338
          ],
          [
            0,
            3338
          ],
          [
            0,
            7586
          ],
          [
            -3174,
            7586
          ]
        ]
      },
      {
        "id": "ensuite-1",
        "polygon_mm": [
          [
            300,
            300
          ],
          [
            2421,
            300
          ],
          [
            2421,
            2354
          ],
          [
            300,
            2354
          ]
        ]
      },
      {
        "id": "bathroom",
        "polygon_mm": [
          [
            2521,
            300
          ],
          [
            4520,
            300
          ],
          [
            4520,
            3359
          ],
          [
            2900,
            3359
          ],
          [
            2900,
            2354
          ],
          [
            2521,
            2354
          ]
        ]
      },
      {
        "id": "storage-1",
        "polygon_mm": [
          [
            2900,
            3459
          ],
          [
            4520,
            3459
          ],
          [
            4520,
            4638
          ],
          [
            2900,
            4638
          ]
        ]
      },
      {
        "id": "lounge",
        "polygon_mm": [
          [
            300,
            6274
          ],
          [
            2900,
            6274
          ],
          [
            2900,
            4738
          ],
          [
            4520,
            4738
          ],
          [
            4520,
            9080
          ],
          [
            300,
            9080
          ]
        ]
      },
      {
        "id": "landing-1",
        "polygon_mm": [
          [
            1760,
            2454
          ],
          [
            2800,
            2454
          ],
          [
            2800,
            6174
          ],
          [
            1300,
            6174
          ],
          [
            1300,
            5332
          ],
          [
            1480,
            5332
          ],
          [
            1480,
            4280
          ],
          [
            1300,
            4280
          ],
          [
            1300,
            3438
          ],
          [
            1760,
            3438
          ]
        ]
      }
    ]
  },
  {
    "floor": 2,
    "rooms": [
      {
        "id": "bedroom-3",
        "polygon_mm": [
          [
            300,
            300
          ],
          [
            4520,
            300
          ],
          [
            4520,
            3338
          ],
          [
            300,
            3338
          ]
        ]
      },
      {
        "id": "bedroom-2",
        "polygon_mm": [
          [
            300,
            6274
          ],
          [
            1580,
            6274
          ],
          [
            1580,
            5784
          ],
          [
            4520,
            5784
          ],
          [
            4520,
            9080
          ],
          [
            300,
            9080
          ]
        ]
      },
      {
        "id": "landing-2",
        "polygon_mm": [
          [
            1300,
            3438
          ],
          [
            2582,
            3438
          ],
          [
            2582,
            4338
          ],
          [
            2322,
            4338
          ],
          [
            2322,
            5684
          ],
          [
            1480,
            5684
          ],
          [
            1480,
            4280
          ],
          [
            1300,
            4280
          ]
        ]
      },
      {
        "id": "cylinder-2",
        "polygon_mm": [
          [
            2682,
            3438
          ],
          [
            3432,
            3438
          ],
          [
            3432,
            4338
          ],
          [
            2682,
            4338
          ]
        ]
      },
      {
        "id": "ensuite-2",
        "polygon_mm": [
          [
            2422,
            4438
          ],
          [
            3532,
            4438
          ],
          [
            3532,
            3438
          ],
          [
            4520,
            3438
          ],
          [
            4520,
            5684
          ],
          [
            2422,
            5684
          ]
        ]
      }
    ]
  }
];

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-30) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function centroid(poly) {
  let sx = 0, sy = 0;
  for (const [x, y] of poly) { sx += x; sy += y; }
  const n = poly.length || 1;
  return [sx / n, sy / n];
}

/**
 * @param {number} floor
 * @param {number} xMm layout mm
 * @param {number} yMm layout mm
 * @returns {string | null} twin room id, or null if outside all rooms on that floor
 */
export function roomAtLayout(floor, xMm, yMm) {
  const entry = ROOM_FLOORS.find((f) => f.floor === floor);
  if (!entry) return null;
  for (const r of entry.rooms) {
    if (pointInPoly(xMm, yMm, r.polygon_mm)) return r.id;
  }
  return null;
}

/**
 * Prefer containing room on `floor`; else nearest room centroid on that floor
 * (doorway / wall-edge placements).
 * @param {number} floor
 * @param {number} xMm
 * @param {number} yMm
 * @returns {string | null}
 */
export function roomAtLayoutOrNearest(floor, xMm, yMm) {
  const hit = roomAtLayout(floor, xMm, yMm);
  if (hit) return hit;
  const entry = ROOM_FLOORS.find((f) => f.floor === floor);
  if (!entry?.rooms?.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const r of entry.rooms) {
    const [cx, cy] = centroid(r.polygon_mm);
    const d = (cx - xMm) ** 2 + (cy - yMm) ** 2;
    if (d < bestD) { bestD = d; best = r.id; }
  }
  return best;
}


/**
 * Seeds the Chores app tables from the home-twin model (rooms, windows,
 * light placements) plus the family's fixture list. Idempotent: re-running
 * updates each row in place. Run AFTER the ApiStack deploy has created the
 * wainwright-chores-* tables:
 *   AWS_PROFILE=email AWS_REGION=us-east-1 npx tsx scripts/seed-chores.ts
 *
 * Ticket maths (see cdk/lambda/chores-routes.ts):
 *   tickets = round(base_tickets × size_factor × days_overdue / reset_days)
 *   size_factor = room_area_m2 / 12 (rooms only; fixtures/windows/switches = 1)
 *   days_overdue = days since last completion (never below 0)
 * So a chore freshly completed earns 0 tickets and grows to its full
 * base_tickets × size_factor at reset_days overdue.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ROOMS_TABLE = "wainwright-chores-rooms";
const FIXTURES_TABLE = "wainwright-chores-fixtures";
const WINDOWS_TABLE = "wainwright-chores-windows";
const SWITCHES_TABLE = "wainwright-chores-switches";
const CHORES_TABLE = "wainwright-chores";

const now = new Date().toISOString();

// ── Rooms (from ~/Documents/home-twin/data/rooms.json + layout polygons) ──
// carpeted: bedrooms + lounge + landing/stairs; hard: kitchen, bathrooms,
// WC, ensuites, utility, hall, study, dining area.
interface Room {
  room_id: string;
  name: string;
  floor: number;
  carpeted: boolean;
  area_m2: number;
}

const ROOMS: Room[] = [
  // Ground floor
  { room_id: "family-dining", name: "Family / Dining", floor: 0, carpeted: false, area_m2: 12.9 },
  { room_id: "kitchen", name: "Kitchen", floor: 0, carpeted: false, area_m2: 8.2 },
  { room_id: "study", name: "Study", floor: 0, carpeted: false, area_m2: 4.9 },
  { room_id: "wc", name: "WC", floor: 0, carpeted: false, area_m2: 1.8 },
  { room_id: "utility-0", name: "Utility", floor: 0, carpeted: false, area_m2: 1.0 },
  { room_id: "hall-0", name: "Hall", floor: 0, carpeted: false, area_m2: 4.7 },
  // First floor
  { room_id: "lounge", name: "Lounge", floor: 1, carpeted: true, area_m2: 14.3 },
  { room_id: "bedroom-1", name: "Bedroom 1", floor: 1, carpeted: true, area_m2: 18.9 },
  { room_id: "ensuite-1", name: "Ensuite 1", floor: 1, carpeted: false, area_m2: 4.4 },
  { room_id: "bathroom", name: "Bathroom", floor: 1, carpeted: false, area_m2: 5.7 },
  { room_id: "landing-1", name: "Landing", floor: 1, carpeted: true, area_m2: 4.9 },
  // Second floor
  { room_id: "bedroom-2", name: "Bedroom 2", floor: 2, carpeted: true, area_m2: 13.3 },
  { room_id: "bedroom-3", name: "Bedroom 3", floor: 2, carpeted: true, area_m2: 12.8 },
  { room_id: "ensuite-2", name: "Ensuite 2", floor: 2, carpeted: false, area_m2: 4.7 },
  { room_id: "landing-2", name: "Landing", floor: 2, carpeted: true, area_m2: 2.3 },
];

// ── Fixtures (furniture with jobs) ────────────────────────────────────
interface Fixture {
  fixture_id: string;
  room_id: string;
  kind: string;
  name: string;
}

const FIXTURES: Fixture[] = [
  // bathroom, WC + ensuites
  { fixture_id: "toilet-bathroom", room_id: "bathroom", kind: "toilet", name: "Toilet" },
  { fixture_id: "toilet-wc", room_id: "wc", kind: "toilet", name: "Toilet" },
  { fixture_id: "toilet-ensuite-1", room_id: "ensuite-1", kind: "toilet", name: "Toilet" },
  { fixture_id: "toilet-ensuite-2", room_id: "ensuite-2", kind: "toilet", name: "Toilet" },
  { fixture_id: "roll-holder-bathroom", room_id: "bathroom", kind: "toilet-roll-holder", name: "Toilet roll holder" },
  { fixture_id: "roll-holder-wc", room_id: "wc", kind: "toilet-roll-holder", name: "Toilet roll holder" },
  { fixture_id: "roll-holder-ensuite-1", room_id: "ensuite-1", kind: "toilet-roll-holder", name: "Toilet roll holder" },
  { fixture_id: "roll-holder-ensuite-2", room_id: "ensuite-2", kind: "toilet-roll-holder", name: "Toilet roll holder" },
  { fixture_id: "shower-ensuite-1", room_id: "ensuite-1", kind: "shower", name: "Shower" },
  { fixture_id: "shower-ensuite-2", room_id: "ensuite-2", kind: "shower", name: "Shower" },
  { fixture_id: "bath-bathroom", room_id: "bathroom", kind: "bath", name: "Bath" },
  { fixture_id: "sink-bathroom", room_id: "bathroom", kind: "sink", name: "Sink" },
  { fixture_id: "sink-wc", room_id: "wc", kind: "sink", name: "Sink" },
  { fixture_id: "sink-ensuite-1", room_id: "ensuite-1", kind: "sink", name: "Sink" },
  { fixture_id: "sink-ensuite-2", room_id: "ensuite-2", kind: "sink", name: "Sink" },
  { fixture_id: "bin-bathroom", room_id: "bathroom", kind: "regular-bin", name: "Bin" },
  { fixture_id: "bin-wc", room_id: "wc", kind: "regular-bin", name: "Bin" },
  { fixture_id: "bin-ensuite-1", room_id: "ensuite-1", kind: "regular-bin", name: "Bin" },
  { fixture_id: "bin-ensuite-2", room_id: "ensuite-2", kind: "regular-bin", name: "Bin" },
  // bedrooms + kitchen
  { fixture_id: "bin-bedroom-2", room_id: "bedroom-2", kind: "regular-bin", name: "Bin" },
  { fixture_id: "bin-bedroom-3", room_id: "bedroom-3", kind: "regular-bin", name: "Bin" },
  { fixture_id: "bin-kitchen", room_id: "kitchen", kind: "regular-bin", name: "Bin" },
  { fixture_id: "recycling-kitchen", room_id: "kitchen", kind: "recycling-bin", name: "Recycling" },
  // kitchen appliances
  { fixture_id: "dishwasher-kitchen", room_id: "kitchen", kind: "dishwasher", name: "Dishwasher" },
  { fixture_id: "microwave-kitchen", room_id: "kitchen", kind: "microwave", name: "Microwave" },
  { fixture_id: "oven-kitchen", room_id: "kitchen", kind: "oven", name: "Oven" },
  { fixture_id: "air-fryer-kitchen", room_id: "kitchen", kind: "air-fryer", name: "Air fryer" },
  { fixture_id: "coffee-maker-kitchen", room_id: "kitchen", kind: "coffee-maker", name: "Coffee maker" },
  { fixture_id: "toaster-kitchen", room_id: "kitchen", kind: "toaster", name: "Toaster" },
  { fixture_id: "counter-kitchen", room_id: "kitchen", kind: "kitchen-counter", name: "Kitchen counter" },
  // utility
  { fixture_id: "washing-machine-utility", room_id: "utility-0", kind: "washing-machine", name: "Washing machine" },
  // lounge
  { fixture_id: "tv-lounge", room_id: "lounge", kind: "tv", name: "TV" },
  { fixture_id: "sofas-lounge", room_id: "lounge", kind: "sofa", name: "Sofas" },
  // study
  { fixture_id: "desks-study", room_id: "study", kind: "desk", name: "Desks" },
  // dining
  { fixture_id: "table-dining", room_id: "family-dining", kind: "table", name: "Table" },
];

// ── Windows (from the twin layouts' wall openings, kind=window) ────────
interface Window {
  window_id: string;
  room_id: string;
  name: string;
}

const WINDOWS: Window[] = [
  { window_id: "win-1-ens-n", room_id: "ensuite-1", name: "Ensuite 1 window" },
  { window_id: "win-1-bath-n", room_id: "bathroom", name: "Bathroom window" },
  { window_id: "win-1-bed1-n", room_id: "bedroom-1", name: "Bedroom 1 north window" },
  { window_id: "win-1-bed1-s", room_id: "bedroom-1", name: "Bedroom 1 south window" },
  { window_id: "win-g-study-s", room_id: "study", name: "Study window" },
  { window_id: "win-g-family-w", room_id: "family-dining", name: "Family / Dining window" },
  { window_id: "win-2-bed3-n1", room_id: "bedroom-3", name: "Bedroom 3 window 1" },
  { window_id: "win-2-bed3-n2", room_id: "bedroom-3", name: "Bedroom 3 window 2" },
  { window_id: "win-2-bed2-s1", room_id: "bedroom-2", name: "Bedroom 2 window 1" },
  { window_id: "win-2-bed2-s2", room_id: "bedroom-2", name: "Bedroom 2 window 2" },
];

// ── Light switches/sensors (one per room with Hue lights, from the twin
// light placements; battery_dead is synced from the Hue app later) ──────
interface Switch {
  switch_id: string;
  room_id: string;
  name: string;
  battery_dead: boolean;
}

const SWITCHES: Switch[] = [
  { switch_id: "switch-study", room_id: "study", name: "Study light switch", battery_dead: false },
  { switch_id: "switch-kitchen", room_id: "kitchen", name: "Kitchen light switch", battery_dead: false },
  { switch_id: "switch-family-dining", room_id: "family-dining", name: "Family / Dining light switch", battery_dead: false },
  { switch_id: "switch-lounge", room_id: "lounge", name: "Lounge light switch", battery_dead: false },
  { switch_id: "switch-utility-0", room_id: "utility-0", name: "Utility light switch", battery_dead: false },
  { switch_id: "switch-landing-1", room_id: "landing-1", name: "Landing light switch", battery_dead: false },
  { switch_id: "switch-wc", room_id: "wc", name: "WC light switch", battery_dead: false },
  { switch_id: "switch-hall-0", room_id: "hall-0", name: "Hall light switch", battery_dead: false },
  { switch_id: "switch-bedroom-2", room_id: "bedroom-2", name: "Bedroom 2 light switch", battery_dead: false },
  { switch_id: "switch-bedroom-3", room_id: "bedroom-3", name: "Bedroom 3 light switch", battery_dead: false },
  { switch_id: "switch-bedroom-1", room_id: "bedroom-1", name: "Bedroom 1 light switch", battery_dead: false },
  { switch_id: "switch-landing-2", room_id: "landing-2", name: "Landing light switch", battery_dead: false },
  { switch_id: "switch-ensuite-1", room_id: "ensuite-1", name: "Ensuite 1 light switch", battery_dead: false },
  { switch_id: "switch-bathroom", room_id: "bathroom", name: "Bathroom light switch", battery_dead: false },
];

// ── Chores ────────────────────────────────────────────────────────────
// base_tickets: full reward at reset_days overdue, at the reference
// room size (12 m²). Room-size scaling happens at read time.
interface Chore {
  chore_id: string;
  title: string;
  target_type: "room" | "fixture" | "window" | "switch";
  target_id: string;
  base_tickets: number;
  reset_days: number;
}

const CHORES: Chore[] = [
  // Room chores — carpeted rooms get vacuum, hard floors get sweep/mop
  ...ROOMS.filter((r) => r.carpeted).map((r) => ({
    chore_id: `vacuum-${r.room_id}`,
    title: `Vacuum the ${r.name}`,
    target_type: "room" as const,
    target_id: r.room_id,
    base_tickets: 2,
    reset_days: 7,
  })),
  ...ROOMS.filter((r) => !r.carpeted).map((r) => ({
    chore_id: `sweep-mop-${r.room_id}`,
    title: `Sweep and mop the ${r.name}`,
    target_type: "room" as const,
    target_id: r.room_id,
    base_tickets: 2,
    reset_days: 7,
  })),
  ...ROOMS.map((r) => ({
    chore_id: `dust-${r.room_id}`,
    title: `Quick dust the ${r.name}`,
    target_type: "room" as const,
    target_id: r.room_id,
    base_tickets: 1,
    reset_days: 14,
  })),
  // Window chores
  ...WINDOWS.map((w) => ({
    chore_id: `clean-${w.window_id}`,
    title: `Clean the ${w.name}`,
    target_type: "window" as const,
    target_id: w.window_id,
    base_tickets: 1,
    reset_days: 30,
  })),
  // Switch chores — dust always; batteries only when dead
  ...SWITCHES.map((s) => ({
    chore_id: `dust-${s.switch_id}`,
    title: `Dust the ${s.name}`,
    target_type: "switch" as const,
    target_id: s.switch_id,
    base_tickets: 1,
    reset_days: 30,
  })),
  // Fixture chores
  ...FIXTURES.flatMap((f) => fixtureChores(f)),
];

function fixtureChores(f: Fixture): Chore[] {
  switch (f.kind) {
    case "toilet":
      return [
        { chore_id: `brush-${f.fixture_id}`, title: `Brush the ${f.name} bowl`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
        { chore_id: `wipe-${f.fixture_id}`, title: `Wipe the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
      ];
    case "toilet-roll-holder":
      return [
        { chore_id: `fill-${f.fixture_id}`, title: `Fill the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
      ];
    case "shower":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 2, reset_days: 14 },
      ];
    case "bath":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 2, reset_days: 14 },
      ];
    case "sink":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
      ];
    case "regular-bin":
      return [
        { chore_id: `empty-${f.fixture_id}`, title: `Empty the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
      ];
    case "recycling-bin":
      return [
        { chore_id: `empty-${f.fixture_id}`, title: `Empty the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
      ];
    case "dishwasher":
      return [
        { chore_id: `empty-${f.fixture_id}`, title: `Empty the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
        { chore_id: `fill-${f.fixture_id}`, title: `Fill the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 2, reset_days: 30 },
        { chore_id: `salt-${f.fixture_id}`, title: `Fill the salt in the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 30 },
        { chore_id: `rinse-aid-${f.fixture_id}`, title: `Fill the rinse aid in the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 30 },
      ];
    case "washing-machine":
      return [
        { chore_id: `empty-${f.fixture_id}`, title: `Empty the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
        { chore_id: `fill-${f.fixture_id}`, title: `Fill the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 2, reset_days: 30 },
      ];
    case "microwave":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 14 },
      ];
    case "tv":
      return [
        { chore_id: `wipe-${f.fixture_id}`, title: `Wipe the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 14 },
        { chore_id: `dust-${f.fixture_id}`, title: `Dust the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 14 },
      ];
    case "sofa":
      return [
        { chore_id: `vacuum-${f.fixture_id}`, title: `Vacuum under the ${f.name} cushions`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 2, reset_days: 14 },
      ];
    case "desk":
      return [
        { chore_id: `tidy-${f.fixture_id}`, title: `Tidy the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 7 },
        { chore_id: `wipe-${f.fixture_id}`, title: `Wipe the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 14 },
      ];
    case "kitchen-counter":
      return [
        { chore_id: `wipe-${f.fixture_id}`, title: `Wipe the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
      ];
    case "table":
      return [
        { chore_id: `clear-${f.fixture_id}`, title: `Clear the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
        { chore_id: `wipe-${f.fixture_id}`, title: `Wipe the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
      ];
    case "oven":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 3, reset_days: 30 },
      ];
    case "air-fryer":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 14 },
      ];
    case "coffee-maker":
      return [
        { chore_id: `make-${f.fixture_id}`, title: `Make a coffee for a parent`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 1 },
      ];
    case "toaster":
      return [
        { chore_id: `clean-${f.fixture_id}`, title: `Clean the ${f.name}`, target_type: "fixture", target_id: f.fixture_id, base_tickets: 1, reset_days: 14 },
      ];
    default:
      return [];
  }
}

async function put(table: string, item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table, Item: item }));
}

async function main(): Promise<void> {
  console.log(`Seeding ${ROOMS.length} rooms, ${FIXTURES.length} fixtures, ${WINDOWS.length} windows, ${SWITCHES.length} switches, ${CHORES.length} chores…`);

  for (const r of ROOMS) {
    await put(ROOMS_TABLE, { ...r, created_at: now, updated_at: now });
  }
  for (const f of FIXTURES) {
    await put(FIXTURES_TABLE, { ...f, created_at: now, updated_at: now });
  }
  for (const w of WINDOWS) {
    await put(WINDOWS_TABLE, { ...w, created_at: now, updated_at: now });
  }
  for (const s of SWITCHES) {
    await put(SWITCHES_TABLE, { ...s, created_at: now, updated_at: now });
  }
  for (const c of CHORES) {
    await put(CHORES_TABLE, { ...c, enabled: true, created_at: now, updated_at: now });
  }
  for (const r of ROOMS) {
    await put(ROOMS_TABLE, { ...r, enabled: true, created_at: now, updated_at: now });
  }
  for (const f of FIXTURES) {
    await put(FIXTURES_TABLE, { ...f, enabled: true, created_at: now, updated_at: now });
  }
  for (const w of WINDOWS) {
    await put(WINDOWS_TABLE, { ...w, enabled: true, created_at: now, updated_at: now });
  }
  for (const s of SWITCHES) {
    await put(SWITCHES_TABLE, { ...s, enabled: true, created_at: now, updated_at: now });
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

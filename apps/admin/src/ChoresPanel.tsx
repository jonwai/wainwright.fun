import { useCallback, useEffect, useState } from "react";
import {
  deleteChore,
  deleteChoreFixture,
  deleteChoreRoom,
  deleteChoreSwitch,
  deleteChoreWindow,
  getChoreClaims,
  getChoreFixtures,
  getChoreRooms,
  getChores,
  getChoreSwitches,
  getChoreWindows,
  putChore,
  putChoreRoom,
  putChoreSwitch,
  type Chore,
  type ChoreClaim,
  type ChoreFixture,
  type ChoreRoom,
  type ChoreSwitch,
  type ChoreWindow,
} from "./api";

const FLOOR_LABELS = ["Ground", "First", "Second"];

function friendlyDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ChoresPanel({ accessToken }: { accessToken: string }) {
  const [rooms, setRooms] = useState<ChoreRoom[] | null>(null);
  const [fixtures, setFixtures] = useState<ChoreFixture[] | null>(null);
  const [windows, setWindows] = useState<ChoreWindow[] | null>(null);
  const [switches, setSwitches] = useState<ChoreSwitch[] | null>(null);
  const [chores, setChores] = useState<Chore[] | null>(null);
  const [claims, setClaims] = useState<ChoreClaim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, f, w, s, c, cl] = await Promise.all([
        getChoreRooms(accessToken),
        getChoreFixtures(accessToken),
        getChoreWindows(accessToken),
        getChoreSwitches(accessToken),
        getChores(accessToken),
        getChoreClaims(accessToken),
      ]);
      setRooms(r);
      setFixtures(f);
      setWindows(w);
      setSwitches(s);
      setChores(c);
      setClaims(cl);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load chores");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  if (error) {
    return <p className="text-danger font-semibold p-4">{error}</p>;
  }

  if (!rooms || !fixtures || !windows || !switches || !chores || !claims) {
    return <div className="flex justify-center py-10"><div className="spinner" /></div>;
  }

  const roomById = new Map(rooms.map((r) => [r.room_id, r]));
  const fixtureById = new Map(fixtures.map((f) => [f.fixture_id, f]));
  const windowById = new Map(windows.map((w) => [w.window_id, w]));
  const switchById = new Map(switches.map((s) => [s.switch_id, s]));
  const targetName = (chore: Chore): string => {
    switch (chore.target_type) {
      case "room": return roomById.get(chore.target_id)?.name ?? chore.target_id;
      case "fixture": return fixtureById.get(chore.target_id)?.name ?? chore.target_id;
      case "window": return windowById.get(chore.target_id)?.name ?? chore.target_id;
      case "switch": return switchById.get(chore.target_id)?.name ?? chore.target_id;
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {/* ── Rooms ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-extrabold mb-3">Rooms ({rooms.length})</h2>
        <div className="flex flex-col gap-2">
          {rooms.map((room) => (
            <div key={room.room_id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-solid">
              <span className="font-semibold w-40 truncate">{room.name}</span>
              <span className="text-sm text-muted">{FLOOR_LABELS[room.floor]} floor</span>
              <span className="text-sm text-muted">{room.area_m2} m²</span>
              <span className={`text-sm font-semibold ${room.carpeted ? "text-accent" : "text-muted"}`}>
                {room.carpeted ? "carpet" : "hard floor"}
              </span>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-border bg-surface-solid text-sm font-semibold cursor-pointer hover:bg-surface-hover disabled:opacity-50"
                  onClick={() =>
                    void save(() =>
                      putChoreRoom(accessToken, room.room_id, {
                        carpeted: !room.carpeted,
                      }))}
                >
                  {room.carpeted ? "Set hard floor" : "Set carpet"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-danger text-danger text-sm font-semibold cursor-pointer hover:bg-red-50 disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Delete room ${room.name}? Its chores remain but lose their room link.`)) {
                      void save(() => deleteChoreRoom(accessToken, room.room_id));
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Fixtures ──────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-extrabold mb-3">Fixtures ({fixtures.length})</h2>
        <div className="flex flex-col gap-2">
          {fixtures.map((fixture) => (
            <div key={fixture.fixture_id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-solid">
              <span className="font-semibold w-40 truncate">{fixture.name}</span>
              <span className="text-sm text-muted">{fixture.kind}</span>
              <span className="text-sm text-muted">in {roomById.get(fixture.room_id)?.name ?? fixture.room_id}</span>
              <span className="ml-auto">
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-danger text-danger text-sm font-semibold cursor-pointer hover:bg-red-50 disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Delete fixture ${fixture.name}?`)) {
                      void save(() => deleteChoreFixture(accessToken, fixture.fixture_id));
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Windows ───────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-extrabold mb-3">Windows ({windows.length})</h2>
        <div className="flex flex-col gap-2">
          {windows.map((win) => (
            <div key={win.window_id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-solid">
              <span className="font-semibold w-40 truncate">{win.name}</span>
              <span className="text-sm text-muted">in {roomById.get(win.room_id)?.name ?? win.room_id}</span>
              <span className="ml-auto">
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-danger text-danger text-sm font-semibold cursor-pointer hover:bg-red-50 disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Delete window ${win.name}?`)) {
                      void save(() => deleteChoreWindow(accessToken, win.window_id));
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Switches ──────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-extrabold mb-3">Light switches ({switches.length})</h2>
        <p className="text-sm text-muted mb-2">
          "Replace batteries" chores only appear in the app while a switch is marked
          battery-dead (synced from the Hue app later).
        </p>
        <div className="flex flex-col gap-2">
          {switches.map((sw) => (
            <div key={sw.switch_id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-solid">
              <span className="font-semibold w-40 truncate">{sw.name}</span>
              <span className="text-sm text-muted">in {roomById.get(sw.room_id)?.name ?? sw.room_id}</span>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={`min-h-9 px-3 rounded-md border text-sm font-semibold cursor-pointer disabled:opacity-50 ${
                    sw.battery_dead
                      ? "border-danger text-danger hover:bg-red-50"
                      : "border-border bg-surface-solid hover:bg-surface-hover"
                  }`}
                  onClick={() =>
                    void save(() =>
                      putChoreSwitch(accessToken, sw.switch_id, {
                        battery_dead: !sw.battery_dead,
                      }))}
                >
                  {sw.battery_dead ? "Battery dead 🔋" : "Mark battery dead"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-danger text-danger text-sm font-semibold cursor-pointer hover:bg-red-50 disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Delete switch ${sw.name}?`)) {
                      void save(() => deleteChoreSwitch(accessToken, sw.switch_id));
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Chores ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-extrabold mb-3">Chores ({chores.length})</h2>
        <div className="flex flex-col gap-2">
          {chores.map((chore) => (
            <div key={chore.chore_id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-solid">
              <span className="font-semibold flex-1 min-w-0 truncate">{chore.title}</span>
              <span className="text-sm text-muted w-32 truncate">{chore.target_type}</span>
              <span className="text-sm text-muted w-32 truncate">{targetName(chore)}</span>
              <span className="text-sm font-semibold w-20 text-center">{chore.base_tickets} 🎟</span>
              <span className="text-sm text-muted w-20 text-center">every {chore.cadence_days}d</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-border bg-surface-solid text-sm font-semibold cursor-pointer hover:bg-surface-hover disabled:opacity-50"
                  onClick={() =>
                    void save(() =>
                      putChore(accessToken, chore.chore_id, { enabled: !chore.enabled }))}
                >
                  {chore.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-9 px-3 rounded-md border border-danger text-danger text-sm font-semibold cursor-pointer hover:bg-red-50 disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Delete chore ${chore.title}?`)) {
                      void save(() => deleteChore(accessToken, chore.chore_id));
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Claims ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-extrabold mb-3">Active claims ({claims.length})</h2>
        {claims.length === 0 ? (
          <p className="text-sm text-muted">No chores are claimed right now.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {claims.map((claim) => (
              <div key={claim.chore_claim} className="flex items-center gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50">
                <span className="font-semibold w-28 truncate">{claim.child_subdomain}</span>
                <span className="text-sm text-muted flex-1 min-w-0 truncate">
                  {chores.find((c) => c.chore_id === claim.chore_id)?.title ?? claim.chore_id}
                  {" "}· {friendlyDateTime(claim.claimed_at)}
                </span>
                <span className="text-sm font-semibold">{claim.tickets} 🎟</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

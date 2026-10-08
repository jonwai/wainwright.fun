import { useCallback, useEffect, useState } from "react";
import { apiConfig } from "./config";
import { Modal } from "./Modal";

interface Device {
  ip: string;
  mac: string | null;
  personId: string;
  label: string | null;
}

interface Person {
  id: string;
  name: string;
  role: "child" | "parent";
}

interface Draft {
  ip: string;
  personId: string;
  label: string;
  mac: string;
  /** Set while editing an existing row. The IP is the device's identity, so it stays put. */
  originalIp: string | null;
}

const inputClass =
  "w-full bg-surface-solid text-text border border-border rounded-md px-2 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed";

async function call<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiConfig.baseUrl}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `API returned ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

function emptyDraft(people: Person[]): Draft {
  return { ip: "", personId: people[0]?.id ?? "", label: "", mac: "", originalIp: null };
}

export function DevicesPanel({ accessToken }: { accessToken: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [thisIp, setThisIp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, directory, me] = await Promise.all([
        call<Device[]>(accessToken, "admin/devices"),
        call<Person[]>(accessToken, "admin/people"),
        call<{ ip?: string | null }>(accessToken, "me"),
      ]);
      setDevices(rows);
      setPeople(directory);
      setThisIp(me.ip ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  function personName(id: string) {
    const person = people.find((item) => item.id === id);
    return person ? `${person.name} (${person.role})` : id;
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await call(accessToken, "admin/devices", {
        method: "PUT",
        body: JSON.stringify({
          ip: draft.ip.trim(),
          personId: draft.personId,
          label: draft.label.trim() || null,
          mac: draft.mac.trim() || null,
        }),
      });
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(device: Device) {
    setError(null);
    try {
      await call(accessToken, `admin/devices?ip=${encodeURIComponent(device.ip)}`, { method: "DELETE" });
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  if (loading && devices.length === 0 && !error) {
    return <div className="spinner mx-auto my-8" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-extrabold tracking-wider uppercase text-muted">Devices</h2>
        <button
          className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-white text-sm font-semibold no-underline cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setDraft(emptyDraft(people))}
        >
          Add device
        </button>
      </div>
      <p className="text-sm text-muted -mt-2">
        Home-network devices are recognised by IP address. Each one belongs to a person in the household.
      </p>

      {error && <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm">{error}</div>}

      {draft && (
        <Modal title={draft.originalIp ? "Device" : "New device"} onClose={() => setDraft(null)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted font-medium">
              Label
              <input className={inputClass} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Kitchen iPad" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted font-medium">
              IP address
              <input
                className={inputClass}
                value={draft.ip}
                required
                disabled={draft.originalIp !== null}
                onChange={(e) => setDraft({ ...draft, ip: e.target.value })}
                placeholder="192.168.1.50"
                inputMode="decimal"
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted font-medium">
              MAC address
              <input className={inputClass} value={draft.mac} onChange={(e) => setDraft({ ...draft, mac: e.target.value })} placeholder="aa:bb:cc:dd:ee:ff" autoComplete="off" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted font-medium">
              Person
              <select className={inputClass} value={draft.personId} required onChange={(e) => setDraft({ ...draft, personId: e.target.value })}>
                <option value="">—</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name} ({person.role})
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-white text-sm font-semibold cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-text text-sm font-semibold cursor-pointer border-none bg-surface-hover transition-colors hover:bg-border"
                onClick={() => setDraft(null)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {["Label", "IP", "MAC", "Person", "Actions"].map((heading) => (
                <th key={heading} className="px-3 py-2 text-left border-b border-border text-muted font-semibold text-xs uppercase tracking-wider whitespace-nowrap">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => {
              const mine = device.ip === thisIp;
              return (
                <tr key={device.ip} className={mine ? "bg-accent-soft" : "hover:bg-surface-hover"} data-this-device={mine ? "true" : undefined}>
                  <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap">
                    {device.label || "—"}
                    {mine && <span className="ml-2 text-xs font-bold text-accent">This device</span>}
                  </td>
                  <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap font-mono text-xs">{device.ip}</td>
                  <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap font-mono text-xs">{device.mac || "—"}</td>
                  <td className="px-3 py-2 text-left border-b border-border whitespace-nowrap">{personName(device.personId)}</td>
                  <td className="px-3 py-2 border-b border-border whitespace-nowrap">
                    <button
                      className="bg-none border-none text-accent cursor-pointer text-xs hover:underline"
                      onClick={() =>
                        setDraft({
                          ip: device.ip,
                          personId: device.personId,
                          label: device.label ?? "",
                          mac: device.mac ?? "",
                          originalIp: device.ip,
                        })
                      }
                    >
                      Edit
                    </button>
                    {" | "}
                    <button
                      className="bg-none border-none text-danger cursor-pointer text-xs hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                      disabled={mine}
                      title={mine ? "You can't remove the device you're using" : undefined}
                      onClick={() => {
                        if (confirm(`Remove ${device.label || device.ip}?`)) void handleDelete(device);
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
            {devices.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-muted text-center">
                  No devices yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";

export type Tab =
  | "children"
  | "apps"
  | "system-apps"
  | "websites"
  | "themes"
  | "restrictions"
  | "pairing"
  | "snacks"
  | "tickets"
  | "chores"
  | "term-dates"
  | "deploy"
  | "devices";

export const TABS: { id: Tab; label: string }[] = [
  { id: "children", label: "Children" },
  { id: "apps", label: "Apps" },
  { id: "system-apps", label: "System Apps" },
  { id: "websites", label: "Websites" },
  { id: "themes", label: "Themes" },
  { id: "restrictions", label: "Restrictions" },
  { id: "pairing", label: "Pairing" },
  { id: "snacks", label: "Snacks" },
  { id: "tickets", label: "Tickets" },
  { id: "chores", label: "Chores" },
  { id: "term-dates", label: "Term Dates" },
  { id: "deploy", label: "Deploy" },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function pathToTab(pathname: string, extraIds: readonly string[] = []): Tab {
  const segment = pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  return TAB_IDS.has(segment) || extraIds.includes(segment) ? (segment as Tab) : "children";
}

export function tabToPath(tab: Tab): string {
  return tab === "children" ? "/" : `/${tab}`;
}

export function useRoute(extraIds: readonly string[] = []): {
  tab: Tab;
  navigate: (tab: Tab) => void;
} {
  const extraKey = extraIds.join("\0");
  const [tab, setTab] = useState<Tab>(() => pathToTab(window.location.pathname, extraIds));

  useEffect(() => {
    const extras = extraKey ? extraKey.split("\0") : [];
    const onPopState = () => setTab(pathToTab(window.location.pathname, extras));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [extraKey]);

  const navigate = useCallback((next: Tab) => {
    const path = tabToPath(next);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      setTab(next);
    }
  }, []);

  return { tab, navigate };
}

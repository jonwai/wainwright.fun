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
  | "deploy";

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

function pathToTab(pathname: string): Tab {
  const segment = pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  return TAB_IDS.has(segment) ? (segment as Tab) : "children";
}

export function tabToPath(tab: Tab): string {
  return tab === "children" ? "/" : `/${tab}`;
}

export function useRoute(): {
  tab: Tab;
  navigate: (tab: Tab) => void;
} {
  const [tab, setTab] = useState<Tab>(() => pathToTab(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setTab(pathToTab(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Tab) => {
    const path = tabToPath(next);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      setTab(next);
    }
  }, []);

  return { tab, navigate };
}

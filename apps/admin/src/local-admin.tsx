/**
 * The iPad config admin on the home network (admin.wainwright.fun, served by packages/local).
 * The hosted admin's panels without Cognito: the server only answers a parent's device (by IP
 * address), so the "token" is a placeholder it ignores. Pairing, Snacks, Chores and Deploy are not
 * here: devices are recognised by IP, Snacks and Tickets each have their own app
 * (snacks.wainwright.fun, tickets.wainwright.fun), chores stay on chores.wainwright.fun,
 * and nothing is deployed.
 */
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChildrenPanel, AppsPanel, SystemAppsPanel, WebsitesPanel, ThemesPanel, RestrictionsPanel } from "./TablePanels";
import { TermDatesPanel } from "./TermDatesPanel";
import { TABS, tabToPath, useRoute, type Tab } from "./useRoute";
import "./index.css";

const LOCAL_TABS: Tab[] = ["children", "apps", "system-apps", "websites", "themes", "restrictions", "term-dates"];
const TOKEN = "home-network";

function LocalAdmin() {
  const { tab: routed, navigate } = useRoute();
  const tab = LOCAL_TABS.includes(routed) ? routed : "children";
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 bg-surface border-b border-border backdrop-blur-md">
        <h1 className="text-xl font-extrabold">Wainwright Admin</h1>
        <a className="text-sm font-semibold underline" href="https://wainwright.fun/">
          Kids&apos; site
        </a>
      </header>
      <nav className="flex overflow-x-auto no-scrollbar px-4 sm:px-8 bg-surface border-b border-border backdrop-blur-md" ref={navRef}>
        {TABS.filter((t) => LOCAL_TABS.includes(t.id)).map((t) => (
          <a
            key={t.id}
            href={tabToPath(t.id)}
            data-tab={t.id}
            aria-current={tab === t.id ? "true" : undefined}
            className={`shrink-0 whitespace-nowrap border-none border-b-2 px-3 sm:px-5 py-3 text-sm font-medium cursor-pointer transition-colors ${
              tab === t.id ? "text-accent border-accent" : "text-muted border-transparent hover:text-text"
            }`}
            onClick={(e) => {
              e.preventDefault();
              navigate(t.id);
            }}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <main className="flex-1 p-4 sm:p-8 max-w-5xl mx-auto w-full">
        {tab === "children" && <ChildrenPanel accessToken={TOKEN} includeSnacks={false} includePairing={false} />}
        {tab === "apps" && <AppsPanel accessToken={TOKEN} />}
        {tab === "system-apps" && <SystemAppsPanel accessToken={TOKEN} />}
        {tab === "websites" && <WebsitesPanel accessToken={TOKEN} />}
        {tab === "themes" && <ThemesPanel accessToken={TOKEN} />}
        {tab === "restrictions" && <RestrictionsPanel accessToken={TOKEN} />}
        {tab === "term-dates" && (
          <>
            <p className="text-sm text-muted mb-4">Term dates are edited in Snacks on the home network; they are shown here read-only.</p>
            <TermDatesPanel accessToken={TOKEN} />
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalAdmin />
  </StrictMode>,
);

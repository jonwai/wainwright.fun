import { useEffect, useRef, useState } from "react";
import { getSession, handleCallback, login, logout, onSessionRefreshed, refreshSession, type AuthSession } from "./auth";
import { DeployPanel } from "./DeployPanel";
import { ChildrenPanel, AppsPanel, SystemAppsPanel, WebsitesPanel, ThemesPanel, RestrictionsPanel } from "./TablePanels";
import { PairingPanel } from "./PairingPanel";
import { SnacksPanel } from "./SnacksPanel";
import { TasksPanel } from "./TasksPanel";
import { ChoresPanel } from "./ChoresPanel";
import { TermDatesPanel } from "./TermDatesPanel";
import { useRoute, TABS, tabToPath } from "./useRoute";

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const { tab, navigate } = useRoute();
  const navRef = useRef<HTMLElement>(null);

  // Keep the active tab visible when the strip is scrolled (mobile).
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>("[data-tab][aria-current='true']");
    active?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [tab]);

  useEffect(() => {
    // Update React state when the API layer refreshes the session
    onSessionRefreshed(setSession);

    async function init() {
      const params = new URLSearchParams(window.location.search);
      if (params.get("code")) {
        const callbackSession = await handleCallback();
        if (callbackSession) {
          setSession(callbackSession);
          setLoading(false);
          return;
        }
      }
      const existing = getSession();
      if (existing && Date.now() >= existing.expiresAt) {
        // Token expired — try refreshing before showing the UI
        const refreshed = await refreshSession();
        setSession(refreshed);
      } else {
        setSession(existing);
      }
      setLoading(false);
    }
    init();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-sm w-full p-10 bg-surface border border-border rounded-xl text-center backdrop-blur-md shadow-card">
          <h1 className="text-2xl font-extrabold mb-2">Wainwright Admin</h1>
          <p className="text-muted mb-6">Sign in to manage your family's apps and settings.</p>
          <button
            className="inline-flex items-center justify-center min-h-12 px-6 w-full rounded-md text-white text-base font-semibold cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong"
            onClick={() => login()}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 bg-surface border-b border-border backdrop-blur-md">
        <h1 className="text-xl font-extrabold">Wainwright Admin</h1>
        <button
          className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-text text-sm font-semibold cursor-pointer border-none bg-surface-hover transition-colors hover:bg-border"
          onClick={() => logout()}
        >
          Sign out
        </button>
      </header>
      <nav
        className="flex overflow-x-auto no-scrollbar px-4 sm:px-8 bg-surface border-b border-border backdrop-blur-md"
        ref={navRef}
      >
        {TABS.map((t) => (
          <a
            key={t.id}
            href={tabToPath(t.id)}
            data-tab={t.id}
            aria-current={tab === t.id ? "true" : undefined}
            className={`shrink-0 whitespace-nowrap border-none border-b-2 px-3 sm:px-5 py-3 text-sm font-medium cursor-pointer transition-colors ${
              tab === t.id
                ? "text-accent border-accent"
                : "text-muted border-transparent hover:text-text"
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
        {tab === "children" && <ChildrenPanel accessToken={session.accessToken} />}
        {tab === "apps" && <AppsPanel accessToken={session.accessToken} />}
        {tab === "system-apps" && <SystemAppsPanel accessToken={session.accessToken} />}
        {tab === "websites" && <WebsitesPanel accessToken={session.accessToken} />}
        {tab === "themes" && <ThemesPanel accessToken={session.accessToken} />}
        {tab === "restrictions" && <RestrictionsPanel accessToken={session.accessToken} />}
        {tab === "pairing" && <PairingPanel accessToken={session.accessToken} />}
        {tab === "snacks" && <SnacksPanel accessToken={session.accessToken} />}
        {tab === "tickets" && <TasksPanel accessToken={session.accessToken} />}
        {tab === "chores" && <ChoresPanel accessToken={session.accessToken} />}
        {tab === "term-dates" && <TermDatesPanel accessToken={session.accessToken} />}
        {tab === "deploy" && <DeployPanel accessToken={session.accessToken} />}
      </main>
    </div>
  );
}

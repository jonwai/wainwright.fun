import { useCallback, useEffect, useState } from "react";
import { applyKidTheme, getDevFallbackConfig } from "./siteConfig";
import { ProfileSection } from "./components/ProfileSection";
import { SearchBar } from "./components/SearchBar";
import { UnifiedCard } from "./components/UnifiedCard";
import { BirthdayBanner, BirthdayConfetti } from "./components/BirthdayBanner";
import { PairScreen } from "./components/PairScreen";
import { KidsAvatarPicker } from "./components/KidsAvatarPicker";
import { clearDeviceToken, getDeviceToken, setDeviceToken } from "./lib/deviceAuth";
import {
  extractPairingCode,
  fetchKidConfig,
  fetchKidPreview,
  pairDevice,
  profileDownloadUrl,
  saveKidAvatar,
  unpairDevice,
  type KidConfig,
} from "./lib/kidApi";

export default function App() {
  const [config, setConfig] = useState<KidConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const loadConfig = useCallback(async (token: string) => {
    const next = await fetchKidConfig(token);
    setConfig(next);
    applyKidTheme(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = extractPairingCode(params.get("c") ?? params.get("code") ?? "");

      try {
        const preview = params.get("preview")?.trim();
        if (preview) {
          const next = await fetchKidPreview(preview);
          if (cancelled) return;
          setPreviewToken(preview);
          setPreviewing(true);
          setConfig(next);
          applyKidTheme(next);
          return;
        }

        if (fromUrl) {
          const { token, config: paired } = await pairDevice(fromUrl);
          if (cancelled) return;
          setDeviceToken(token);
          setConfig(paired);
          applyKidTheme(paired);
          window.history.replaceState({}, "", "/");
          return;
        }

        const token = getDeviceToken();
        if (token) {
          await loadConfig(token);
          return;
        }

        const fallback = await getDevFallbackConfig();
        if (fallback && import.meta.env.VITE_CHILD) {
          setConfig(fallback);
          applyKidTheme(fallback);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load";
        if (message === "unpaired") {
          clearDeviceToken();
        } else {
          setError(message);
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadConfig]);

  async function handlePair(code: string) {
    setBusy(true);
    setPairingError(null);
    try {
      const { token, config: paired } = await pairDevice(code);
      setDeviceToken(token);
      setConfig(paired);
      applyKidTheme(paired);
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : "Could not pair this iPad");
    } finally {
      setBusy(false);
    }
  }

  async function handleAvatar(emoji: string) {
    setPickingAvatar(false);
    if (!config) return;
    const previous = config.child.avatar;
    setConfig({ ...config, child: { ...config.child, avatar: emoji } });
    try {
      await saveKidAvatar(emoji, previewToken ?? undefined);
    } catch {
      setConfig({ ...config, child: { ...config.child, avatar: previous } });
    }
  }

  async function handleUnpair() {
    await unpairDevice();
    clearDeviceToken();
    setConfig(null);
    setError(null);
    setPairingError(null);
  }

  if (booting) {
    return (
      <div className="page">
        <main className="container mx-auto px-5 pt-10 pb-12 flex items-center justify-center">
          <div className="spinner" />
        </main>
      </div>
    );
  }

  if (!config) {
    if (error) {
      return (
        <div className="page">
          <main className="container mx-auto px-5 pt-10 pb-12">
            <p className="text-red-600">{error}</p>
          </main>
        </div>
      );
    }
    return <PairScreen onPaired={handlePair} error={pairingError} busy={busy} />;
  }

  const token = previewToken ?? getDeviceToken();
  const showSearch = config.theme !== "little";
  const showCategories = config.theme !== "little" && config.categories.length > 0;
  const hideNames = config.theme === "little";
  const birthday = config.birthday;
  const searching = searchQuery.trim().length > 0;
  const justUnlocked = config.justUnlocked ?? [];
  const showJustUnlocked = Boolean(birthday && justUnlocked.length > 0 && !searching);

  const filteredCategories = (() => {
    if (!showCategories) {
      return [];
    }

    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return config.categories;
    }

    return config.categories
      .map((category) => ({
        ...category,
        items: category.items.filter(
          (item) =>
            item.name.toLowerCase().includes(normalized) ||
            (item.category?.toLowerCase().includes(normalized) ?? false)
        ),
      }))
      .filter((category) => category.items.length > 0);
  })();

  return (
    <div className={`page theme-${config.theme} accent-${config.child.color}${birthday?.isToday ? " page-birthday" : ""}`}>
      <div className="page-glow" aria-hidden="true" />
      {birthday?.isToday && <BirthdayConfetti />}
      {pickingAvatar && (
        <KidsAvatarPicker
          value={config.child.avatar}
          onSelect={(emoji) => void handleAvatar(emoji)}
          onClose={() => setPickingAvatar(false)}
        />
      )}

      <button
        className="fixed top-4 right-4 z-[100] flex items-center justify-center w-11 h-11 border border-border rounded-full bg-surface backdrop-blur-md text-muted cursor-pointer appearance-none shadow-[0_4px_12px_rgba(27,27,47,0.08)] transition-transform duration-150 ease-out hover:rotate-90 hover:text-accent-strong active:scale-92"
        onClick={() => window.location.reload()}
        aria-label="Refresh"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>

      <main className="container relative z-1 mx-auto px-5 pt-10 pb-12 sm:px-8">
        {previewing && (
          <p className="m-0 mb-6 text-center text-sm font-semibold px-4 py-2.5 rounded-xl bg-surface border border-border shadow-card">
            Previewing {config.child.name}&apos;s site — this doesn&apos;t pair an iPad
          </p>
        )}
        <header className="text-center mb-8">
          <button
            type="button"
            className="header-badge inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[0.8125rem] font-extrabold tracking-wider uppercase mb-4 border-none cursor-pointer"
            onClick={() => setPickingAvatar(true)}
          >
            <span className="text-lg leading-none">{config.child.avatar ?? "🌟"}</span>
            {config.child.name}
            {birthday?.isToday && (
              <span className="birthday-chip">You&apos;re {config.age}!</span>
            )}
          </button>
          <h1 className="m-0 text-[clamp(2.2rem,7vw,3rem)] leading-[1.05] font-extrabold tracking-tight">
            {config.site.title}
          </h1>
          {config.site.subtitle && (
            <p className="subtitle mx-auto mt-3.5 max-w-[34rem] text-muted text-[1.05rem]">
              {config.site.subtitle}
            </p>
          )}
        </header>

        {birthday && !birthday.isToday && !searching && (
          <BirthdayBanner birthday={birthday} />
        )}

        <ProfileSection
          buttonText={config.site.profile_button_text}
          appCount={config.apps.length + config.system_apps.filter((a) => a.show_on_site !== false).length}
          websiteCount={config.websites.filter((w) => !w.hidden).length}
          profileUpdatedAt={config.profileUpdatedAt}
          childName={config.child.name}
          avatar={config.child.avatar}
          profileUrl={token ? profileDownloadUrl(token) : undefined}
        />

        <div className="flex flex-col gap-10 mt-10">
          {showJustUnlocked && (
            <section className="apps-section just-unlocked grid gap-3">
              <div className="section-heading flex items-center justify-between gap-4">
                <h2 className="m-0 text-base font-extrabold tracking-wider uppercase text-muted">
                  Just unlocked
                </h2>
                <span className="app-count inline-flex items-center justify-center min-w-8 h-8 px-2.5 rounded-full bg-surface-solid border border-border text-[0.875rem] font-extrabold">
                  {justUnlocked.length}
                </span>
              </div>
              <ul className={`app-list ${hideNames ? "app-list-large" : ""}`}>
                {justUnlocked.map((item) => (
                  <UnifiedCard key={item.key} item={item} hideName={hideNames} />
                ))}
              </ul>
            </section>
          )}

          {showSearch && (
            <SearchBar query={searchQuery} onQueryChange={setSearchQuery} />
          )}

          {showCategories ? (
            filteredCategories.map((category) => (
              <section className="apps-section grid gap-3" key={category.name}>
                <div className="section-heading flex items-center justify-between gap-4">
                  <h2 className="m-0 text-base font-extrabold tracking-wider uppercase text-muted">{category.name}</h2>
                  <span className="app-count inline-flex items-center justify-center min-w-8 h-8 px-2.5 rounded-full bg-surface-solid border border-border text-[0.875rem] font-extrabold">
                    {category.items.length}
                  </span>
                </div>

                <ul className="app-list">
                  {category.items.map((item) => (
                    <UnifiedCard
                      key={item.key}
                      item={item}
                      hideName={hideNames}
                    />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <section className="apps-section grid gap-3">
              {!hideNames && (
                <div className="section-heading flex items-center justify-between gap-4">
                  <h2 className="m-0 text-base font-extrabold tracking-wider uppercase text-muted">Apps</h2>
                  <span className="app-count inline-flex items-center justify-center min-w-8 h-8 px-2.5 rounded-full bg-surface-solid border border-border text-[0.875rem] font-extrabold">
                    {config.apps.length + config.system_apps.filter((a) => a.show_on_site !== false).length}
                  </span>
                </div>
              )}

              <ul className={`app-list ${hideNames ? "app-list-large" : ""}`}>
                {(config.items ?? []).map((item) => (
                  <UnifiedCard
                    key={item.key}
                    item={item}
                    hideName={hideNames}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>

        {!previewing && (
          <p className="mt-10 text-center">
            <button
              type="button"
              className="text-muted text-xs font-semibold border-none bg-transparent cursor-pointer underline-offset-2 hover:underline"
              onClick={() => void handleUnpair()}
            >
              This isn&apos;t me
            </button>
          </p>
        )}
      </main>
    </div>
  );
}

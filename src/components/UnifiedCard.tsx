import type { UnifiedItem } from "../../scripts/resolve";
import { AppListItem } from "./BlockedAppCard";

interface UnifiedCardProps {
  item: UnifiedItem;
  hideName?: boolean;
}

function CardIcon({ item }: Pick<UnifiedCardProps, "item">) {
  // System apps may have a named icon (e.g. "settings") or an icon_url
  const systemIconSrc =
    item.kind === "system"
      ? item.icon_url ?? (item.icon ? `/system-icons/${item.icon}.png` : undefined)
      : undefined;

  if (item.icon_url) {
    return (
      <img
        src={item.icon_url}
        alt=""
        className="app-icon-image"
        loading="lazy"
        decoding="async"
      />
    );
  }

  if (systemIconSrc) {
    return (
      <img
        src={systemIconSrc}
        alt=""
        className="app-icon-image"
        loading="lazy"
        decoding="async"
      />
    );
  }

  const fallbackEmoji =
    item.kind === "website" ? "🌐" : item.emoji ?? "📱";

  return <span className="text-[2.4rem] leading-none">{fallbackEmoji}</span>;
}

export function UnifiedCard({ item, hideName = false }: UnifiedCardProps) {
  const iconClass =
    item.kind === "system"
      ? "app-icon app-icon-system flex items-center justify-center w-[5.5rem] h-[5.5rem] rounded-[1.35rem] bg-transparent shadow-[0_10px_24px_rgba(27,27,47,0.08),inset_0_0_0_1px_rgba(27,27,47,0.06)] overflow-hidden"
      : item.kind === "website"
        ? "app-icon app-icon-website flex items-center justify-center w-[5.5rem] h-[5.5rem] rounded-[1.35rem] bg-white shadow-[0_10px_24px_rgba(27,27,47,0.08),inset_0_0_0_1px_rgba(27,27,47,0.06)] overflow-hidden"
        : "app-icon flex items-center justify-center w-[5.5rem] h-[5.5rem] rounded-[1.35rem] bg-surface-solid shadow-[0_10px_24px_rgba(27,27,47,0.08),inset_0_0_0_1px_rgba(27,27,47,0.06)] overflow-hidden";

  const icon = (
    <div className={iconClass}>
      <CardIcon item={item} />
    </div>
  );

  const name = hideName ? undefined : (
    <span className="app-name w-full max-w-[6.5rem] text-[0.8125rem] font-extrabold leading-[1.25] text-center text-text overflow-hidden text-ellipsis line-clamp-2">
      {item.name}
    </span>
  );

  const badge = item.isNew ? (
    <span className="new-badge" aria-label="New">New</span>
  ) : null;

  // Static system app (no App Store URL) — non-clickable
  if (item.static) {
    return (
      <AppListItem>
        <div
          className="app-card app-card-static relative flex flex-col items-center gap-2.5 m-0 p-1.5 border-none rounded-md bg-transparent shadow-none no-underline text-inherit text-center appearance-none transition-transform duration-150 ease-out cursor-default"
          aria-label={item.name}
        >
          {badge}
          {icon}
          {name}
        </div>
      </AppListItem>
    );
  }

  // Blocked app — semi-transparent, non-clickable
  if (item.blocked) {
    return (
      <AppListItem>
        <div
          className="app-card app-card-blocked relative flex flex-col items-center gap-2.5 m-0 p-1.5 border-none rounded-md bg-transparent shadow-none no-underline text-inherit text-center appearance-none transition-transform duration-150 ease-out cursor-not-allowed pointer-events-none opacity-40"
          aria-label={`${item.name} (blocked)`}
          title={`${item.name} is blocked`}
        >
          {badge}
          {icon}
          {name}
        </div>
      </AppListItem>
    );
  }

  return (
    <AppListItem>
      <a
        className="app-card relative flex flex-col items-center gap-2.5 m-0 p-1.5 border-none rounded-md bg-transparent shadow-none no-underline text-inherit text-center appearance-none transition-transform duration-150 ease-out hover:-translate-y-0.5 active:scale-97"
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={item.isNew ? `Open ${item.name} (new)` : `Open ${item.name}`}
      >
        {badge}
        {icon}
        {name}
      </a>
    </AppListItem>
  );
}

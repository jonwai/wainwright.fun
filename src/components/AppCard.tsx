import type { AppEntry } from "../../scripts/config";
import { AppListItem } from "./BlockedAppCard";

interface AppCardProps {
  app: AppEntry;
  hideName?: boolean;
}

function AppIcon({ app }: Pick<AppCardProps, "app">) {
  if (app.icon_url) {
    return (
      <img
        src={app.icon_url}
        alt=""
        className="app-icon-image"
        loading="lazy"
        decoding="async"
      />
    );
  }

  return <span className="text-[2.4rem] leading-none">{app.emoji ?? "📱"}</span>;
}

export function AppCard({ app, hideName = false }: AppCardProps) {
  const icon = (
    <div className="app-icon flex items-center justify-center w-[5.5rem] h-[5.5rem] rounded-[1.35rem] bg-surface-solid shadow-[0_10px_24px_rgba(27,27,47,0.08),inset_0_0_0_1px_rgba(27,27,47,0.06)] overflow-hidden">
      <AppIcon app={app} />
    </div>
  );

  const name = hideName ? undefined : (
    <span className="app-name w-full max-w-[6.5rem] text-[0.8125rem] font-extrabold leading-[1.25] text-center text-text overflow-hidden text-ellipsis line-clamp-2">
      {app.name}
    </span>
  );

  return (
    <AppListItem>
      <a
        className="app-card flex flex-col items-center gap-2.5 m-0 p-1.5 border-none rounded-md bg-transparent shadow-none no-underline text-inherit text-center appearance-none transition-transform duration-150 ease-out hover:-translate-y-0.5 active:scale-97"
        href={app.app_store_url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${app.name} in the App Store`}
      >
        {icon}
        {name}
      </a>
    </AppListItem>
  );
}

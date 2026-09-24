import type { SystemApp } from "../../scripts/config";
import { AppListItem } from "./BlockedAppCard";

interface BasicAppCardProps {
  app: SystemApp;
  hideName?: boolean;
}

function AppIcon({ app }: Pick<BasicAppCardProps, "app">) {
  const iconSrc =
    app.icon_url ?? (app.icon ? `/system-icons/${app.icon}.png` : undefined);

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        className="app-icon-image"
        loading="lazy"
        decoding="async"
      />
    );
  }

  return <span className="text-[2.4rem] leading-none">📱</span>;
}

export function BasicAppCard({
  app,
  hideName = false,
}: BasicAppCardProps) {
  const icon = (
    <div className="app-icon app-icon-system flex items-center justify-center w-[5.5rem] h-[5.5rem] rounded-[1.35rem] bg-transparent shadow-[0_10px_24px_rgba(27,27,47,0.08),inset_0_0_0_1px_rgba(27,27,47,0.06)] overflow-hidden">
      <AppIcon app={app} />
    </div>
  );

  const name = hideName ? undefined : (
    <span className="app-name w-full max-w-[6.5rem] text-[0.8125rem] font-extrabold leading-[1.25] text-center text-text overflow-hidden text-ellipsis line-clamp-2">
      {app.name}
    </span>
  );

  if (app.app_store_url) {
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

  return (
    <AppListItem>
      <div
        className="app-card app-card-static flex flex-col items-center gap-2.5 m-0 p-1.5 border-none rounded-md bg-transparent shadow-none no-underline text-inherit text-center appearance-none transition-transform duration-150 ease-out cursor-default"
        aria-label={app.name}
      >
        {icon}
        {name}
      </div>
    </AppListItem>
  );
}

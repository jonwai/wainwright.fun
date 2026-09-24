import type { ReactNode } from "react";

export function AppListItem({ children }: { children: ReactNode }) {
  return <li className="flex justify-center min-w-0">{children}</li>;
}

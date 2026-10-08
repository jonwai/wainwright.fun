/**
 * The tickets admin on the home network (tickets.wainwright.fun/admin/, served by packages/local).
 * Just the hosted admin's Tickets panel: no Cognito. The server only answers a parent's device
 * (by IP address), so the "token" here is a placeholder the server ignores.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TasksPanel } from "./TasksPanel";
import "./index.css";

function LocalTicketsAdmin() {
  return (
    <div className="min-h-screen max-w-6xl mx-auto px-4 py-6">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-extrabold">🎟️ Tickets admin</h1>
        <a className="text-sm font-semibold underline" href="/">
          Kid site
        </a>
      </header>
      <TasksPanel accessToken="home-network" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalTicketsAdmin />
  </StrictMode>,
);

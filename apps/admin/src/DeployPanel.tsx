import { useState } from "react";
import { triggerRebuild } from "./api";

export function DeployPanel({ accessToken }: { accessToken: string }) {
  const [deploying, setDeploying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRebuild() {
    setDeploying(true);
    setError(null);
    setMessage(null);
    try {
      await triggerRebuild(accessToken);
      setMessage("CloudFront cache invalidation started. New icons should appear shortly.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger rebuild");
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-surface border border-border rounded-xl p-6 backdrop-blur-md shadow-card">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-xl font-bold">Kids site</h2>
          <button
            className="inline-flex items-center justify-center min-h-10 px-6 rounded-md text-white text-sm font-semibold cursor-pointer border-none bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRebuild}
            disabled={deploying}
          >
            {deploying ? "Triggering…" : "Refresh cache"}
          </button>
        </div>
        {error && (
          <div className="p-3 px-4 rounded-md bg-red-50 border border-red-200 text-danger text-sm mb-4">
            {error}
          </div>
        )}
        {message && (
          <div className="p-3 px-4 rounded-md bg-accent-soft border border-accent/30 text-accent-strong text-sm mb-4">
            {message}
          </div>
        )}
        <p className="text-muted text-sm leading-relaxed">
          The kids site at <strong className="text-text">wainwright.fun</strong> loads each
          child&apos;s apps from the API after their iPad is paired. App and avatar changes
          show up on the next refresh — no site rebuild required.
        </p>
        <p className="text-muted text-sm leading-relaxed mt-3">
          iPad restriction profiles are generated when a child taps <strong className="text-text">Install iPad Profile</strong>.
          Reinstall the profile after you add or remove apps. Pair an iPad from the Children tab.
        </p>
      </div>
    </div>
  );
}

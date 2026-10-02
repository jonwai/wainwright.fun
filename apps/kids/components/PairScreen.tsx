import { useState } from "react";
import { extractPairingCode } from "../lib/kidApi";
import { QrScanner } from "./QrScanner";

interface PairScreenProps {
  onPaired: (code: string) => Promise<void>;
  error: string | null;
  busy: boolean;
}

export function PairScreen({ onPaired, error, busy }: PairScreenProps) {
  const [mode, setMode] = useState<"home" | "scan" | "type">("home");
  const [typed, setTyped] = useState("");

  async function submitCode(raw: string) {
    const code = extractPairingCode(raw);
    if (!code) return;
    await onPaired(code);
  }

  return (
    <div className="page">
      <div className="page-glow" aria-hidden="true" />
      <main className="container relative z-1 mx-auto px-5 pt-16 pb-12 max-w-md">
        <header className="text-center mb-8">
          <div className="header-badge inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[0.8125rem] font-extrabold tracking-wider uppercase mb-4">
            Wainwright
          </div>
          <h1 className="m-0 text-[clamp(2rem,7vw,2.8rem)] leading-[1.05] font-extrabold tracking-tight">
            Whose iPad is this?
          </h1>
          <p className="mx-auto mt-3.5 max-w-[28rem] text-muted text-[1.05rem]">
            Ask a grown-up to open the admin site and show the QR code for your name.
          </p>
        </header>

        {error && (
          <p className="mb-4 p-3 px-4 rounded-md bg-red-50 text-red-700 text-sm font-semibold text-center">
            {error}
          </p>
        )}

        {mode === "scan" ? (
          <QrScanner
            onDetect={(text) => {
              void submitCode(text);
            }}
            onCancel={() => setMode("home")}
          />
        ) : mode === "type" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode(typed);
            }}
          >
            <label className="text-sm font-bold text-muted" htmlFor="pair-code">
              Pairing code
            </label>
            <input
              id="pair-code"
              value={typed}
              onChange={(event) => setTyped(event.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="w-full min-h-14 px-4 rounded-xl border border-border bg-surface-solid text-center text-2xl font-extrabold tracking-[0.3em]"
              placeholder="ABCD2345"
            />
            <button
              type="submit"
              disabled={busy || typed.trim().length < 6}
              className="profile-button inline-flex items-center justify-center min-h-12 px-6 rounded-md text-white text-base font-extrabold border-none cursor-pointer disabled:opacity-50"
            >
              {busy ? "Pairing…" : "Pair this iPad"}
            </button>
            <button
              type="button"
              className="text-muted text-sm font-semibold border-none bg-transparent cursor-pointer"
              onClick={() => setMode("home")}
            >
              Back
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              className="profile-button inline-flex items-center justify-center min-h-14 px-6 rounded-md text-white text-lg font-extrabold border-none cursor-pointer"
              onClick={() => setMode("scan")}
              disabled={busy}
            >
              Scan QR code
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center min-h-12 px-6 rounded-md text-text text-base font-semibold cursor-pointer border border-border bg-surface-solid"
              onClick={() => setMode("type")}
              disabled={busy}
            >
              Type the code instead
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

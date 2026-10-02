import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { createPairingSession, createPreviewSession, type PairingSession } from "./api";

interface PairQrCardProps {
  accessToken: string;
  subdomain: string;
  childName: string;
}

export function PairQrCard({ accessToken, subdomain, childName }: PairQrCardProps) {
  const [session, setSession] = useState<PairingSession | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const next = await createPairingSession(accessToken, subdomain);
      setSession(next);
      setQrUrl(await QRCode.toDataURL(next.pairing_url, {
        width: 280,
        margin: 1,
        color: { dark: "#1b1b2f", light: "#ffffff" },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pairing code");
    } finally {
      setLoading(false);
    }
  }

  async function preview() {
    setPreviewing(true);
    setError(null);
    try {
      const next = await createPreviewSession(accessToken, subdomain);
      window.open(next.preview_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open preview");
    } finally {
      setPreviewing(false);
    }
  }

  const remainingMs = session ? session.expires_at - now : 0;
  const expired = Boolean(session && remainingMs <= 0);
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

  return (
    <div className="mb-5 p-4 rounded-xl border border-border bg-surface-solid">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h4 className="m-0 text-sm font-extrabold">Pair {childName}&apos;s iPad</h4>
          <p className="m-0 mt-1 text-xs text-muted">
            Open wainwright.fun on the iPad and scan this code.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-text text-sm font-semibold cursor-pointer border border-border bg-surface hover:bg-surface-hover disabled:opacity-50"
            onClick={() => void preview()}
            disabled={previewing}
          >
            {previewing ? "Opening…" : "Preview site"}
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center min-h-10 px-4 rounded-md text-white text-sm font-semibold cursor-pointer border-none bg-accent hover:bg-accent-strong disabled:opacity-50"
            onClick={() => void generate()}
            disabled={loading}
          >
            {loading ? "Creating…" : session ? "New code" : "Show QR code"}
          </button>
        </div>
      </div>

      {error && (
        <p className="m-0 mb-3 text-xs text-danger">{error}</p>
      )}

      {session && qrUrl && !expired && (
        <div className="flex flex-col items-center gap-2">
          <img src={qrUrl} alt={`Pairing QR code for ${childName}`} className="w-56 h-56" />
          <p className="m-0 text-2xl font-extrabold tracking-[0.25em]">{session.code}</p>
          <p className="m-0 text-xs text-muted">
            Expires in {remaining}s
          </p>
        </div>
      )}

      {expired && (
        <p className="m-0 text-xs text-muted">That code expired. Create a new one.</p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

interface QrScannerProps {
  onDetect: (text: string) => void;
  onCancel: () => void;
}

export function QrScanner({ onDetect, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const detected = useRef(false);

  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const videoEl = video;
    const canvasEl = canvas;

    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        videoEl.srcObject = stream;
        await videoEl.play();

        const tick = () => {
          if (cancelled || detected.current) return;
          if (videoEl.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
            const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
            if (ctx && canvasEl.width > 0) {
              ctx.drawImage(videoEl, 0, 0);
              const image = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
              const code = jsQR(image.data, image.width, image.height, {
                inversionAttempts: "dontInvert",
              });
              if (code?.data) {
                detected.current = true;
                onDetectRef.current(code.data);
                return;
              }
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setError("Camera permission is needed to scan the QR code. You can type the code instead.");
      }
    }

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-xl bg-black aspect-[3/4] max-h-[60vh]">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />
        <canvas ref={canvasRef} className="hidden" />
        <div className="absolute inset-0 pointer-events-none border-[3px] border-white/70 rounded-xl m-10" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        className="inline-flex items-center justify-center min-h-12 px-6 rounded-md text-text text-base font-semibold cursor-pointer border-none bg-surface-solid"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

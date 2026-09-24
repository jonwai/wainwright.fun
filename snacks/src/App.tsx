import { useCallback, useEffect, useState } from "react";
import { QrScanner } from "./components/QrScanner";
import {
  extractPairingCode,
  fetchBudgetHistory,
  fetchBudgetProducts,
  fetchBudgetState,
  pairDevice,
  selectBudgetItem,
  formatPence,
  type BudgetHistoryDay,
  type BudgetProduct,
  type BudgetSelection,
  type BudgetState,
} from "./api";

const BUDGET_ID = "snacks";

type Screen = "pick" | "history";

function todayLondon(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
    .map((part) => (part.type === "literal" ? "" : part.value))
    .join("");
}

/**
 * How much of the budget is left, in the mode's own units: whole 5p coins in
 * "count" mode (younger children), pence otherwise. Drives the "done"
 * state and the header pill.
 */
function budgetRemaining(state: BudgetState): number {
  return state.mode === "count" ? state.coins_remaining ?? 0 : state.remaining_pence;
}

/** One 5p coin — small inline SVG, no external asset. */
function CoinIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="12" cy="12" r="11" fill="#f5b942" stroke="#c78d22" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="8" fill="none" stroke="#c78d22" strokeWidth="1" />
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="800"
        fill="#8a5f0d"
        fontFamily="inherit"
      >
        5p
      </text>
    </svg>
  );
}

/** A big coin count plus one coin icon per coin, capped sensibly. */
function CoinStack({ count, small = false }: { count: number; small?: boolean }) {
  const shown = Math.min(count, 20);
  return (
    <span className="inline-flex items-center gap-1 flex-wrap justify-center">
      <span
        className={`${small ? "text-base" : "text-2xl"} font-extrabold text-accent-strong`}
      >
        {count}
      </span>
      {count > 0 && (
        <span className="inline-flex gap-0.5">
          {Array.from({ length: shown }, (_, i) => (
            <CoinIcon key={i} size={small ? 16 : 20} />
          ))}
        </span>
      )}
      {count > shown && <span className="text-sm font-bold text-accent-strong">×{count}</span>}
    </span>
  );
}

function friendlyDate(date: string): string {
  const today = todayLondon();
  if (date === today) return "Today";
  const yesterday = new Date(Date.now() - 86_400_000);
  const yesterdayStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(yesterday)
    .map((part) => (part.type === "literal" ? "" : part.value))
    .join("");
  if (date === yesterdayStr) return "Yesterday";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export default function App() {
  const [state, setState] = useState<BudgetState | null>(null);
  const [products, setProducts] = useState<BudgetProduct[] | null>(null);
  const [history, setHistory] = useState<BudgetHistoryDay[] | null>(null);
  const [screen, setScreen] = useState<Screen>("pick");
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [justPicked, setJustPicked] = useState<BudgetSelection | null>(null);
  const [unpaired, setUnpaired] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [typedCode, setTypedCode] = useState("");
  const [pairMode, setPairMode] = useState<"home" | "scan" | "type">("home");

  const load = useCallback(async () => {
    try {
      const next = await fetchBudgetState(BUDGET_ID);
      setState(next);
      setError(null);
      setUnpaired(false);
      // Previous days not yet completed stay open — offer the latest one.
      if (budgetRemaining(next) > 0) setScreen("pick");
    } catch (err) {
      if (err instanceof Error && err.message === "unpaired") {
        setUnpaired(true);
      } else {
        setError(err instanceof Error ? err.message : "Could not load your snacks");
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Errors auto-dismiss after 6s — long enough for a young reader, not sticky.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (screen === "pick") {
      fetchBudgetProducts(BUDGET_ID)
        .then((products) => {
          // Cheapest first so the pennies-left picker reads top-to-bottom.
          // Products without a price sort to the end.
          const byPrice = [...products].sort((a, b) => {
            if (a.pricePence === null && b.pricePence === null) return 0;
            if (a.pricePence === null) return 1;
            if (b.pricePence === null) return -1;
            return a.pricePence - b.pricePence;
          });
          setProducts(byPrice);
        })
        .catch(() => setProducts([]));
    } else {
      fetchBudgetHistory(BUDGET_ID)
        .then(setHistory)
        .catch(() => setHistory([]));
    }
  }, [screen, state?.remaining_pence, state?.snacks_remaining]);

  const pick = useCallback(
    async (product: BudgetProduct) => {
      if (!state || busySlug) return;
      setBusySlug(product.productSlug);
      setError(null);
      try {
        await selectBudgetItem(BUDGET_ID, product.productSlug);
        setJustPicked(product as unknown as BudgetSelection);
        await load();
        setProducts(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not pick that snack";
        // Refresh first — load() clears the error state on success, which used
        // to wipe this message about a second after it appeared.
        await load();
        setError(message);
      } finally {
        setBusySlug(null);
      }
    },
    [state, busySlug, load]
  );

  const done = state !== null && budgetRemaining(state) <= 0;
  const countMode = state?.mode === "count";

  async function handlePairSubmit(raw: string) {
    const code = extractPairingCode(raw);
    if (!code) {
      setPairingError("Enter the pairing code from a grown-up");
      return;
    }
    setPairing(true);
    setPairingError(null);
    try {
      await pairDevice(code);
      setTypedCode("");
      await load();
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : "Could not pair this iPad");
    } finally {
      setPairing(false);
    }
  }

  if (unpaired) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full p-10 bg-surface border border-border rounded-xl text-center backdrop-blur-md shadow-card">
          <div className="text-5xl mb-4">🍪</div>
          <h1 className="text-2xl font-extrabold mb-2">Snacks</h1>
          <p className="text-muted mb-6">
            This iPad isn't set up yet. Ask a grown-up to open the Wainwright app
            and show the pairing code for your name.
          </p>
          {pairingError && (
            <p className="mb-4 p-3 px-4 rounded-md bg-red-50 text-red-700 text-sm font-semibold text-center">
              {pairingError}
            </p>
          )}
          {pairMode === "scan" ? (
            <QrScanner
              onDetect={(text) => {
                void handlePairSubmit(text);
              }}
              onCancel={() => setPairMode("home")}
            />
          ) : pairMode === "type" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handlePairSubmit(typedCode);
              }}
            >
              <label className="text-sm font-bold text-muted" htmlFor="pair-code">
                Pairing code
              </label>
              <input
                id="pair-code"
                value={typedCode}
                onChange={(event) => setTypedCode(event.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                disabled={pairing}
                className="w-full min-h-14 px-4 rounded-xl border border-border bg-surface-solid text-center text-2xl font-extrabold tracking-[0.3em]"
                placeholder="ABCD2345"
              />
              <button
                type="submit"
                disabled={pairing || typedCode.trim().length < 6}
                className="inline-flex items-center justify-center min-h-12 px-6 w-full rounded-md text-white text-base font-semibold bg-accent transition-colors hover:bg-accent-strong no-underline disabled:opacity-50"
              >
                {pairing ? "Pairing…" : "Pair this iPad"}
              </button>
              <button
                type="button"
                className="text-muted text-sm font-semibold border-none bg-transparent cursor-pointer no-underline"
                onClick={() => setPairMode("home")}
              >
                Back
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                className="inline-flex items-center justify-center min-h-14 px-6 w-full rounded-md text-white text-lg font-extrabold border-none cursor-pointer bg-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
                onClick={() => setPairMode("scan")}
                disabled={pairing}
              >
                Scan QR code
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center min-h-12 px-6 w-full rounded-md text-text text-base font-semibold cursor-pointer border border-border bg-surface-solid"
                onClick={() => setPairMode("type")}
                disabled={pairing}
              >
                Type the code instead
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" />
      </div>
    );
  }

  const remaining = state.remaining_pence;
  const coinsLeft = state.mode === "count" ? state.coins_remaining ?? 0 : null;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 pt-8 pb-4 text-center">
        <h1 className="text-3xl font-extrabold">🍪 My Snacks</h1>
        <p className="text-muted text-lg">
          {done
            ? "All done — see you tomorrow! 🌟"
            : countMode
              ? "Pick your snacks for today"
              : "Pick as many snacks as your pennies allow"}
        </p>
        {!done && countMode && coinsLeft !== null && (
          <div className="mt-3 inline-flex items-center gap-2 bg-accent-soft rounded-full px-5 py-2">
            <CoinStack count={coinsLeft} />
            <span className="text-sm text-muted">left today</span>
          </div>
        )}
        {!done && !countMode && (
          <div className="mt-3 inline-flex items-baseline gap-2 bg-accent-soft rounded-full px-5 py-2">
            <span className="text-2xl font-extrabold text-accent-strong">{remaining}p</span>
            <span className="text-sm text-muted">left today</span>
          </div>
        )}
      </header>

      <nav className="flex justify-center gap-2 px-6 pb-4">
        <TabButton active={screen === "pick"} onClick={() => setScreen("pick")}>
          Pick snacks
        </TabButton>
        <TabButton active={screen === "history"} onClick={() => setScreen("history")}>
          My history
        </TabButton>
      </nav>

      {error && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-red-50 border border-red-200 text-danger text-center font-semibold shake">
          {error}
        </div>
      )}

      {justPicked && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-center font-semibold pop-in">
          Yum! {justPicked.name} added to today 🎉
        </div>
      )}

      <main className="flex-1 px-6 pb-10 max-w-3xl mx-auto w-full">
        {screen === "pick" ? (
          done ? (
            <div className="text-center py-10">
              <div className="text-6xl mb-3">🎉</div>
              <p className="text-xl font-bold">
                {countMode
                  ? "You've picked all your snacks for today!"
                  : "You've spent all your pennies for today!"}
              </p>
              <p className="text-muted">Come back tomorrow for more yummy snacks.</p>
            </div>
          ) : products === null ? (
            <div className="flex justify-center py-10">
              <div className="spinner" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {products.map((product) => (
                <SnackCard
                  key={product.productSlug}
                  product={product}
                  busy={busySlug === product.productSlug}
                  soldOut={product.portionsLeft <= 0}
                  showPrice={!countMode}
                  countMode={countMode}
                  onPick={() => pick(product)}
                />
              ))}
            </div>
          )
        ) : history === null ? (
          <div className="flex justify-center py-10">
            <div className="spinner" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {history.length === 0 && (
              <p className="text-center text-muted py-8">
                No snacks picked yet — pick some today! 😊
              </p>
            )}
            {history.map((day) => (
              <div key={day.date} className="bg-surface border border-border rounded-lg p-4 backdrop-blur-md">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-lg font-extrabold">{friendlyDate(day.date)}</h2>
                  <span className="text-sm text-muted">
                    {countMode
                      ? `${day.selections.length} snack${day.selections.length === 1 ? "" : "s"} picked`
                      : `${day.selections.reduce((sum, s) => sum + (s.pricePence ?? 0), 0)}p spent`}
                  </span>
                </div>
                {day.selections.length === 0 ? (
                  <p className="text-muted text-sm">Nothing picked this day yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {day.selections.map((selection) => (
                      <li key={selection.selectedAt} className="flex items-center gap-3">
                        {selection.image ? (
                          <img
                            src={selection.image}
                            alt=""
                            className="w-10 h-10 rounded-md object-cover border border-border"
                          />
                        ) : (
                          <span className="w-10 h-10 rounded-md bg-accent-soft flex items-center justify-center text-xl">🍪</span>
                        )}
                        <span className="font-semibold flex-1">{selection.name}</span>
                        {countMode || <span className="text-muted">{formatPence(selection.pricePence)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`min-h-10 px-5 rounded-full text-sm font-bold cursor-pointer border transition-colors ${
        active
          ? "bg-accent text-white border-accent"
          : "bg-surface text-muted border-border hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SnackCard({
  product,
  busy,
  soldOut,
  showPrice,
  countMode,
  onPick,
}: {
  product: BudgetProduct;
  busy: boolean;
  soldOut: boolean;
  /** False in "count" mode — young children see coin prices instead. */
  showPrice: boolean;
  /** True in "count" mode — the card shows the item's coin value. */
  countMode: boolean;
  onPick: () => void;
}) {
  // Half price applies when the product is on or past its use-by date. The
  // server charges half price; the card shows the halved price with a badge.
  const halfPrice = product.halfPrice === true;
  const displayPrice =
    product.pricePence === null
      ? null
      : halfPrice
        ? Math.max(1, Math.round(product.pricePence / 2))
        : product.pricePence;
  // Coin value: the charged price rounded up to whole 5p coins (matches the
  // server's roundUpToNearest5), shown as a count of coins.
  const coinPrice =
    displayPrice === null ? null : Math.ceil(displayPrice / 5);
  return (
    <button
      className={`text-left bg-surface border rounded-xl p-4 backdrop-blur-md shadow-card transition-transform cursor-pointer ${
        soldOut
          ? "border-border opacity-50"
          : "border-border hover:-translate-y-1 hover:shadow-btn-hover active:translate-y-0"
      }`}
      onClick={soldOut ? undefined : onPick}
      disabled={soldOut || busy}
    >
      <div className="relative flex items-center justify-center h-24 rounded-lg bg-accent-soft mb-3">
        {product.image ? (
          <img src={product.image} alt={product.name} className="max-h-20 max-w-full object-contain" />
        ) : (
          <span className="text-4xl">🍪</span>
        )}
        {halfPrice && (
          <span className="absolute -top-1 -right-1 rotate-6 bg-accent text-white text-[10px] font-extrabold tracking-wide px-2 py-0.5 rounded shadow-md">
            HALF PRICE
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-sm leading-tight">{product.name}</span>
        {showPrice && displayPrice !== null && (
          <span className="text-accent-strong font-extrabold whitespace-nowrap">
            {formatPence(displayPrice)}
          </span>
        )}
        {countMode && coinPrice !== null && (
          <CoinStack count={coinPrice} small />
        )}
      </div>
      {halfPrice && showPrice && (
        <p className="text-xs mt-1 font-bold text-accent-strong">Half price — eat me soon! ⏰</p>
      )}
      {soldOut ? (
        <p className="text-muted text-xs mt-2">All gone — pick another snack! 🐻</p>
      ) : (
        <p className="text-muted text-xs mt-2">
          {product.portionsLeft} {product.portionLabel ?? "portion"}
          {product.portionsLeft === 1 ? "" : "s"} left
        </p>
      )}
      {busy && <div className="spinner mt-3 mx-auto" />}
    </button>
  );
}

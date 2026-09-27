# Snacks app: use-by highlighting, half-price sticker, coin mode — handoff plan

Status: **code complete, deploying** (all tasks 1a–2d implemented; builds + tests green).
Date: 2026-09-24. Write this doc's status in as you go.

## Architecture (verified this session)

Two repos cooperate:

1. **`~/shopping`** (AWS CDK, profile `shopping`, account 497201305402, eu-west-2) — the "Wainsbury's" grocery app. `lambda/integration/snack-budget.ts` is a token-authed Lambda the snacks app calls server-to-server:
   - `GET /integration/snack-products` → products grouped from inventory rows in locations `sc`, `cr`, `kc`. Each `SnackProduct`: `productSlug, name, image, pricePence, portionsLeft, portionLabel`.
   - `POST /integration/consume` / `POST /integration/unconsume` → deduct/restore a portion (oldest-first), returns `inventoryItemId`.
   - Inventory rows ALREADY carry `useByDate` (normalized in `normalizeItem`, snack-budget.ts:204) — it is just not exposed in the grouped product payload.
   - Tests: `lambda/integration/snack-budget.test.ts` (vitest).
2. **`~/Documents/GitHub/wainwright.fun`** — kids site + admin + API:
   - `cdk/lambda/budget-routes.ts` — the budget engine. Calls Wainsbury's via `fetchSnackProducts()` (line ~204). Kid routes: state (`handleKidBudgetState` ~617), products (~658), select (~714), unselect (~802). Admin routes: list products (`handleAdminListProducts` ~950), add selection (~973).
   - `shared/child-age.ts` — `SIMPLE_AGE_THRESHOLD = 6`, `SNACKS_UNIT_PRICE_PENCE = 25`, `snacksModeForAge(age)`. Children ≤6 (Zoe, Ethan, Joanna) get `"count"` mode; older get `"pence"`. Mode is derived from age, never stored.
   - Kid UI: `snacks/src/App.tsx` (+ `snacks/src/api.ts` types). Admin UI: `admin/src/SnacksPanel.tsx` (+ `admin/src/api.ts` `BudgetProduct` ~line 200).
   - Builds: `npm run build` (kids site), `npm run build:snacks`, `npm run build:admin`. Dev: `npm run dev:snacks` (port 5175, proxies /kid to api.wainwright.fun).

## User decisions (confirmed via clarify, do not re-ask)

1. **Half price is REAL**: a use-by item is actually charged at half its per-portion price, not just a sticker.
2. **Kids see the sticker too** in their picker (and the halved price), not admin-only.
3. **Coin mode charges the rounded price**: young children's items are rounded UP to the nearest 5p and that rounded amount is what's spent, so coin balances always reconcile.

## Task 1 — Use-by date + "half price" sticker

### 1a. Shopping repo: expose use-by + half-price flag
File `lambda/integration/snack-budget.ts`, `handleSnackProducts()` (~line 283):
- While grouping by `productSlug`, also track the **earliest `useByDate`** across the product's active (non-removed) inventory rows (rows without a use-by date are ignored for the minimum; null if no row has one).
- Add to `SnackProduct` interface (~line 92):
  - `useByDate: string | null` — earliest use-by across active rows (YYYY-MM-DD).
  - `halfPrice: boolean` — true when `useByDate` is set and `useByDate <= today` (London). "On its use-by date or exceeded" per the user.
- Half-price **pricePence**: keep `pricePence` as the normal price and let consumers halve, OR export a helper `halfPricePence(pricePence) = pricePence === null ? null : Math.max(1, Math.round(pricePence / 2))`. Prefer exposing the helper + flag so each app applies it consistently.
- Compare dates as London-date strings (there's a `londonToday()` pattern in budget-routes.ts:242; shopping repo may have its own — reuse/mirror it).
- Add vitest cases in `snack-budget.test.ts` for the earliest-date pick, the `<= today` boundary, and the halving helper.

### 1b. wainwright.fun API: pass through + charge half price
File `cdk/lambda/budget-routes.ts`:
- Extend `WainsburysProduct` (~line 162) with `useByDate: string | null` and `halfPrice: boolean`.
- `handleKidBudgetProducts` (~658) and `handleAdminListProducts` (~950): include both new fields in the mapped output.
- `handleKidBudgetSelect` (~714): when `product.halfPrice`, the charged `pricePence` (line ~751) becomes the halved price **before** the count-mode rounding in Task 2 is applied. Stored selection carries the halved price → refunds (unselect uses stored `pricePence`) and history reconcile automatically.
- `handleAdminAddSelection` (~973): same halving when the product is half-price, so parent-added snacks match.
- `handleKidBudgetState`: no change needed (balance derives from stored selections).

### 1c. Admin panel UI
File `admin/src/SnacksPanel.tsx`, "Selectable snacks" grid (~line 246) and `admin/src/api.ts` `BudgetProduct`:
- Add `useByDate: string | null; halfPrice: boolean` to the interface.
- On each product card: show the use-by date when set (e.g. "Use by 24 Sep"), **highlighted** (amber when within a day or two, red/danger when today or past — match the app's existing token classes `text-danger`, `bg-red-50`, `border-red-200`).
- Add a **"HALF PRICE" sticker** badge on any `halfPrice` item — rotated sticker-style badge over the product image corner, and show the halved price next to the normal one (e.g. "~~35p~~ 18p").

### 1d. Kid picker UI
Files `snacks/src/api.ts` (`BudgetProduct`) and `snacks/src/App.tsx` (`SnackCard`, ~line 418):
- Pass through `useByDate`/`halfPrice`; on `halfPrice` items show a small "HALF PRICE" sticker on the card and the halved price (kids see it — decision 2). Keep it friendly/large — young readers.

## Task 2 — Coin mode for young children (≤6)

Replaces "one item per day" count mode with 5p-coin pricing. **Engine stays in pence underneath**; only presentation + per-pick price change.

### 2a. Shared helpers — `shared/child-age.ts`
- Add `export const COIN_UNIT_PENCE = 5;`
- Add `export function roundUpToNearest5(pence: number): number` (→ `Math.ceil(pence / 5) * 5`).
- Add `export function coinsFor(pence: number): number` (→ `Math.floor(pence / COIN_UNIT_PENCE)`).
- Keep the file dependency-free (established convention, see header comment).
- `SNACKS_UNIT_PRICE_PENCE` stays (it remains the count-mode fallback when a product has no price).

### 2b. API — `cdk/lambda/budget-routes.ts`
- `handleKidBudgetState` (~617): in count mode, replace `snacks_remaining = floor(remaining / 25)` semantics with **`coins_remaining = floor(balance.remaining_pence / COIN_UNIT_PENCE)`**. Keep the response field `snacks_remaining` for compatibility OR rename to `coins_remaining` — pick `coins_remaining` (new field) and keep `snacks_remaining` null in count mode; update the SPA accordingly (only consumer is our own snacks SPA).
- `handleKidBudgetSelect` (~714): count-mode charged price becomes
  `roundUpToNearest5(halfPrice ? halfPricePence(product.pricePence) : (product.pricePence ?? SNACKS_UNIT_PRICE_PENCE))`
  i.e. real per-portion price (halved when on/past use-by), rounded up to a whole number of 5p coins. Decision 3 confirmed: charge the rounded price.
- Error message for insufficient balance in count mode: "You don't have enough coins for that snack today!" (currently "You've already picked all your snacks…", line ~756).
- Note: an item priced 0 rounds to 0 → free picks; fine.

### 2c. Kid SPA — `snacks/src/api.ts` + `snacks/src/App.tsx`
- `BudgetState`: add `coins_remaining: number | null`.
- **Header pill (count mode)**, App.tsx ~277: instead of "N snacks left today", show a **big number = coin count** plus **one coin icon per coin** (e.g. 25p left → big "5" + 5 coin icons). Cap the rendered icons sensibly (e.g. show count badge + icons up to ~20, then "×N") — balances with rollover can grow.
- **SnackCard (count mode)**, App.tsx ~418: next to each item show its **coin value**: big number of coins (rounded price / 5) + that many coin icons (e.g. 15p → "3" + 3 coins). Replace the old `showPrice` suppression — young children now DO see a price, expressed in coins.
- **Coin icon**: no existing asset in the repo — create a small inline SVG `CoinIcon` component (circle, gold, "5p" text), sized ~20–28px, `aria-hidden`. Do not fetch external images.
- History list (count mode, ~360): optionally show coin cost per selection; low priority.
- `budgetRemaining()` helper (App.tsx:37) and the `done` check must switch to coins: done when `coins_remaining <= 0` (equivalently `remaining_pence < 5`).

### 2d. Admin panel
No coin UI needed (admin sees real pence), but the "Daily snack budgets" helper text (SnacksPanel.tsx ~184) should be updated: young children's allowance is spent in 5p coins, items round up to the nearest 5p.

## Order of work

1. Shopping repo (1a) + tests → its own deploy.
2. wainwright.fun API (1b, 2a, 2b) — one Lambda change covers both tasks.
3. Admin UI (1c, 2d), Kid SPA (1d, 2c).
4. `npm run build` + `npm run build:snacks` + `npm run build:admin` all clean (tsc via vite).
5. **Show the user screenshots/mockups of the sticker + coin UI before deploying** (user expectation: validate visually first; metrics lie).
6. Deploy: shopping `cdk deploy` (profile `shopping`), wainwright.fun `npm run deploy` / `cdk deploy`. **STOP and confirm with the user before any deploy** (user expectation: stop before expensive ops).

## Open details the implementer may settle (low stakes)

- Exact sticker visual (rotation/colour) — follow the app's existing design tokens (`bg-accent-soft`, `text-accent-strong`, etc.).
- Whether the use-by date shows on kid cards too (currently planned: admin only + sticker on kid cards).
- Rounding of the half price before coin rounding: plan uses `Math.round(price/2)` then round-up-to-5 (e.g. 35p → 18p → 20p = 4 coins).

# Kids Allowed Apps

A React website and iOS configuration profile for managing which apps each child can use on their iPad.

Each child is paired to an iPad with a QR code from the admin site. After pairing, `wainwright.fun` loads that child's apps from a private API. Edit children and apps in admin — the kids site updates on the next refresh, with no redeploy.

## What it does

1. **One kids website** — `https://wainwright.fun` asks to pair an iPad, then shows that child's apps and websites.
2. **Admin** — `https://admin.wainwright.fun` (Cognito + MFA) manages children, apps, and pairing QR codes.
3. **Age-based access** — `date_of_birth` determines each child's age. Every app, system app, and website has its own `min_age` (any age — it doesn't need to match a theme band). Older children get everything younger children get. Theme bands (`age_bands`) only control the site theme and subtitle, never app membership.
4. **Configuration profile** — an `.mobileconfig` per child that restricts the iPad to their allowed apps. Safari is limited to `wainwright.fun`, `api.wainwright.fun`, and their allowed websites.
5. **On-iPad personalisation** — a paired iPad can pick its own avatar. That writes through the kid API; it is not world-readable.

## Quick start

### Prerequisites

- Node.js 20+
- AWS CLI configured (`aws configure`) — only needed for deploy
- AWS CDK bootstrapped in your account (`npx cdk bootstrap`) — only needed for deploy

### Install

```bash
npm install
```

### Configure children and apps

Edit [`apps.yaml`](apps.yaml):

**Children** — one entry per child with `name`, `subdomain` (stable ID), and `date_of_birth`:

```yaml
children:
  - name: Hannah
    subdomain: hannah
    date_of_birth: 2019-04-12
```

**Age bands** — themes grouped by `from_age`. Bands drive the site theme and subtitle only; apps and websites are gated by their own `min_age`, not band membership:

```yaml
age_bands:
  - from_age: 0
    theme: little      # big icons, no categories, no search
  - from_age: 3
    theme: early
  - from_age: 6
    theme: primary     # categories + search
  - from_age: 11
    theme: teen

apps:
  - name: Disney Magic Timer by Oral-B
    bundle_id: DisneyDigitalBooks.DisneyMagicBrushTimer
    app_store_url: https://apps.apple.com/gb/app/disney-magic-timer-by-oral-b/id747541884
    min_age: 4         # any age — appears for every child aged 4+
    category: Health & Fitness
```

Each app needs `name`, `bundle_id`, and `app_store_url`. Optional `category` (used for primary/teen themes).

Verify bundle IDs before deploy:

```bash
npm run check-bundle-ids
```

App and website icons are fetched automatically on build/dev into `public/app-icons/` and `public/website-icons/`. The App Store built-in app has no iTunes listing — its icon lives in `public/system-icons/app-store.png`. Re-extract it from macOS after an OS update with:

```bash
npm run extract-system-icons
```

## Local development

```bash
npm run dev
```

Kids site: `http://localhost:5173` (pairing screen unless the iPad is already paired against the API).

```bash
npm run dev:admin
```

Admin: `http://localhost:5174`. Cognito callback URLs include localhost.

Optional yaml-backed preview without pairing:

```bash
VITE_CHILD=hannah npm run dev
```

### Test on an iPad on your home network

Use the Network URL Vite prints (e.g. `http://192.168.1.42:5173`). Pairing talks to `https://api.wainwright.fun`, so the iPad needs internet, not just LAN.

### Test the production build locally

```bash
npm run build
npm run preview
```

## Deploy to AWS

```bash
npm run deploy
```

CloudFront certificates must be in **us-east-1**:

```bash
export CDK_DEFAULT_REGION=us-east-1

npm run deploy -- \
  -c domainName=wainwright.fun \
  -c hostedZoneId=Z0123456789ABCDEF \
  -c hostedZoneName=wainwright.fun
```

Copy [`cdk.context.example.json`](cdk.context.example.json) to `cdk.context.json` with your values.

CDK creates a wildcard ACM certificate (`*.wainwright.fun`), a CloudFront distribution with host routing, and a Route 53 wildcard A record.

Each child is paired from admin. Former child subdomains (`hannah.wainwright.fun`) still serve the same kids SPA so old iPad bookmarks keep working until profiles are reinstalled.

## Installing the profile on an iPad

1. In admin → Children, open the child and tap **Show QR code**.
2. On the iPad, open `https://wainwright.fun` and scan the code (or type it).
3. Add to Home Screen for a PWA-style shortcut.
4. Tap **Install iPad Profile** and follow the prompts in Settings.
5. Re-install the profile whenever you add or remove apps.

Public profiles are locked by default (kids cannot remove them). To uninstall as a parent: in admin → Children, turn off **Locked** for that child → open the paired site and install the updated profile → remove it in Settings → turn **Locked** back on → reinstall the locked profile.

## Project structure

```
apps.yaml                    ← children, apps, websites, theme bands (generated from DynamoDB)
src/                         ← kids SPA (pairing, avatar, apps)
admin/                       ← parent admin (Cognito)
cdk/lambda/kid-routes.ts     ← pairing + kid API
cdk/lib/kids-apps-stack.ts   ← S3, CloudFront, DNS
```

## How restrictions work

- **Apps** — `com.apple.applicationaccess` with `allowlistedAppBundleIDs`
- **Websites** — `com.apple.webcontent-filter` allowlist: `wainwright.fun`, `api.wainwright.fun`, plus age-appropriate websites
- **Profile ID** — `fun.wainwright.kids.{id}` so each child's profile updates independently

## Costs

Minimal for a family site: S3 storage pennies per month, CloudFront free tier covers typical traffic, Route 53 hosted zone ~$0.50/month.

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"  # repo root (this script lives in tools/)
cd "$ROOT"

export AWS_PROFILE=email
export AWS_REGION=us-east-1

echo "→ Fetching stack outputs..."
BUCKET="$(aws cloudformation describe-stacks \
  --stack-name KidsAppsStack \
  --query "Stacks[0].Outputs[?ExportName=='KidsAppsBucketName'].OutputValue" \
  --output text)"

DIST_ID="$(aws cloudformation describe-stacks \
  --stack-name KidsAppsStack \
  --query "Stacks[0].Outputs[?ExportName=='KidsAppsDistributionId'].OutputValue" \
  --output text)"

COGNITO_DOMAIN="$(aws cloudformation describe-stacks \
  --stack-name AuthStack \
  --query "Stacks[0].Outputs[?ExportName=='AdminCognitoDomain'].OutputValue" \
  --output text)"

COGNITO_CLIENT_ID="$(aws cloudformation describe-stacks \
  --stack-name AuthStack \
  --query "Stacks[0].Outputs[?ExportName=='AdminUserPoolClientId'].OutputValue" \
  --output text)"

API_URL="$(aws cloudformation describe-stacks \
  --stack-name ApiStack \
  --query "Stacks[0].Outputs[?ExportName=='AdminApiUrl'].OutputValue" \
  --output text)"

echo "→ Generating apps.yaml from DynamoDB..."
pnpm exec tsx packages/infra/scripts/generate-config.ts

echo "→ Downloading icons from S3..."
for dir in app-icons website-icons system-icons ticket-icons; do
  mkdir -p "apps/kids/public/${dir}"
  aws s3 sync "s3://${BUCKET}/${dir}/" "apps/kids/public/${dir}/" \
    --delete \
    --cache-control "no-cache"
done

echo "→ Building kids site..."
pnpm run build

echo "→ Deploying infrastructure (if needed)..."
pnpm exec cdk deploy --all --require-approval never "$@" --app "tsx packages/infra/bin/app.ts"

echo "→ Building admin site..."
VITE_COGNITO_DOMAIN="${COGNITO_DOMAIN}" \
VITE_COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID}" \
VITE_ADMIN_ORIGIN="https://admin.wainwright.fun" \
VITE_API_URL="${API_URL}" \
  pnpm run build:admin

# Guard: a bundle built without the Cognito vars ships a login page that can
# never authenticate (config compiles to `void 0`). Vite already refuses that
# build, but verify the artifact too — never upload an unauthenticated admin.
# The domain may be a custom one (auth.wainwright.fun), so grep for the real
# value rather than amazoncognito.com.
ADMIN_BUNDLE="$(ls apps/admin/dist/assets/*.js | head -1)"
if ! grep -q "$COGNITO_DOMAIN" "$ADMIN_BUNDLE"; then
  echo "ERROR: admin bundle $ADMIN_BUNDLE has no Cognito domain ($COGNITO_DOMAIN) — refusing to deploy." >&2
  exit 1
fi
echo "  ✓ admin bundle contains Cognito config"

echo "→ Building snacks site..."
pnpm run build:snacks

echo "→ Building tickets site..."
pnpm run build:tickets

echo "→ Building twin site..."
pnpm run build:twin

echo "→ Uploading kids site and shared assets to s3://${BUCKET}/..."
aws s3 sync "apps/kids/dist/" "s3://${BUCKET}/" \
  --exclude "admin/*" \
  --exclude "snacks/*" \
  --exclude "tickets/*" \
  --cache-control "public, max-age=3600"

echo "→ Uploading admin site..."
aws s3 sync "apps/admin/dist/" "s3://${BUCKET}/admin/" \
  --delete \
  --cache-control "public, max-age=3600"

echo "→ Uploading snacks site..."
aws s3 sync "apps/snacks/dist/" "s3://${BUCKET}/snacks/" \
  --delete \
  --cache-control "public, max-age=3600"

echo "→ Uploading tickets site..."
aws s3 sync "apps/tickets/dist/" "s3://${BUCKET}/tickets/" \
  --delete \
  --cache-control "public, max-age=3600"

echo "→ Uploading twin site..."
aws s3 sync "apps/twin/dist/" "s3://${BUCKET}/twin/" \
  --delete \
  --cache-control "public, max-age=3600"

# Entry-point HTML must always revalidate: hashed assets can cache, but a cached
# index.html pins the SPA to a stale bundle for up to max-age on the device
# (CloudFront invalidation does not clear Safari's local cache).
echo "→ Marking entry-point HTML as no-cache..."
aws s3 cp "apps/kids/dist/index.html" "s3://${BUCKET}/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"
aws s3 cp "apps/admin/dist/index.html" "s3://${BUCKET}/admin/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"
aws s3 cp "apps/snacks/dist/index.html" "s3://${BUCKET}/snacks/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"
aws s3 cp "apps/tickets/dist/index.html" "s3://${BUCKET}/tickets/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"
aws s3 cp "apps/twin/dist/index.html" "s3://${BUCKET}/twin/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"

echo "→ Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --output text \
  --query "Invalidation.Id"

echo ""
echo "Done!"
echo "Kids site:  https://wainwright.fun"
echo "Admin site: https://admin.wainwright.fun"
echo "Snacks site: https://snacks.wainwright.fun"
echo "Tickets site: https://tickets.wainwright.fun"
echo "Twin site:  https://twin.wainwright.fun"
echo "Auth domain: ${COGNITO_DOMAIN}"
echo "API: ${API_URL}"

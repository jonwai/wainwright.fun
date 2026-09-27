#!/usr/bin/env bash
# Dev server for the admin SPA with the Cognito config injected.
# `npm run dev:admin` alone leaves VITE_COGNITO_* unset (vite only reads
# .env files and the shell env), so the login page can never authenticate.
# This wrapper fetches the same CloudFormation outputs deploy.sh uses.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export AWS_PROFILE=email
export AWS_REGION=us-east-1

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

echo "→ Cognito: ${COGNITO_DOMAIN}  API: ${API_URL}"

exec env \
  VITE_COGNITO_DOMAIN="${COGNITO_DOMAIN}" \
  VITE_COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID}" \
  VITE_API_URL="${API_URL}" \
  npm run dev:admin:raw "$@"

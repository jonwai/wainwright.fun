#!/usr/bin/env bash
# The hosted AWS deploy (S3 + CloudFront site, Cognito, API Gateway + DynamoDB, twin) was retired
# on 11 Oct 2026. Every wainwright.fun site is served from the home Mac (packages/local behind
# Caddy; see packages/local/README.md and Dockerfile.local). Only the DNS helper stacks remain in
# AWS (GatewayDnsStack, LocalAcmeDnsStack); deploy one explicitly if it ever needs to change:
#   AWS_PROFILE=email pnpm exec cdk deploy LocalAcmeDnsStack --app "tsx packages/infra/bin/app.ts"
echo "Hosted deploy retired (11 Oct 2026): wainwright.fun is served from the home Mac." >&2
exit 1

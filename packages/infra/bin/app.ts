import * as cdk from "aws-cdk-lib";
import { GatewayDnsStack } from "../lib/gateway-dns-stack.js";
import { LocalAcmeDnsStack } from "../lib/local-acme-dns-stack.js";

const app = new cdk.App();

const domainName = "wainwright.fun";

/**
 * The Lakitu gateway account and the role its CDK deploys under. These two values are the whole
 * of the cross-account trust: `GatewayDnsStack` lets that role change records in this zone, and
 * nothing else. Keep them in step with the Lakitu stack's `-c dnsRoleArn`.
 */
const gatewayAccount = "967281205009";

const account = "926274062211";
const region = "us-east-1"; // CloudFront + ACM certs require us-east-1

// KidsAppsStack, AuthStack and ApiStack (CloudFront site, Cognito, API Gateway + DynamoDB) were
// retired on 11 Oct 2026: every wainwright.fun site now runs on the home Mac (packages/local,
// Caddy). Their CloudFormation stacks were deleted; a backup of tables, bucket and templates is
// in ~/Backups/wainwright-fun-aws-2026-10-11 on the Mac. The lib/ files stay for reference and
// because packages/local reuses the Lambda handlers. Only the DNS helper stacks below remain.

/**
 * DNS for the Lakitu LiteLLM gateway (which lives in `gatewayAccount`). Deploy this once with the
 * `email` profile; it creates only the cross-account writer role and exports the zone. The
 * records themselves are written by the Lakitu stack, from the other account, through that role.
 *
 * `fromLookup` needs a concrete account and region, so this stack does not deploy with the
 * account-agnostic `-e`/env-less synth some CDKs use; it is pinned like the rest.
 */
new GatewayDnsStack(app, "GatewayDnsStack", {
  env: { account, region },
  domainName,
  gatewayAccount,
});

/**
 * Certificates for apps served from the home Mac Studio (Caddy, ACME DNS-01). One IAM user that
 * may write only the `_acme-challenge` TXT records for these hostnames. Deploy with the `email`
 * profile; the access key is created separately into the Mac's `wainwright-fun-acme` profile.
 */
new LocalAcmeDnsStack(app, "LocalAcmeDnsStack", {
  env: { account, region },
  domainName,
  certificateNames: [
    "snacks.wainwright.fun",
    "admin.snacks.wainwright.fun",
    "kitchen.wainwright.fun",
    "admin.kitchen.wainwright.fun",
    // Kitchen wall tablet (jonwai/kitchen apps/fire), 20 Oct 2026.
    "fire.kitchen.wainwright.fun",
    "household.wainwright.fun",
    "admin.household.wainwright.fun",
    // wainwright.fun apps moved to the Mac (8 Oct 2026); hosted api/auth/chores/twin retired 11 Oct 2026.
    "wainwright.fun",
    "www.wainwright.fun",
    "admin.wainwright.fun",
    "tickets.wainwright.fun",
    "hannah.wainwright.fun",
    "lydia.wainwright.fun",
    "zoe.wainwright.fun",
    "ethan.wainwright.fun",
    "joanna.wainwright.fun",
    // Bible Journey (jonwai/bible-journey) moving to the Mac (8 Oct 2026).
    "bible.wainwright.fun",
    // Finance (jonwai/finance) on the Mac (17 Oct 2026).
    "finance.wainwright.fun",
    // Brush Time (kids' tooth brushing, ../brush) on the Mac (26 Oct 2026).
    "brush.wainwright.fun",
  ],
  userName: "wainwright-fun-local-acme",
});

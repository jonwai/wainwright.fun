import * as cdk from "aws-cdk-lib";
import { KidsAppsStack } from "../lib/kids-apps-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { GatewayDnsStack } from "../lib/gateway-dns-stack.js";
import { LocalAcmeDnsStack } from "../lib/local-acme-dns-stack.js";

const app = new cdk.App();

const domainName = "wainwright.fun";
const authDomain = `auth.${domainName}`;
const apiDomain = `api.${domainName}`;
const adminOrigin = `https://admin.${domainName}`;

/**
 * The Lakitu gateway account and the role its CDK deploys under. These two values are the whole
 * of the cross-account trust: `GatewayDnsStack` lets that role change records in this zone, and
 * nothing else. Keep them in step with the Lakitu stack's `-c dnsRoleArn`.
 */
const gatewayAccount = "967281205009";

const account = "926274062211";
const region = "us-east-1"; // CloudFront + ACM certs require us-east-1

const kidsAppsStack = new KidsAppsStack(app, "KidsAppsStack", {
  env: { account, region },
  domainName,
});

const authStack = new AuthStack(app, "AuthStack", {
  env: { account, region },
  hostedZone: kidsAppsStack.hostedZone,
  certificate: kidsAppsStack.certificate,
  domainName,
  authDomain,
  adminOrigin,
});

new ApiStack(app, "ApiStack", {
  env: { account, region },
  hostedZone: kidsAppsStack.hostedZone,
  certificate: kidsAppsStack.certificate,
  domainName,
  apiDomain,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  configBucket: kidsAppsStack.bucket,
  distribution: kidsAppsStack.distribution,
});

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
    "household.wainwright.fun",
    "admin.household.wainwright.fun",
    // wainwright.fun apps moving to the Mac (8 Oct 2026). api and chores stay hosted: the chores
    // site still runs on api.wainwright.fun and its tables.
    "wainwright.fun",
    "www.wainwright.fun",
    "admin.wainwright.fun",
    "tickets.wainwright.fun",
    "twin.wainwright.fun",
    "hannah.wainwright.fun",
    "lydia.wainwright.fun",
    "zoe.wainwright.fun",
    "ethan.wainwright.fun",
    "joanna.wainwright.fun",
  ],
  userName: "wainwright-fun-local-acme",
});

# DNS for the Lakitu gateway

`llm.wainwright.fun` points at the LiteLLM gateway. Two stacks in two accounts are involved, and
this file records why, so the next person does not have to work it out again.

## The two accounts

| Account | Id | Profile | Owns |
|---|---|---|---|
| email | `926274062211` | `email` | the `wainwright.fun` hosted zone (`Z0855463Z3LRVEM1C5B6`) |
| wainwrightfun | `967281205009` | `wainwrightfun` | the Lightsail container service, and the gateway's secrets |

The zone is not in the gateway's account, so the gateway's CDK cannot write to it with its own
credentials. `GatewayDnsStack` (this repository, deployed with the `email` profile) creates a role
that the gateway account may assume, scoped to records in that one zone and nothing else.

## One-time setup

In **this** repository, with the `email` profile:

```bash
export CDK_DEFAULT_REGION=us-east-1
npx cdk deploy GatewayDnsStack --profile email
```

Its outputs are what the Lakitu stack needs:

```
LakituGatewayHostedZoneId    → -c hostedZoneId
LakituGatewayDnsRoleArn      → -c dnsRoleArn
```

The role is `lakitu-gateway-dns-writer`. It trusts exactly
`arn:aws:iam::967281205009:role/cdk-hnb659fds-deploy-role-967281205009-us-east-1` — the CDK
bootstrap deploy role in the gateway account — and it can only call
`route53:ChangeResourceRecordSets`, `ListResourceRecordSets` and `GetChange` on
`arn:aws:route53:::hostedzone/Z0855463Z3LRVEM1C5B6`.

If the gateway account is ever re-bootstrapped with a different qualifier, update
`gatewayDeployRoleName` in `packages/infra/bin/app.ts` and redeploy this stack.

## What the records are

The Lakitu stack writes both of them at deploy time, through that role:

- a **CNAME** proving domain control, so Lightsail will issue the gateway's certificate. Its name
  and value are not known until Lightsail creates the certificate, so the stack reads them from
  the Lightsail API and upserts the record before waiting for the certificate to become `ISSUED`.
- an **A alias** from `llm.wainwright.fun` to the container service's own domain. That domain is
  not known until the service exists, so it is written after the service is read back.

Neither is a `route53.ARecord` in this CDK: this version has no cross-account hosted-zone support,
so the record would be created in the wrong account. They are written by the stack's deployer
Lambda instead — see `lib/gateway-dns-stack.ts` here and `infra/lib/litellm-stack.ts` there.

Lightsail does not use the existing `*.wainwright.fun` ACM certificate (that one is for CloudFront,
in this account); it issues and renews its own, and the validation record above is what lets it.

## Tearing down

Deleting the Lakitu stack leaves the DNS records in place on purpose — removing the A record would
take the gateway off the internet without removing the service that costs money. Delete the
records by hand if you really mean to.

Deleting `GatewayDnsStack` removes the role. Deploy the Lakitu stack first if you do not want a
deploy to fail on a missing role.

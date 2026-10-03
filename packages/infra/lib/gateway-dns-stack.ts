import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

/**
 * DNS for the Lakitu LiteLLM gateway.
 *
 * The gateway lives in a different AWS account (`wainwrightfun`, 967281205009); this zone does
 * not. Two things cross the boundary:
 *
 *  1. **A record.** `llm.wainwright.fun` must point at the Lightsail container service's own
 *     domain. The A record is an alias to that domain, and it has to live in this zone.
 *
 *  2. **A certificate.** Lightsail issues and validates its own certificates and cannot use an
 *     ACM certificate — not even the wildcard that already exists here and would cover `llm`.
 *     Lightsail validates by reading DNS records from this zone, so the validation record has to
 *     be writable from the `wainwrightfun` account too.
 *
 * Rather than split the deploy across two accounts by hand, this stack does two things:
 *
 *  - it **exports** the zone id and name, and
 *  - it **creates a role** that the `wainwrightfun` account may assume to change records in this
 *    one zone, and only this one zone.
 *
 * The Lakitu stack then deploys entirely from `wainwrightfun`: it assumes this role and writes the
 * A record for the gateway hostname. (An instance gets its own TLS certificate over the ACME HTTP
 * challenge, so unlike the container-service design this no longer needs a validation record.)
 * This stack is deployed once, with the `email` profile, and rarely after that.
 *
 * The trust is the gateway **account**, not one named role in it. That is deliberate, and was
 * forced by how it is actually used: the principal that assumes this role is not the CDK deploy
 * role but a Lambda *service* role inside the gateway account (`LakituLiteLlm-DnsWriter...`),
 * which a named-role trust does not match. Naming the Lambda's role instead would break the next
 * time the stack is rebuilt with a new logical id. `sts:AssumeRole` from the account is also not
 * transitive: a principal in that account still needs its own `sts:AssumeRole` permission, which
 * only the stack grants to that one Lambda. Everything in the account is the same operator.
 */
export interface GatewayDnsStackProps extends cdk.StackProps {
  /** The domain this zone serves. */
  readonly domainName: string;
  /** The account that runs the gateway and deploys the Lakitu stack. */
  readonly gatewayAccount: string;
}

export class GatewayDnsStack extends cdk.Stack {
  public readonly hostedZone: route53.IPublicHostedZone;

  constructor(scope: Construct, id: string, props: GatewayDnsStackProps) {
    super(scope, id, props);

    const { domainName, gatewayAccount } = props;

    // The zone already exists (created by KidsAppsStack). Look it up rather than create a second
    // one: two hosted zones for the same name would split the records and serve neither.
    this.hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName,
    });

    const zoneName = `arn:aws:route53:::hostedzone/${this.hostedZone.hostedZoneId}`;

    // ── The cross-account role ─────────────────────────────────────
    // Scoped to record changes in this zone. `ChangeResourceRecordSets` is not resource-scopable
    // below the zone, so a principal with this role can change any record here.
    const dnsRole = new iam.Role(this, "DnsWriterRole", {
      roleName: "lakitu-gateway-dns-writer",
      description: `Lets the Lakitu gateway account write DNS records in ${domainName}`,
      assumedBy: new iam.AccountPrincipal(gatewayAccount),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    dnsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadTheZone",
        actions: ["route53:GetHostedZone", "route53:ListHostedZones", "route53:ListHostedZonesByName"],
        resources: ["*"],
      }),
    );

    dnsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ChangeRecordsInThisZoneOnly",
        actions: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetChange"],
        resources: [zoneName],
      }),
    );

    // `GetChange` is not zone-scoped; without it a client cannot wait for a change to settle.
    dnsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WaitForChanges",
        actions: ["route53:GetChange"],
        resources: ["arn:aws:route53:::change/*"],
      }),
    );

    // ── Outputs the Lakitu stack needs ─────────────────────────────
    new cdk.CfnOutput(this, "HostedZoneId", {
      value: this.hostedZone.hostedZoneId,
      description: "Pass to the Lakitu stack as -c hostedZoneId=",
      exportName: "LakituGatewayHostedZoneId",
    });

    new cdk.CfnOutput(this, "HostedZoneName", {
      value: domainName,
      description: "Pass to the Lakitu stack as -c hostedZoneName=",
      exportName: "LakituGatewayHostedZoneName",
    });

    new cdk.CfnOutput(this, "DnsRoleArn", {
      value: dnsRole.roleArn,
      description: "Pass to the Lakitu stack as -c dnsRoleArn=",
      exportName: "LakituGatewayDnsRoleArn",
    });
  }
}

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

/**
 * ACME DNS-01 for apps that run on the home Mac Studio (snacks, kitchen and household).
 *
 * The Mac runs Caddy natively and gets real certificates for hostnames in this zone by writing
 * `_acme-challenge` TXT records. This stack creates one IAM user for that and nothing else:
 *
 *  - It may change **only TXT records** named exactly as listed in `challengeNames`, in this one
 *    zone. Route 53's normalized-record-name and record-type condition keys enforce that, so the
 *    key cannot touch the app A/AAAA/CNAME records or anything else in `wainwright.fun`.
 *  - It may list records in this zone (the Caddy route53 provider reads the existing TXT values
 *    before it appends or removes its own), find the zone by name, and wait for a change.
 *
 * The access key is created out of band (`aws iam create-access-key`) straight into a local
 * profile on the Mac, so no secret passes through CloudFormation, outputs, or this repository.
 */
export interface LocalAcmeDnsStackProps extends cdk.StackProps {
  readonly domainName: string;
  /** Hostnames that need certificates; the user may write `_acme-challenge.<name>` TXT only. */
  readonly certificateNames: string[];
  readonly userName: string;
}

export class LocalAcmeDnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LocalAcmeDnsStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromLookup(this, "HostedZone", { domainName: props.domainName });
    const zoneArn = `arn:aws:route53:::hostedzone/${zone.hostedZoneId}`;
    const challengeNames = props.certificateNames.map((name) => `_acme-challenge.${name.toLowerCase().replace(/\.$/, "")}`);

    const user = new iam.User(this, "AcmeUser", { userName: props.userName });

    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOnlyTheseChallengeTxtRecords",
        actions: ["route53:ChangeResourceRecordSets"],
        resources: [zoneArn],
        conditions: {
          "ForAllValues:StringEquals": {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames": challengeNames,
            "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"],
          },
        },
      }),
    );

    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadThisZone",
        actions: ["route53:ListResourceRecordSets", "route53:GetHostedZone"],
        resources: [zoneArn],
      }),
    );

    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "FindZoneAndWaitForChanges",
        actions: ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetChange"],
        resources: ["*"],
      }),
    );

    new cdk.CfnOutput(this, "UserName", { value: user.userName });
    new cdk.CfnOutput(this, "HostedZoneId", { value: zone.hostedZoneId });
    new cdk.CfnOutput(this, "ChallengeRecordNames", { value: challengeNames.join(",") });
  }
}

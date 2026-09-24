import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface KidsAppsStackProps extends cdk.StackProps {
  /** e.g. wainwright.fun — a hosted zone + wildcard cert are created for this domain */
  readonly domainName: string;
}

/**
 * CloudFront Function that routes hosts to S3 keys.
 *
 *   admin.wainwright.fun  → /admin/  (parent SPA)
 *   snacks.wainwright.fun → /snacks/ (kids snack budgets SPA)
 *   tickets.wainwright.fun → /tickets/ (kids tasks SPA)
 *   wainwright.fun        → /        (kids SPA)
 *   {child}.wainwright.fun → /       (same kids SPA, so old iPad profiles still load)
 *   www.wainwright.fun    → 301 to apex
 *
 * Shared asset paths (/app-icons/, /website-icons/, /system-icons/) pass through.
 */
const SUBDOMAIN_ROUTING_FUNCTION = `
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value.toLowerCase();
  var parts = host.split(".");
  var subdomain = parts[0];
  var uri = request.uri;
  var apex = parts.length >= 2 ? parts.slice(parts.length - 2).join(".") : host;

  if (subdomain === "www") {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: { value: "https://" + host.substring(4) + uri }
      }
    };
  }

  var isAdmin = subdomain === "admin";
  var isSnacks = subdomain === "snacks";
  var isTickets = subdomain === "tickets";

  if (!isAdmin && !isSnacks && !isTickets && (uri === "/admin" || uri.indexOf("/admin/") === 0 || uri.indexOf("/auth/") === 0)) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: { value: "https://admin." + apex + (uri === "/admin" ? "/" : uri) }
      }
    };
  }

  if (
    uri.indexOf("/app-icons/") === 0 ||
    uri.indexOf("/website-icons/") === 0 ||
    uri.indexOf("/system-icons/") === 0 ||
    uri.indexOf("/ticket-icons/") === 0
  ) {
    return request;
  }

  if (isAdmin) {
    if (uri.indexOf("/admin/") === 0) {
      if (uri === "/admin/" || uri.indexOf(".", 7) === -1) {
        request.uri = "/admin/index.html";
      }
      return request;
    }
    if (uri === "/" || uri.endsWith("/") || uri.indexOf(".") === -1) {
      request.uri = "/admin/index.html";
      return request;
    }
    request.uri = "/admin" + uri;
    return request;
  }

  if (isSnacks) {
    if (uri.indexOf("/snacks/") === 0) {
      if (uri === "/snacks/" || uri.indexOf(".", 8) === -1) {
        request.uri = "/snacks/index.html";
      }
      return request;
    }
    if (uri === "/" || uri.endsWith("/") || uri.indexOf(".") === -1) {
      request.uri = "/snacks/index.html";
      return request;
    }
    request.uri = "/snacks" + uri;
    return request;
  }

  if (isTickets) {
    if (uri.indexOf("/tickets/") === 0) {
      if (uri === "/tickets/" || uri.indexOf(".", 9) === -1) {
        request.uri = "/tickets/index.html";
      }
      return request;
    }
    if (uri === "/" || uri.endsWith("/") || uri.indexOf(".") === -1) {
      request.uri = "/tickets/index.html";
      return request;
    }
    request.uri = "/tickets" + uri;
    return request;
  }

  if (uri === "/" || uri.endsWith("/") || uri.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
`;

export class KidsAppsStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly hostedZone: route53.PublicHostedZone;
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: KidsAppsStackProps) {
    super(scope, id, props);

    const { domainName } = props;
    const wildcardDomain = `*.${domainName}`;
    const apexDomain = domainName;

    // ── S3 Bucket ──────────────────────────────────────────────────
    this.bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Route 53 Hosted Zone (created here, not looked up) ─────────
    this.hostedZone = new route53.PublicHostedZone(this, "HostedZone", {
      zoneName: domainName,
      comment: `Hosted zone for ${domainName}`,
    });

    // ── ACM Certificate (us-east-1 required for CloudFront) ────────
    // Wildcard covers *.wainwright.fun; apex is added as a SAN so
    // CloudFront can serve wainwright.fun directly.
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: wildcardDomain,
      subjectAlternativeNames: [apexDomain],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });
    this.certificate = certificate;

    // ── CloudFront Function: subdomain → S3 prefix routing ────────
    const subdomainRouter = new cloudfront.Function(this, "SubdomainRouter", {
      code: cloudfront.FunctionCode.fromInline(SUBDOMAIN_ROUTING_FUNCTION),
      comment: "Route admin host to /admin/, everyone else to the kids SPA",
    });

    // ── CloudFront Distribution ───────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: subdomainRouter,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      domainNames: [wildcardDomain, apexDomain],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: "Kids pairing site (apex + child aliases) + admin.wainwright.fun",
    });

    // ── Route 53 Wildcard Alias Record ────────────────────────────
    new route53.ARecord(this, "WildcardAlias", {
      zone: this.hostedZone,
      recordName: "*",
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    // ── Route 53 Apex Alias Record ────────────────────────────────
    new route53.ARecord(this, "ApexAlias", {
      zone: this.hostedZone,
      recordName: apexDomain,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    // ── Route 53 www Alias Record (redirects to apex via CF function) ──
    new route53.ARecord(this, "WwwAlias", {
      zone: this.hostedZone,
      recordName: "www",
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    // ── Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      exportName: "KidsAppsBucketName",
    });

    new cdk.CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
      exportName: "KidsAppsDistributionId",
    });

    new cdk.CfnOutput(this, "SiteUrl", {
      value: `https://*.${domainName}`,
    });

    new cdk.CfnOutput(this, "HostedZoneId", {
      value: this.hostedZone.hostedZoneId,
      exportName: "KidsAppsHostedZoneId",
    });

    new cdk.CfnOutput(this, "HostedZoneName", {
      value: this.hostedZone.zoneName,
      exportName: "KidsAppsHostedZoneName",
    });

    new cdk.CfnOutput(this, "CertificateArn", {
      value: certificate.certificateArn,
      exportName: "KidsAppsCertificateArn",
    });

    // Nameservers — set these at the domain registrar
    new cdk.CfnOutput(this, "Nameservers", {
      value: cdk.Fn.join(",", this.hostedZone.hostedZoneNameServers ?? []),
      description: "Set these NS records at your domain registrar",
    });
  }
}

import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface AuthStackProps extends cdk.StackProps {
  /** The hosted zone for wainwright.fun (from KidsAppsStack) */
  readonly hostedZone: route53.IHostedZone;
  /** The wildcard certificate for *.wainwright.fun (from KidsAppsStack) */
  readonly certificate: acm.ICertificate;
  /** e.g. wainwright.fun */
  readonly domainName: string;
  /** e.g. auth.wainwright.fun */
  readonly authDomain: string;
  /** The admin site origin URL for redirect URIs (e.g. https://wainwright.fun) */
  readonly adminOrigin: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { hostedZone, certificate, domainName, authDomain, adminOrigin } =
      props;
    const snacksAdminOrigin = `https://admin.snacks.${domainName}`;
    const kitchenAdminOrigin = `https://admin.kitchen.${domainName}`;
    const householdAdminOrigin = `https://admin.household.${domainName}`;

    // ── Cognito User Pool ──────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "wainwright-admin",
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Cognito User Pool Client ───────────────────────────────────
    this.userPoolClient = new cognito.UserPoolClient(this, "AdminClient", {
      userPool: this.userPool,
      userPoolClientName: "admin-web",
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `${adminOrigin}/`,
          `${adminOrigin}/auth/callback`,
          `${snacksAdminOrigin}/`,
          `${snacksAdminOrigin}/auth/callback`,
          `${kitchenAdminOrigin}/`,
          `${kitchenAdminOrigin}/auth/callback`,
          `${householdAdminOrigin}/`,
          `${householdAdminOrigin}/auth/callback`,
          "http://localhost:5174/",
          "http://localhost:5174/auth/callback",
        ],
        logoutUrls: [
          `${adminOrigin}/`,
          `${snacksAdminOrigin}/`,
          `${kitchenAdminOrigin}/`,
          `${kitchenAdminOrigin}/auth/callback`,
          `${householdAdminOrigin}/`,
          `${householdAdminOrigin}/auth/callback`,
          "http://localhost:5174/",
        ],
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    // ── Cognito Custom Domain (auth.wainwright.fun) ───────────────
    this.userPoolDomain = new cognito.UserPoolDomain(this, "UserPoolDomain", {
      userPool: this.userPool,
      customDomain: {
        domainName: authDomain,
        certificate,
      },
    });

    // ── Route 53 A Record for auth subdomain ───────────────────────
    new route53.ARecord(this, "AuthAlias", {
      zone: hostedZone,
      recordName: authDomain.replace(`.${domainName}`, ""),
      target: route53.RecordTarget.fromAlias(
        new targets.UserPoolDomainTarget(this.userPoolDomain)
      ),
    });

    // ── Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      exportName: "AdminUserPoolId",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
      exportName: "AdminUserPoolClientId",
    });

    new cdk.CfnOutput(this, "CognitoDomain", {
      value: `https://${authDomain}`,
      exportName: "AdminCognitoDomain",
    });

    new cdk.CfnOutput(this, "UserPoolProviderUrl", {
      value: this.userPool.userPoolProviderUrl,
      exportName: "AdminUserPoolProviderUrl",
    });
  }
}

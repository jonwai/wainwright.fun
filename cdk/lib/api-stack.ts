import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";

export interface ApiStackProps extends cdk.StackProps {
  readonly hostedZone: route53.IHostedZone;
  readonly certificate: acm.ICertificate;
  readonly domainName: string;
  readonly apiDomain: string;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly configBucket: s3.IBucket;
  readonly distribution: cloudfront.Distribution;
}

export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { hostedZone, certificate, domainName, apiDomain, userPool, userPoolClient, configBucket, distribution } = props;
    const distributionId = distribution.distributionId;

    // ── Secrets: signing cert + key ────────────────────────────────
    const signingCertSecret = new secretsmanager.Secret(this, "SigningCert", {
      secretName: "profile-signing-cert",
      description: "iOS profile signing certificate (PEM)",
    });

    const signingKeySecret = new secretsmanager.Secret(this, "SigningKey", {
      secretName: "profile-signing-key",
      description: "iOS profile signing private key (PEM)",
    });

    // ── DynamoDB Tables ────────────────────────────────────────────
    // Children: PK=subdomain
    const childrenTable = new dynamodb.Table(this, "ChildrenTable", {
      partitionKey: { name: "subdomain", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-children",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Apps: PK=bundle_id — covers both regular apps and system apps
    // type: "app" | "system"
    // enabled: boolean (disabled items excluded from yaml but icons still fetched)
    // minAge: number (0 = all age bands)
    const appsTable = new dynamodb.Table(this, "AppsTable", {
      partitionKey: { name: "bundle_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-apps",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Websites: PK=url
    const websitesTable = new dynamodb.Table(this, "WebsitesTable", {
      partitionKey: { name: "url", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-websites",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Themes: PK=from_age (number)
    const themesTable = new dynamodb.Table(this, "ThemesTable", {
      partitionKey: { name: "from_age", type: dynamodb.AttributeType.NUMBER },
      tableName: "wainwright-themes",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Restrictions: PK=key (e.g. "allowNews", "ratingApps")
    // type: "boolean" | "integer" | "real" | "string"
    // value: boolean | number | string
    const restrictionsTable = new dynamodb.Table(this, "RestrictionsTable", {
      partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-restrictions",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Pairing codes: PK=code, TTL on `ttl` (epoch seconds)
    const pairingTable = new dynamodb.Table(this, "PairingTable", {
      partitionKey: { name: "code", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-pairing",
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Devices: PK=device_id, GSI token_hash for bearer lookup
    const devicesTable = new dynamodb.Table(this, "DevicesTable", {
      partitionKey: { name: "device_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-devices",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    devicesTable.addGlobalSecondaryIndex({
      indexName: "TokenHashIndex",
      partitionKey: { name: "token_hash", type: dynamodb.AttributeType.STRING },
    });

    // Budgets: PK=budget_id (e.g. "snacks"). Generic by design — future budgets
    // (clothes, treats, shoes) are just new rows. Per-child config is stored as
    // maps of child subdomain → value so adding children needs no schema change:
    //   school_day_amount_pence:     { [child]: pence }
    //   non_school_day_amount_pence:  { [child]: pence }
    //   included_products:  [productSlug, ...] (allowlist — only ticked items
    //   appear in the picker)
    // There is no per-day item cap — money is the only limit.
    const budgetsTable = new dynamodb.Table(this, "BudgetsTable", {
      partitionKey: { name: "budget_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-budgets",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Budget selections: PK=child_subdomain, SK=`${budget_id}#${date}`.
    // One row per child/budget/day; selections is an append-only list of
    // { productSlug, name, pricePence, selectedAt, selectedBy }.
    // Previous unselected days stay open for later completion.
    const budgetSelectionsTable = new dynamodb.Table(this, "BudgetSelectionsTable", {
      partitionKey: { name: "child_subdomain", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "budget_day", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-budget-selections",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Budget transactions: PK=child_subdomain, SK=transaction_id (epoch-ms
    // based, so lexicographic order = chronological order). Append-only ledger
    // of everything that changes a child's balance:
    //   kind: "spend" | "refund" | "adjustment"
    //   amount_pence: signed delta (spend is negative)
    //   balance_after_pence: effective remaining after the transaction
    // Admin balance edits ("adjustment") are stored as deltas relative to
    // the day's allowance - spent, so the ledger always reconciles.
    const budgetTransactionsTable = new dynamodb.Table(this, "BudgetTransactionsTable", {
      partitionKey: { name: "child_subdomain", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "transaction_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-budget-transactions",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Tasks (Tickets app): PK=task_id. A task is a chore/achievement
    // an admin defines; completing it earns its ticket_reward. assigned_to
    // is a list of child subdomains (empty = every child). Tickets are
    // tracked separately from snack budgets by design.
    const tasksTable = new dynamodb.Table(this, "TasksTable", {
      partitionKey: { name: "task_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-tasks",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Task completions: PK=child_subdomain, SK=`${task_id}#${completed_at}`.
    // Append-only event log — one item per completion. A child's ticket total
    // is the sum over all events, so history always reconciles. Undo deletes
    // the newest event for that child+task.
    const taskCompletionsTable = new dynamodb.Table(this, "TaskCompletionsTable", {
      partitionKey: { name: "child_subdomain", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "task_completion", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-task-completions",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Rewards (Tickets app): PK=reward_id. A reward is a prize a child can
    // swap tickets for. cost_pence (what the prize really costs) is admin-only
    // bookkeeping — kid routes never return it.
    const rewardsTable = new dynamodb.Table(this, "RewardsTable", {
      partitionKey: { name: "reward_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-rewards",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Reward redemptions: PK=child_subdomain, SK=`${epoch36}-${rand}`.
    // Append-only event log — one item per redemption, status "pending" until
    // a parent marks it "claimed". Refund (child- or admin-initiated) deletes
    // the event and is only allowed while pending. Spendable tickets =
    // Σ completions − Σ redemptions, so history always reconciles.
    const rewardRedemptionsTable = new dynamodb.Table(this, "RewardRedemptionsTable", {
      partitionKey: { name: "child_subdomain", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "redemption_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-reward-redemptions",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Job board: PK=board_id. Postings that reference a library task
    // and add recurrence (repeat: once|daily|school_day|on_demand,
    // per-posting reward/audience overrides, posted/posted_at for on_demand,
    // completion_mode each_child|first_done). Kid-facing state is derived
    // from the completion log on the fly — nothing materialised per day.
    const jobBoardTable = new dynamodb.Table(this, "JobBoardTable", {
      partitionKey: { name: "board_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-job-board",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Term dates: PK=academic_year (e.g. "2026-2027"). One row per year with a
    // terms[] list — each term has opens/closes, optional half-term range,
    // inset days and bank holidays. Drives school-day vs non-school-day
    // budget allowances and will back other scheduling features later.
    const termDatesTable = new dynamodb.Table(this, "TermDatesTable", {
      partitionKey: { name: "academic_year", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-term-dates",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // ── Chores app tables ──────────────────────────────────────────
    // The house (synced with the twin model) drives the chores: rooms,
    // fixtures (furniture with jobs), windows and light switches/sensors.
    // A claimed chore materialises a task row in wainwright-tasks so it
    // appears in the Tickets app; completions flow through the shared
    // completion log. See cdk/lambda/chores-routes.ts for the full model.
    const choreRoomsTable = new dynamodb.Table(this, "ChoreRoomsTable", {
      partitionKey: { name: "room_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-chores-rooms",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const choreFixturesTable = new dynamodb.Table(this, "ChoreFixturesTable", {
      partitionKey: { name: "fixture_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-chores-fixtures",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const choreWindowsTable = new dynamodb.Table(this, "ChoreWindowsTable", {
      partitionKey: { name: "window_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-chores-windows",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const choreSwitchesTable = new dynamodb.Table(this, "ChoreSwitchesTable", {
      partitionKey: { name: "switch_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-chores-switches",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const choresTable = new dynamodb.Table(this, "ChoresTable", {
      partitionKey: { name: "chore_id", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-chores",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Chore claims: PK=child_subdomain, SK=`${chore_id}#${claimed_at}`.
    // One item per claim, pointing at the materialised Tickets task row.
    const choreClaimsTable = new dynamodb.Table(this, "ChoreClaimsTable", {
      partitionKey: { name: "child_subdomain", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "chore_claim", type: dynamodb.AttributeType.STRING },
      tableName: "wainwright-chore-claims",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Wainsbury's integration token — mirrors the secret held in the shopping
    // account. After both stacks deploy, copy the token value across with
    // scripts/sync-snack-token.sh (the Lambda only ever sees the hash).
    const wainsburysTokenSecret = new secretsmanager.Secret(this, "WainsburysToken", {
      secretName: "wainsburys-integration-token",
      description: "Non-expiring API token for the Wainsbury's snack integration (must match the shopping account secret)",
      secretObjectValue: {
        token: cdk.SecretValue.unsafePlainText("placeholder-set-by-sync-snack-token"),
      },
    });

    // ── SQS Queues ─────────────────────────────────────────────────
    const iconQueue = new sqs.Queue(this, "IconFetchQueue", {
      queueName: "wainwright-icon-fetch",
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.hours(1),
    });

    const rebuildQueue = new sqs.Queue(this, "RebuildQueue", {
      queueName: "wainwright-site-rebuild",
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.hours(1),
    });

    // ── API Lambda handler ─────────────────────────────────────────
    // (Logical id ApiHandlerV2 — renamed from ApiHandler to force a fresh
    //  asset + function after a CDK stale-asset-hash episode.)
    const apiHandler = new lambdaNodejs.NodejsFunction(this, "ApiHandlerV2", {
      entry: "cdk/lambda/api-v2.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      // 1024 → 1280: visible-prop bump to force a fresh Lambda asset
      // (content-only edits have produced unchanged asset hashes before).
      memorySize: 1280,
      timeout: cdk.Duration.seconds(30),
      environment: {
        CONFIG_BUCKET_NAME: configBucket.bucketName,
        ICON_QUEUE_URL: iconQueue.queueUrl,
        REBUILD_QUEUE_URL: rebuildQueue.queueUrl,
        CHILDREN_TABLE: childrenTable.tableName,
        APPS_TABLE: appsTable.tableName,
        WEBSITES_TABLE: websitesTable.tableName,
        THEMES_TABLE: themesTable.tableName,
        RESTRICTIONS_TABLE: restrictionsTable.tableName,
        PAIRING_TABLE: pairingTable.tableName,
        DEVICES_TABLE: devicesTable.tableName,
        BUDGETS_TABLE: budgetsTable.tableName,
        BUDGET_SELECTIONS_TABLE: budgetSelectionsTable.tableName,
        BUDGET_TRANSACTIONS_TABLE: budgetTransactionsTable.tableName,
        TASKS_TABLE: tasksTable.tableName,
        TASK_COMPLETIONS_TABLE: taskCompletionsTable.tableName,
        JOB_BOARD_TABLE: jobBoardTable.tableName,
        REWARDS_TABLE: rewardsTable.tableName,
        REDEMPTIONS_TABLE: rewardRedemptionsTable.tableName,
        TERM_DATES_TABLE: termDatesTable.tableName,
        CHORES_ROOMS_TABLE: choreRoomsTable.tableName,
        CHORES_FIXTURES_TABLE: choreFixturesTable.tableName,
        CHORES_WINDOWS_TABLE: choreWindowsTable.tableName,
        CHORES_SWITCHES_TABLE: choreSwitchesTable.tableName,
        CHORES_TABLE: choresTable.tableName,
        CHORES_CLAIMS_TABLE: choreClaimsTable.tableName,
        WAINSBURYS_TOKEN_SECRET: wainsburysTokenSecret.secretArn,
        WAINSBURYS_API_URL: "https://api.wainsburys.co.uk",
        SIGNING_CERT_SECRET: signingCertSecret.secretArn,
        SIGNING_KEY_SECRET: signingKeySecret.secretArn,
        SITE_ORIGIN: `https://${domainName}`,
      },
    });

    configBucket.grantReadWrite(apiHandler);
    iconQueue.grantSendMessages(apiHandler);
    rebuildQueue.grantSendMessages(apiHandler);
    childrenTable.grantReadWriteData(apiHandler);
    appsTable.grantReadWriteData(apiHandler);
    websitesTable.grantReadWriteData(apiHandler);
    themesTable.grantReadWriteData(apiHandler);
    restrictionsTable.grantReadWriteData(apiHandler);
    pairingTable.grantReadWriteData(apiHandler);
    devicesTable.grantReadWriteData(apiHandler);
    budgetsTable.grantReadWriteData(apiHandler);
    budgetSelectionsTable.grantReadWriteData(apiHandler);
    budgetTransactionsTable.grantReadWriteData(apiHandler);
    tasksTable.grantReadWriteData(apiHandler);
    taskCompletionsTable.grantReadWriteData(apiHandler);
    jobBoardTable.grantReadWriteData(apiHandler);
    rewardsTable.grantReadWriteData(apiHandler);
    rewardRedemptionsTable.grantReadWriteData(apiHandler);
    termDatesTable.grantReadWriteData(apiHandler);
    choreRoomsTable.grantReadWriteData(apiHandler);
    choreFixturesTable.grantReadWriteData(apiHandler);
    choreWindowsTable.grantReadWriteData(apiHandler);
    choreSwitchesTable.grantReadWriteData(apiHandler);
    choresTable.grantReadWriteData(apiHandler);
    choreClaimsTable.grantReadWriteData(apiHandler);
    wainsburysTokenSecret.grantRead(apiHandler);
    signingCertSecret.grantRead(apiHandler);
    signingKeySecret.grantRead(apiHandler);

    // ── Icon-fetcher Lambda ────────────────────────────────────────
    const iconFetcher = new lambdaNodejs.NodejsFunction(this, "IconFetcher", {
      entry: "cdk/lambda/icon-fetcher.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        CONFIG_BUCKET_NAME: configBucket.bucketName,
        APPS_TABLE: appsTable.tableName,
        WEBSITES_TABLE: websitesTable.tableName,
      },
    });

    configBucket.grantRead(iconFetcher);
    configBucket.grantPut(iconFetcher, "app-icons/*");
    configBucket.grantPut(iconFetcher, "website-icons/*");
    appsTable.grantReadData(iconFetcher);
    websitesTable.grantReadData(iconFetcher);

    iconFetcher.addEventSource(new lambdaEventSources.SqsEventSource(iconQueue, {
      batchSize: 1,
    }));

    // ── Site-rebuild Lambda ────────────────────────────────────────
    const siteRebuilder = new lambdaNodejs.NodejsFunction(this, "SiteRebuilder", {
      entry: "cdk/lambda/site-rebuilder.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        CONFIG_BUCKET_NAME: configBucket.bucketName,
        DISTRIBUTION_ID: distributionId,
        CHILDREN_TABLE: childrenTable.tableName,
        APPS_TABLE: appsTable.tableName,
        WEBSITES_TABLE: websitesTable.tableName,
        THEMES_TABLE: themesTable.tableName,
        RESTRICTIONS_TABLE: restrictionsTable.tableName,
        SIGNING_CERT_SECRET: signingCertSecret.secretArn,
        SIGNING_KEY_SECRET: signingKeySecret.secretArn,
      },
    });

    configBucket.grantReadWrite(siteRebuilder);
    childrenTable.grantReadData(siteRebuilder);
    appsTable.grantReadData(siteRebuilder);
    websitesTable.grantReadData(siteRebuilder);
    themesTable.grantReadData(siteRebuilder);
    restrictionsTable.grantReadData(siteRebuilder);
    signingCertSecret.grantRead(siteRebuilder);
    signingKeySecret.grantRead(siteRebuilder);

    // CloudFront invalidation permission
    siteRebuilder.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distributionId}`],
      })
    );

    siteRebuilder.addEventSource(new lambdaEventSources.SqsEventSource(rebuildQueue, {
      batchSize: 1,
    }));

    new scheduler.Schedule(this, "NightlyRebuildSchedule", {
      description: "Rebuild child sites and iPad profiles at midnight Europe/London",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: "0",
        timeZone: cdk.TimeZone.EUROPE_LONDON,
      }),
      target: new schedulerTargets.SqsSendMessage(rebuildQueue, {
        input: scheduler.ScheduleTargetInput.fromObject({
          action: "rebuild",
          source: "nightly-schedule",
        }),
      }),
    });

    // ── HTTP API v2 ────────────────────────────────────────────────
    this.httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: "wainwright-admin-api",
      description: "Admin + kid API for wainwright.fun",
      corsPreflight: {
        allowOrigins: [
          `https://${domainName}`,
          `https://admin.${domainName}`,
          `https://snacks.${domainName}`,
          `https://tickets.${domainName}`,
          `https://twin.${domainName}`,
          `https://chores.${domainName}`,
          "http://localhost:5173",
          "http://localhost:5174",
          "http://localhost:5175",
          "http://localhost:5176",
          "http://localhost:5177",
          "http://localhost:5178",
        ],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["Content-Type", "Authorization"],
        allowCredentials: true,
        maxAge: cdk.Duration.seconds(86400),
      },
    });

    // ── Cognito JWT Authorizer ─────────────────────────────────────
    const authorizer = new HttpUserPoolAuthorizer("CognitoAuthorizer", userPool, {
      userPoolClients: [userPoolClient],
    });

    // ── Routes ─────────────────────────────────────────────────────
    // All routes go to the same Lambda which dispatches by method+path.
    // We use {proxy+} for resource/id patterns, plus explicit routes for
    // root-level resources (GET /config, GET /icons, GET /me, etc.)
    const allMethods = [
      apigw.HttpMethod.GET,
      apigw.HttpMethod.POST,
      apigw.HttpMethod.PUT,
      apigw.HttpMethod.DELETE,
    ];

    // Note: /restrictions is handled by the /{proxy+} catch-all below,
    // to avoid exceeding the Lambda resource policy size limit (20KB).
    // /term-dates likewise goes through the catch-all.
    for (const path of ["/me", "/config", "/icons", "/children", "/apps", "/websites", "/themes", "/rebuild"]) {
      this.httpApi.addRoutes({
        path,
        methods: allMethods,
        integration: new HttpLambdaIntegration(`Root${path}Integration`, apiHandler),
        authorizer,
      });
    }

    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: allMethods,
      integration: new HttpLambdaIntegration("ProxyIntegration", apiHandler),
      authorizer,
    });

    // Kid routes are token-authenticated inside the Lambda, not via Cognito.
    this.httpApi.addRoutes({
      path: "/pair",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("PairIntegration", apiHandler),
    });
    this.httpApi.addRoutes({
      path: "/kid/{proxy+}",
      methods: allMethods,
      integration: new HttpLambdaIntegration("KidIntegration", apiHandler),
    });

    // Same-origin kid API via CloudFront so old iPad Safari allowlists
    // (child subdomains only) can still pair without first reinstalling a profile.
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const kidApiBehavior: cloudfront.AddBehaviorOptions = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    };
    distribution.addBehavior("/pair", apiOrigin, kidApiBehavior);
    distribution.addBehavior("/kid/*", apiOrigin, kidApiBehavior);

    // ── Custom Domain: api.wainwright.fun ──────────────────────────
    const apiDomainName = new apigw.DomainName(this, "ApiDomainName", {
      domainName: apiDomain,
      certificate,
    });

    new apigw.ApiMapping(this, "ApiMapping", {
      api: this.httpApi,
      domainName: apiDomainName,
    });

    // ── Route 53 A Record ──────────────────────────────────────────
    new route53.ARecord(this, "ApiAlias", {
      zone: hostedZone,
      recordName: apiDomain.replace(`.${domainName}`, ""),
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId
        )
      ),
    });

    // ── Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiUrl", {
      value: `https://${apiDomain}`,
      exportName: "AdminApiUrl",
    });

    new cdk.CfnOutput(this, "ApiId", {
      value: this.httpApi.apiId,
      exportName: "AdminApiId",
    });

    new cdk.CfnOutput(this, "IconQueueUrl", {
      value: iconQueue.queueUrl,
      exportName: "AdminIconQueueUrl",
    });

    new cdk.CfnOutput(this, "RebuildQueueUrl", {
      value: rebuildQueue.queueUrl,
      exportName: "AdminRebuildQueueUrl",
    });

    new cdk.CfnOutput(this, "SigningCertSecretArn", {
      value: signingCertSecret.secretArn,
      exportName: "AdminSigningCertSecret",
    });

    new cdk.CfnOutput(this, "SigningKeySecretArn", {
      value: signingKeySecret.secretArn,
      exportName: "AdminSigningKeySecret",
    });

    new cdk.CfnOutput(this, "ChildrenTableName", {
      value: childrenTable.tableName,
      exportName: "AdminChildrenTable",
    });

    new cdk.CfnOutput(this, "AppsTableName", {
      value: appsTable.tableName,
      exportName: "AdminAppsTable",
    });

    new cdk.CfnOutput(this, "WebsitesTableName", {
      value: websitesTable.tableName,
      exportName: "AdminWebsitesTable",
    });

    new cdk.CfnOutput(this, "ThemesTableName", {
      value: themesTable.tableName,
      exportName: "AdminThemesTable",
    });

    new cdk.CfnOutput(this, "RestrictionsTableName", {
      value: restrictionsTable.tableName,
      exportName: "AdminRestrictionsTable",
    });

    new cdk.CfnOutput(this, "BudgetsTableName", {
      value: budgetsTable.tableName,
      exportName: "AdminBudgetsTable",
    });

    new cdk.CfnOutput(this, "BudgetSelectionsTableName", {
      value: budgetSelectionsTable.tableName,
      exportName: "AdminBudgetSelectionsTable",
    });
  }
}

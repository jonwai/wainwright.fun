import * as cdk from "aws-cdk-lib";
import { KidsAppsStack } from "../lib/kids-apps-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { ApiStack } from "../lib/api-stack.js";

const app = new cdk.App();

const domainName = "wainwright.fun";
const authDomain = `auth.${domainName}`;
const apiDomain = `api.${domainName}`;
const adminOrigin = `https://admin.${domainName}`;

const kidsAppsStack = new KidsAppsStack(app, "KidsAppsStack", {
  env: {
    account: "926274062211",
    region: "us-east-1", // CloudFront + ACM certs require us-east-1
  },
  domainName,
});

const authStack = new AuthStack(app, "AuthStack", {
  env: {
    account: "926274062211",
    region: "us-east-1",
  },
  hostedZone: kidsAppsStack.hostedZone,
  certificate: kidsAppsStack.certificate,
  domainName,
  authDomain,
  adminOrigin,
});

new ApiStack(app, "ApiStack", {
  env: {
    account: "926274062211",
    region: "us-east-1",
  },
  hostedZone: kidsAppsStack.hostedZone,
  certificate: kidsAppsStack.certificate,
  domainName,
  apiDomain,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  configBucket: kidsAppsStack.bucket,
  distribution: kidsAppsStack.distribution,
});

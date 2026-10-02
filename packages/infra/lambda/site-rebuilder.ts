/**
 * Site-rebuilder Lambda — triggered by SQS.
 *
 * Child pages are now a single SPA that loads config from the kid API,
 * so this no longer regenerates per-child HTML/config.json. It invalidates
 * CloudFront so newly fetched icons (and SPA deploys) show up promptly.
 *
 * iPad profiles are generated on demand by GET /kid/profile.
 */

import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

const cloudfront = new CloudFrontClient({});
const DISTRIBUTION_ID = process.env.DISTRIBUTION_ID!;

interface SQSRecord {
  body: string;
}

interface SQSEvent {
  Records?: SQSRecord[];
}

export const handler = async (event: SQSEvent): Promise<void> => {
  console.log("CloudFront invalidation triggered", event.Records?.length ?? 0, "message(s)");

  await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: DISTRIBUTION_ID,
    InvalidationBatch: {
      CallerReference: `rebuild-${Date.now()}`,
      Paths: { Quantity: 1, Items: ["/*"] },
    },
  }));

  console.log("CloudFront invalidated");
};

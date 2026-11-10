import "dotenv/config";
import {
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";

/**
 * Applies the production S3 configuration the app depends on:
 *
 * - private bucket (all public-access blocks on, ACLs disabled)
 * - SSE-S3 default encryption and versioning
 * - CORS for direct browser uploads via presigned PUT
 * - lifecycle rules for incomplete multipart uploads and DB backup copies
 * - TLS-only bucket policy
 *
 * Dry-run by default: prints the exact configuration without calling AWS.
 * Apply with `npm run s3:configure -- --apply` from a trusted operator
 * environment that already holds credentials for the bucket.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function allowedOrigins(): string[] {
  const raw =
    process.env.CORS_ALLOWED_ORIGINS?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    "http://localhost:3000";
  const origins = raw.split(",").map((value) => {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`CORS origin must be http(s): ${value}`);
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function bucketPolicy(bucket: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  };
}

function lifecycleRules(): LifecycleRule[] {
  return [
    {
      ID: "abort-incomplete-multipart-uploads",
      Status: "Enabled",
      Filter: { Prefix: "" },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    },
    {
      ID: "expire-database-backup-copies",
      Status: "Enabled",
      Filter: { Prefix: "backups/" },
      Expiration: { Days: 35 },
    },
    {
      ID: "retain-noncurrent-versions",
      Status: "Enabled",
      Filter: { Prefix: "" },
      NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    },
  ];
}

async function main() {
  const bucket = required("S3_BUCKET_NAME");
  const region = required("AWS_REGION");
  const origins = allowedOrigins();
  const apply = process.argv.includes("--apply");

  const policy = bucketPolicy(bucket);
  const publicAccessBlock = {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  };
  const cors = {
    CORSRules: [
      {
        AllowedOrigins: origins,
        AllowedMethods: ["GET", "PUT", "HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      },
    ],
  };
  const lifecycle = lifecycleRules();

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        bucket,
        region,
        publicAccessBlock,
        ownershipControls: { ObjectOwnership: "BucketOwnerEnforced" },
        encryption: { SSEAlgorithm: "AES256" },
        versioning: "Enabled",
        cors,
        lifecycle,
        policy,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log(
      "\nDry run only. Re-run with --apply to update the bucket (requires AWS credentials)."
    );
    return;
  }

  const client = new S3Client({ region });
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      "public access block",
      () =>
        client.send(
          new PutPublicAccessBlockCommand({
            Bucket: bucket,
            PublicAccessBlockConfiguration: publicAccessBlock,
          })
        ),
    ],
    [
      "ownership controls",
      () =>
        client.send(
          new PutBucketOwnershipControlsCommand({
            Bucket: bucket,
            OwnershipControls: {
              Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
            },
          })
        ),
    ],
    [
      "default encryption",
      () =>
        client.send(
          new PutBucketEncryptionCommand({
            Bucket: bucket,
            ServerSideEncryptionConfiguration: {
              Rules: [
                {
                  ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
                },
              ],
            },
          })
        ),
    ],
    [
      "versioning",
      () =>
        client.send(
          new PutBucketVersioningCommand({
            Bucket: bucket,
            VersioningConfiguration: { Status: "Enabled" },
          })
        ),
    ],
    [
      "CORS",
      () =>
        client.send(
          new PutBucketCorsCommand({
            Bucket: bucket,
            CORSConfiguration: cors,
          })
        ),
    ],
    [
      "lifecycle",
      () =>
        client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: { Rules: lifecycle },
          })
        ),
    ],
    [
      "bucket policy",
      () =>
        client.send(
          new PutBucketPolicyCommand({
            Bucket: bucket,
            Policy: JSON.stringify(policy),
          })
        ),
    ],
  ];

  for (const [name, run] of steps) {
    await run();
    console.log(`applied: ${name}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

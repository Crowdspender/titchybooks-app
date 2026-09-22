import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const prisma = new PrismaClient();

async function main() {
  const ids = ["cmpz8e7p20001mqsbz6liz0rg", "cmpz8lbpt002dmqsbrdvnpk8k"];

  const s3 = new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  const bucket = process.env.S3_BUCKET_NAME;
  console.log("Bucket:", bucket ?? "NOT SET");
  console.log("Region:", process.env.AWS_REGION ?? "NOT SET");
  console.log("Access key:", process.env.AWS_ACCESS_KEY_ID ? "SET" : "NOT SET");

  for (const id of ids) {
    console.log(`\n--- ${id} ---`);
    try {
      const asset = await prisma.asset.findUnique({ where: { id } });
      if (!asset) {
        console.log("Asset NOT FOUND in DB");
        continue;
      }
      console.log("DB record:", { userId: asset.userId, s3Key: asset.s3Key, mimeType: asset.mimeType });
      
      try {
        const head = await s3.send(new HeadObjectCommand({
          Bucket: bucket!,
          Key: asset.s3Key,
        }));
        console.log("S3 object EXISTS, size:", head.ContentLength, "bytes");
      } catch (e: any) {
        console.error("S3 HEAD failed:", e.name, e.message, e.$metadata?.httpStatusCode);
      }
    } catch (e: any) {
      console.error("DB query failed:", e.message);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

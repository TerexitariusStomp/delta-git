import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

// Mint presigned R2 PUT URLs so the browser uploads artifacts directly —
// zero Worker CPU per byte.
export function r2Client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    service: "s3",
    region: "auto",
  });
}

export async function presignPut(env: Env, key: string): Promise<string> {
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", "3600");
  const signed = await r2Client(env).sign(url.toString(), { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

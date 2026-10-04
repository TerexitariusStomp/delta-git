export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  SITE_HOST_SUFFIX: string;
  USDC_CHAIN: string;
  USDC_CONTRACT: string;
  USDC_RPC: string;
  USDC_CONFIRMATIONS: string;
  // secrets (wrangler secret put)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;   // for presigned PUTs (S3 API)
  R2_ACCOUNT_ID?: string;
  USDC_DEPOSIT_ADDRESS?: string; // omnibus address receiving top-ups
  SESSION_SECRET?: string;
}

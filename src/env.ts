export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  ASSETS?: Fetcher;
  SITE_HOST_SUFFIX: string;
  USDC_CHAIN: string;
  USDC_CONTRACT: string;
  USDC_RPC: string;
  USDC_CONFIRMATIONS: string;
  // secrets (wrangler secret put)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  USDC_DEPOSIT_ADDRESS?: string;
  SESSION_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  // paid-tier bindings (env.paid)
  TENANT?: DurableObjectNamespace;
  PROVISION?: Queue;
  MAIL?: SendEmail;
  AI?: Ai;
}

export interface MessageBatch<T> { messages: { body: T; ack(): void; retry(o?: { delaySeconds?: number }): void }[] }

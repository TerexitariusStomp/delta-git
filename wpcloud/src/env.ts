export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  ASSETS?: Fetcher;
  SITE_HOST_SUFFIX: string;
  APP_HOST?: string;            // e.g. wpcloud.delta-git.workers.dev — serves the app SPA + /preview/{id}/*
  FORGE_URL?: string;           // delta-git base origin for deploy-git archive fetches
  FORGE?: Fetcher;              // service binding to git-on-cloudflare — workers.dev subrequests to
                                // workers.dev hosts are blocked (error 1042), so the binding is the
                                // only way to reach the forge from this worker
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
  // visitor-compute network (localchimera coordinator)
  COORDINATOR_URL?: string;
  DISPATCH_AUTH_TOKEN?: string;
  // delta-git integration
  DG_SESSION_SECRET?: string;   // shared with the forge — verifies dg_token sign-in handoffs
  DEPLOY_HOOK_SECRET?: string;  // verifies delta-git webhook signatures (svix v1 scheme)
  FORGE_PAT?: string;           // optional basic-auth token for private repo archive fetches
  // paid-tier bindings (env.paid)
  TENANT?: DurableObjectNamespace;
  PROVISION?: Queue;
  MAIL?: SendEmail;
  AI?: Ai;
}

export interface MessageBatch<T> { messages: { body: T; ack(): void; retry(o?: { delaySeconds?: number }): void }[] }

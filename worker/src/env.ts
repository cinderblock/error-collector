export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  BLOBS: R2Bucket;
  /** Error/feedback reports. One data point per report; see storage/reports.ts. */
  AE: AnalyticsEngineDataset;
  /**
   * Usage events. A *separate* dataset, not a discriminator column in the one
   * above: AE has no column names, only blob1..blob20, so two record shapes sharing
   * a dataset means every query has to remember to exclude the other shape — and
   * the failure mode when one forgets is silently blended numbers rather than an
   * error. Datasets are implicit and free, so there is no reason to share.
   */
  USAGE: AnalyticsEngineDataset;

  INGEST_LIMIT: RateLimit;
  AUTH_LIMIT: RateLimit;

  // vars
  RP_NAME: string;
  // No RP_ID or ORIGIN: the WebAuthn relying party is derived from the request URL
  // (see auth/webauthn.ts), which is correct on whatever hostname this is deployed
  // to and makes localhost development work with no configuration.
  OWNER_ID: string;
  OWNER_NAME: string;
  AE_DATASET: string;
  USAGE_DATASET: string;

  // secrets
  AUTH_SECRET?: string;
  SECRET_KEK?: string;
  BOOTSTRAP_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;

  // set in .dev.vars only; honored on localhost
  DEV_MODE?: string;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** UTC day key, matching how Cloudflare's own daily limits reset. */
export function dayKey(seconds: number = nowSeconds()): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

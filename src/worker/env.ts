import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  readonly DB: D1Database;
  readonly PHOTOS: R2Bucket;
  readonly IMAGES: ImagesBinding;
  readonly OAUTH_KV: KVNamespace;
  readonly ASSETS: Fetcher;
  /** Injected by the OAuth provider on every request it passes through. */
  readonly OAUTH_PROVIDER: OAuthHelpers;

  /** Used for the vision pass at upload and for composing outfits from the PWA. */
  readonly ANTHROPIC_API_KEY: string;
  /** Single-user gate. Same password for the PWA and the connector login. */
  readonly APP_PASSWORD: string;
  /** Signs the session cookie. */
  readonly SESSION_SECRET: string;
}

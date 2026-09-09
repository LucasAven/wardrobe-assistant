import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Env } from './env';

const COOKIE = 'wardrobe_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

/** Spelled the way `wrangler secret put` spells them, because the message says to run it. */
export type SecretName = 'APP_PASSWORD' | 'SESSION_SECRET' | 'ANTHROPIC_API_KEY';

export interface ConfigFault {
  readonly error: string;
  readonly missing: readonly SecretName[];
}

function nameList(names: readonly SecretName[]): string {
  const last = names[names.length - 1];
  if (last === undefined) return '';
  if (names.length === 1) return last;
  return `${names.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * Every name a handler needs is checked in one pass and reported together. An
 * operator who is told one name per deploy spends the afternoon finding the
 * next one.
 */
export function missingConfig(env: Env, needed: readonly SecretName[]): ConfigFault | null {
  const missing = needed.filter((name) => {
    const value: unknown = env[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length === 0) return null;

  const commands = missing.map((name) => `npx wrangler secret put ${name}`).join(', then ');
  const verb = missing.length === 1 ? 'is' : 'are';
  return {
    error: `${nameList(missing)} ${verb} not set on this Worker. Run: ${commands}`,
    missing,
  };
}

/**
 * Both names, on the guard as well as on login. A cookie only ever comes from a
 * login that reads the password, so a deployment missing one of the two cannot
 * let anybody in whatever the other one holds.
 */
const PASSWORD_GATE = ['APP_PASSWORD', 'SESSION_SECRET'] as const satisfies readonly SecretName[];

async function sign(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

function base64url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * Both sides go through HMAC first, so the comparison runs over two 32 byte
 * digests and leaks neither the password nor its length whatever the loop above
 * does with its time.
 */
async function passwordMatches(env: Env, candidate: string): Promise<boolean> {
  const [given, expected] = await Promise.all([
    sign(env.SESSION_SECRET, candidate),
    sign(env.SESSION_SECRET, env.APP_PASSWORD),
  ]);
  return equalBytes(new Uint8Array(given), new Uint8Array(expected));
}

async function issueToken(env: Env): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${expires}.${base64url(await sign(env.SESSION_SECRET, `session.${expires}`))}`;
}

export async function verifyToken(env: Env, token: string): Promise<boolean> {
  const split = token.indexOf('.');
  if (split < 0) return false;

  const expires = Number(token.slice(0, split));
  const signature = token.slice(split + 1);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;

  const expected = base64url(await sign(env.SESSION_SECRET, `session.${expires}`));
  return equalBytes(encoder.encode(expected), encoder.encode(signature));
}

const LoginSchema = z.object({ password: z.string() });

export async function login(c: Context<{ Bindings: Env }>): Promise<Response> {
  const fault = missingConfig(c.env, PASSWORD_GATE);
  if (fault !== null) return c.json(fault, 503);

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'password required' }, 400);
  if (!(await passwordMatches(c.env, parsed.data.password))) {
    return c.json({ error: 'wrong password' }, 401);
  }

  setCookie(c, COOKIE, await issueToken(c.env), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  return c.json({ ok: true });
}

export const requireSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const fault = missingConfig(c.env, PASSWORD_GATE);
  if (fault !== null) return c.json(fault, 503);

  const token = getCookie(c, COOKIE);
  if (token === undefined || !(await verifyToken(c.env, token))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

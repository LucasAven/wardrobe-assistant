import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Env } from './env';

const COOKIE = 'wardrobe_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

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
  const token = getCookie(c, COOKIE);
  if (token === undefined || !(await verifyToken(c.env, token))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

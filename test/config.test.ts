/**
 * What a Worker with no secrets set answers. The deployed one returned 500 with
 * the body `Internal Server Error` on every login, because the HMAC was handed
 * an undefined key, and an operator could not tell that apart from a broken app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import app from '../src/worker/index';

type Row = Record<string, unknown>;

/**
 * Serves the one insert the upload route runs. Every other statement throws, so
 * a guard that lets a request reach the database shows up as a failure here.
 */
class FakeDb {
  public readonly inserted: Row[] = [];

  prepare(sql: string) {
    const self = this;
    const make = (args: unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      first: async () => self.insert(sql, args),
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    });
    return make([]);
  }

  private insert(sql: string, args: unknown[]): Row {
    const columns = /INSERT INTO garment \(([^)]+)\)/.exec(sql)?.[1];
    if (columns === undefined) throw new Error(`unstubbed sql: ${sql}`);

    const row: Row = { archived: 0, created_at: '2026-09-08T09:00:00Z' };
    columns.split(', ').forEach((column, index) => {
      row[column] = args[index] ?? null;
    });
    this.inserted.push(row);
    return row;
  }
}

class FakePhotos {
  public readonly stored = new Map<string, unknown>();

  async put(key: string, body: unknown): Promise<void> {
    this.stored.set(key, body);
  }

  async get(key: string): Promise<{ body: unknown } | null> {
    const body = this.stored.get(key);
    return body === undefined ? null : { body };
  }
}

const IMAGES = {
  input: () => ({
    transform: () => ({
      output: () => ({ image: () => 'cut-bytes' }),
    }),
  }),
};

const ASSETS = {
  fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`),
};

const PASSWORD = 'pw';

let db: FakeDb;
let photos: FakePhotos;

function envWith(secrets: Record<string, string>): Record<string, unknown> {
  return { DB: db, PHOTOS: photos, IMAGES, ASSETS, ...secrets };
}

async function send(env: Record<string, unknown>, request: Request): Promise<Response> {
  return app.fetch(request, env as never);
}

function jsonRequest(method: string, url: string, body: unknown, cookie = ''): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function login(env: Record<string, unknown>, password: string): Promise<Response> {
  return send(env, jsonRequest('POST', 'http://x/api/login', { password }));
}

async function sessionCookie(env: Record<string, unknown>): Promise<string> {
  const response = await login(env, PASSWORD);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

beforeEach(() => {
  db = new FakeDb();
  photos = new FakePhotos();
  parseMock.mockReset();
});

describe('login on a Worker with no secrets', () => {
  it('answers 503 and names both missing secrets instead of throwing', async () => {
    const response = await login(envWith({}), PASSWORD);
    expect(response.status).toBe(503);

    const body = await bodyOf(response);
    expect(body.missing).toEqual(['APP_PASSWORD', 'SESSION_SECRET']);
    expect(body.error).toContain('APP_PASSWORD');
    expect(body.error).toContain('SESSION_SECRET');
    expect(body.error).toContain('npx wrangler secret put APP_PASSWORD');
    expect(body.error).toContain('npx wrangler secret put SESSION_SECRET');
  });

  it('names only the secret that is missing', async () => {
    const noSecret = await bodyOf(await login(envWith({ APP_PASSWORD: PASSWORD }), PASSWORD));
    expect(noSecret.missing).toEqual(['SESSION_SECRET']);
    expect(noSecret.error).toBe(
      'SESSION_SECRET is not set on this Worker. Run: npx wrangler secret put SESSION_SECRET',
    );

    const noPassword = await bodyOf(await login(envWith({ SESSION_SECRET: 's' }), PASSWORD));
    expect(noPassword.missing).toEqual(['APP_PASSWORD']);
    expect(noPassword.error).not.toContain('SESSION_SECRET');
  });

  it('reads an empty secret as unset, which is what a cleared value leaves behind', async () => {
    const response = await login(envWith({ APP_PASSWORD: PASSWORD, SESSION_SECRET: '  ' }), PASSWORD);
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).missing).toEqual(['SESSION_SECRET']);
  });
});

describe('login with both secrets set', () => {
  const configured = (): Record<string, unknown> =>
    envWith({ APP_PASSWORD: PASSWORD, SESSION_SECRET: 'secret' });

  it('still refuses a wrong password with 401', async () => {
    const response = await login(configured(), 'not the password');
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'wrong password' });
  });

  it('still lets the right password in', async () => {
    const response = await login(configured(), PASSWORD);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('wardrobe_session=');
  });

  it('still refuses a body with no password with 400', async () => {
    const response = await send(configured(), jsonRequest('POST', 'http://x/api/login', {}));
    expect(response.status).toBe(400);
  });
});

describe('the session guard', () => {
  it('says which secrets are missing rather than reporting the caller as unauthorized', async () => {
    const response = await send(envWith({}), new Request('http://x/api/garments'));
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).missing).toEqual(['APP_PASSWORD', 'SESSION_SECRET']);
  });
});

describe('routes that call the model with no ANTHROPIC_API_KEY', () => {
  const halfConfigured = (): Record<string, unknown> =>
    envWith({ APP_PASSWORD: PASSWORD, SESSION_SECRET: 'secret' });

  it('answers 503 on recommend and makes no model call', async () => {
    const env = halfConfigured();
    const cookie = await sessionCookie(env);

    const response = await send(
      env,
      jsonRequest(
        'POST',
        'http://x/api/recommend',
        { event: 'work', timeOfDay: 'morning', hoursOutdoors: 2, tempC: 15 },
        cookie,
      ),
    );

    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body.missing).toEqual(['ANTHROPIC_API_KEY']);
    expect(body.error).toBe(
      'ANTHROPIC_API_KEY is not set on this Worker. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    );
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('answers 503 on retag and leaves the stored tags alone', async () => {
    const env = halfConfigured();
    const cookie = await sessionCookie(env);

    const response = await send(
      env,
      new Request('http://x/api/garments/a1/retag', { method: 'POST', headers: { cookie } }),
    );

    expect(response.status).toBe(503);
    expect((await bodyOf(response)).missing).toEqual(['ANTHROPIC_API_KEY']);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('keeps the photo on upload and says the key is why the row came back untagged', async () => {
    const env = halfConfigured();
    const cookie = await sessionCookie(env);

    const response = await send(
      env,
      new Request('http://x/api/garments', {
        method: 'POST',
        headers: { cookie, 'content-type': 'image/jpeg' },
        body: new Uint8Array([1, 2, 3]),
      }),
    );

    expect(response.status).toBe(201);
    const row = await bodyOf(response);
    expect(row.id).toEqual(expect.any(String));
    expect(photos.stored.has(String(row.imageOriginal))).toBe(true);
    expect(db.inserted).toHaveLength(1);

    expect(row.missing).toEqual(['ANTHROPIC_API_KEY']);
    expect(row.taggingError).toContain('ANTHROPIC_API_KEY is not set on this Worker');
    expect(row.taggingError).toContain('npx wrangler secret put ANTHROPIC_API_KEY');
    expect(row.reviewed).toBe(false);
    expect(parseMock).not.toHaveBeenCalled();
  });
});

describe('the app itself with no secrets at all', () => {
  it('still serves the login page and the static files', async () => {
    for (const path of ['http://x/', 'http://x/style.css', 'http://x/lib/api.js']) {
      const response = await send(envWith({}), new Request(path));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`asset ${new URL(path).pathname}`);
    }
  });
});

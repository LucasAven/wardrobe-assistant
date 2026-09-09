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
import { blankDraft } from '../src/worker/vision';

type Row = Record<string, unknown>;

/**
 * Serves the insert the upload route runs and the read retag does. Every other
 * statement throws, so a guard that lets a request reach the database shows up
 * as a failure here.
 */
class FakeDb {
  public readonly inserted: Row[] = [];

  prepare(sql: string) {
    const self = this;
    const make = (args: unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      first: async () => self.serve(sql, args),
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    });
    return make([]);
  }

  private serve(sql: string, args: unknown[]): Row | null {
    if (sql.startsWith('SELECT * FROM garment WHERE id = ?')) {
      return this.inserted.find((row) => row.id === args[0]) ?? null;
    }

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

type Transform = Record<string, unknown>;

/** The shape both photo paths call: `input().transform().output()`. */
function imagesThat(fails: (transform: Transform) => Error | null): unknown {
  return {
    input: () => ({
      transform: (options: Transform) => ({
        output: async () => {
          const error = fails(options);
          if (error !== null) throw error;
          return { image: () => 'image-bytes' };
        },
      }),
    }),
  };
}

const IMAGES = imagesThat(() => null);

/** What one unreadable photo gets: an `ImagesError`, carrying the code for it. */
const notAnImage = (): Error =>
  Object.assign(new Error('ERROR 9412: the input was not an image'), {
    name: 'ImagesError',
    code: 9412,
  });

/** An account that never turned Images on, which the docs give no code for. */
const imagesOff = (): Error => new Error('Images is not enabled for this account');

const segments = (transform: Transform): boolean => 'segment' in transform;

/** A model answer inside the vocabulary, so a tagged row is visibly tagged. */
const MODEL_ANSWER = {
  ...blankDraft(),
  slot: 'base',
  subtype: 'oxford shirt',
  colors: ['light blue'],
  seasons: ['autumn'],
  uncertain: [],
};

const ASSETS = {
  fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`),
};

const PASSWORD = 'pw';

let db: FakeDb;
let photos: FakePhotos;

function envWith(
  secrets: Record<string, string>,
  images: unknown = IMAGES,
): Record<string, unknown> {
  return { DB: db, PHOTOS: photos, IMAGES: images, ASSETS, ...secrets };
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

/** Every secret set, so the only thing left to go wrong is the photo path. */
function fullyConfigured(images: unknown = IMAGES): Record<string, unknown> {
  return envWith(
    { APP_PASSWORD: PASSWORD, SESSION_SECRET: 'secret', ANTHROPIC_API_KEY: 'key' },
    images,
  );
}

async function upload(env: Record<string, unknown>, cookie: string): Promise<Response> {
  return send(
    env,
    new Request('http://x/api/garments', {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3]),
    }),
  );
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

    const response = await upload(env, cookie);

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

/**
 * Images is the one product `wrangler` cannot switch on, so a deploy that looks
 * finished can still have it off. Every photo then comes back uncut and untagged,
 * which is what a model that cannot cope with the clothes looks like too.
 */
describe('uploads on an account where Images was never turned on', () => {
  it('keeps the photo, answers 201, and names the switch the CLI cannot flip', async () => {
    const env = fullyConfigured(imagesThat(imagesOff));
    const cookie = await sessionCookie(env);

    const response = await upload(env, cookie);
    expect(response.status).toBe(201);

    const row = await bodyOf(response);
    expect(photos.stored.has(String(row.imageOriginal))).toBe(true);
    expect(row.imageCutout).toBeNull();
    expect(row.needsSetup).toBe('cloudflare-images');
    expect(row.imagesError).toContain('Cloudflare Images is not enabled');
    expect(row.imagesError).toContain('Cloudflare dashboard');
    expect(row.imagesError).toContain('The CLI cannot do it');
  });

  it('lays the blank tags at that same switch instead of reporting a second failure', async () => {
    const env = fullyConfigured(imagesThat(imagesOff));
    const cookie = await sessionCookie(env);

    const row = await bodyOf(await upload(env, cookie));

    expect(row.subtype).toBe('untagged item');
    expect(row.taggingError).toBeUndefined();
    expect(Object.keys(row).filter((key) => key.endsWith('Error'))).toEqual(['imagesError']);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('reads a Worker with no Images binding at all the same way', async () => {
    const env = fullyConfigured();
    delete env.IMAGES;
    const cookie = await sessionCookie(env);

    const row = await bodyOf(await upload(env, cookie));

    expect(photos.stored.has(String(row.imageOriginal))).toBe(true);
    expect(row.needsSetup).toBe('cloudflare-images');
  });

  it('answers a later retag with the setting rather than a failed model call', async () => {
    const working = fullyConfigured();
    const cookie = await sessionCookie(working);
    parseMock.mockResolvedValue({ parsed_output: MODEL_ANSWER, stop_reason: 'end_turn' });
    const uploaded = await bodyOf(await upload(working, cookie));

    const response = await send(
      fullyConfigured(imagesThat(imagesOff)),
      new Request(`http://x/api/garments/${String(uploaded.id)}/retag`, {
        method: 'POST',
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body.needsSetup).toBe('cloudflare-images');
    expect(body.error).toContain('Cloudflare dashboard');
  });
});

describe('a photo Images could not segment', () => {
  it('keeps the original, tags it as usual, and says nothing about the account', async () => {
    const env = fullyConfigured(
      imagesThat((transform) => (segments(transform) ? notAnImage() : null)),
    );
    const cookie = await sessionCookie(env);
    parseMock.mockResolvedValue({ parsed_output: MODEL_ANSWER, stop_reason: 'end_turn' });

    const response = await upload(env, cookie);
    expect(response.status).toBe(201);

    const row = await bodyOf(response);
    expect(photos.stored.has(String(row.imageOriginal))).toBe(true);
    expect(row.imageCutout).toBeNull();
    expect(row.subtype).toBe('oxford shirt');
    expect(row.imagesError).toBeUndefined();
    expect(row.needsSetup).toBeUndefined();
  });
});

describe('an upload with Images working', () => {
  it('adds nothing to the row', async () => {
    const env = fullyConfigured();
    const cookie = await sessionCookie(env);
    parseMock.mockResolvedValue({ parsed_output: MODEL_ANSWER, stop_reason: 'end_turn' });

    const row = await bodyOf(await upload(env, cookie));

    expect(row.imageCutout).toBe(`cut/${String(row.id)}.png`);
    expect(row.subtype).toBe('oxford shirt');
    expect(Object.keys(row).filter((key) => key.endsWith('Error'))).toEqual([]);
    expect(row.needsSetup).toBeUndefined();
    expect(row.missing).toBeUndefined();
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

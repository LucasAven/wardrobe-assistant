import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, AuthError, NetworkError, createApi } from '../public/lib/api.js';
import { createLimiter } from '../public/lib/limiter.js';
import { normalizeForUpload, normalizedType, targetSize } from '../public/lib/normalize.js';
import { buildPatch, confirmPatch, formatColors, parseColors } from '../public/lib/patch.js';
import { imagePath, uploadContentType } from '../public/lib/photo.js';
import { parseRoute, routeHash } from '../public/lib/router.js';
import { FIELDS, isRelevant, relevantFields } from '../public/lib/vocab.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every column src/worker/repo.ts accepts in a PATCH. */
const PATCHABLE = [
  'slot',
  'subtype',
  'colors',
  'colorRole',
  'pattern',
  'fabric',
  'warmth',
  'formality',
  'fit',
  'structured',
  'rise',
  'leg',
  'hem',
  'neckline',
  'sleeves',
  'shoulderBulk',
  'waterResistant',
  'seasons',
  'notes',
  'uncertain',
];

/** Mirrors ACCEPTED_UPLOAD_TYPES in src/worker/photos.ts. */
const WORKER_ACCEPTS = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/heic', 'image/heif'];

const GARMENT = {
  id: 'a1',
  slot: 'base',
  subtype: 'oxford shirt',
  imageOriginal: 'orig/a1',
  imageCutout: 'cut/a1.png',
  colors: ['navy', 'off white'],
  colorRole: 'neutral',
  pattern: 'stripe',
  fabric: 'cotton',
  warmth: 2,
  formality: 4,
  fit: 'regular',
  structured: true,
  rise: null,
  leg: null,
  hem: 'past_waist',
  neckline: 'open',
  sleeves: 'long',
  shoulderBulk: false,
  waterResistant: false,
  seasons: ['spring', 'autumn'],
  notes: null,
  reviewed: false,
  uncertain: ['warmth', 'fabric'],
  archived: false,
  createdAt: '2026-09-01 10:00:00',
};

test('limiter holds at three in flight and finishes every task when one rejects', async () => {
  const limiter = createLimiter(3);
  let live = 0;
  let peak = 0;

  const settled = await Promise.allSettled(
    Array.from({ length: 12 }, (unused, index) =>
      limiter.run(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep(4 + (index % 3) * 3);
        live -= 1;
        if (index === 4) throw new Error('upload failed');
        return index;
      }),
    ),
  );

  assert.equal(peak, 3, 'three tasks should run together');
  assert.ok(peak <= 3, 'never more than three in flight');
  assert.equal(live, 0);
  assert.equal(settled.length, 12, 'every task settles');
  assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(settled[4].status, 'rejected');
  assert.equal(settled[4].reason.message, 'upload failed');
  assert.deepEqual(
    settled.filter((result) => result.status === 'fulfilled').map((result) => result.value),
    [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11],
    'the tasks queued behind the failure still run',
  );
});

test('limiter survives a task that throws before returning a promise', async () => {
  const limiter = createLimiter(3);
  const settled = await Promise.allSettled([
    limiter.run(() => {
      throw new Error('sync boom');
    }),
    limiter.run(() => 'after'),
  ]);

  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].value, 'after');
});

test('limiter refuses a limit that is not a positive integer', () => {
  assert.throws(() => createLimiter(0), RangeError);
  assert.throws(() => createLimiter(2.5), RangeError);
});

test('relevant fields follow the slot', () => {
  const common = [
    'slot',
    'subtype',
    'warmth',
    'formality',
    'colors',
    'colorRole',
    'pattern',
    'fabric',
    'fit',
    'structured',
    'shoulderBulk',
    'waterResistant',
    'seasons',
    'notes',
  ];

  assert.deepEqual(relevantFields('bottom'), [
    'slot',
    'subtype',
    'warmth',
    'formality',
    'colors',
    'colorRole',
    'pattern',
    'fabric',
    'fit',
    'structured',
    'rise',
    'leg',
    'shoulderBulk',
    'waterResistant',
    'seasons',
    'notes',
  ]);

  assert.deepEqual(relevantFields('top'), [
    'slot',
    'subtype',
    'warmth',
    'formality',
    'colors',
    'colorRole',
    'pattern',
    'fabric',
    'fit',
    'structured',
    'neckline',
    'sleeves',
    'hem',
    'shoulderBulk',
    'waterResistant',
    'seasons',
    'notes',
  ]);

  assert.deepEqual(relevantFields('shoes'), common, 'shoes get neither group');
  assert.deepEqual(relevantFields('accessory'), common);

  for (const slot of ['base', 'top', 'mid', 'outer']) {
    assert.ok(isRelevant('neckline', slot), `${slot} is a top`);
    assert.ok(!isRelevant('rise', slot));
  }
  assert.ok(!isRelevant('hem', 'bottom'));
  assert.ok(isRelevant('leg', 'bottom'));
});

test('every editable field is a column the PATCH handler accepts', () => {
  for (const field of FIELDS) {
    assert.ok(PATCHABLE.includes(field.name), `${field.name} is patchable`);
  }
  const editable = new Set(FIELDS.map((field) => field.name));
  assert.deepEqual(
    PATCHABLE.filter((name) => !editable.has(name)),
    ['uncertain'],
    'uncertain is the only patchable field the user does not edit by hand',
  );
});

test('patch carries only what changed', () => {
  assert.deepEqual(buildPatch(GARMENT, { ...GARMENT }), {});
  assert.deepEqual(buildPatch(GARMENT, { ...GARMENT, warmth: 4 }), { warmth: 4 });
  assert.deepEqual(buildPatch(GARMENT, { ...GARMENT, colors: ['navy', 'off white'] }), {}, 'equal arrays are equal');
  assert.deepEqual(buildPatch(GARMENT, { ...GARMENT, colors: ['navy'] }), { colors: ['navy'] });
});

test('patch nulls the fields the new slot cannot use', () => {
  assert.deepEqual(buildPatch(GARMENT, { ...GARMENT, slot: 'bottom', rise: 'mid', leg: 'straight' }), {
    slot: 'bottom',
    hem: null,
    neckline: null,
    sleeves: null,
    rise: 'mid',
    leg: 'straight',
  });

  assert.deepEqual(buildPatch(GARMENT, { ...GARMENT, slot: 'shoes' }), {
    slot: 'shoes',
    hem: null,
    neckline: null,
    sleeves: null,
  });
});

test('confirming an untouched garment still sends something to review it', () => {
  assert.deepEqual(confirmPatch({}), { uncertain: [] });
  assert.deepEqual(confirmPatch({ warmth: 3 }), { warmth: 3 });
});

test('colors round trip through the text control', () => {
  assert.deepEqual(parseColors('navy, Off White ,, olive'), ['navy', 'off white', 'olive']);
  assert.deepEqual(parseColors('   '), []);
  assert.equal(formatColors(['navy', 'off white']), 'navy, off white');
});

test('image paths point at the worker route', () => {
  assert.equal(imagePath(GARMENT), '/img/cut/a1');
  assert.equal(imagePath({ ...GARMENT, imageCutout: null }), '/img/orig/a1');
});

test('upload content type falls back to the file name', () => {
  assert.equal(uploadContentType({ name: 'a.jpg', type: 'image/jpeg' }), 'image/jpeg');
  assert.equal(uploadContentType({ name: 'a.jpg', type: 'image/jpeg; charset=binary' }), 'image/jpeg');
  assert.equal(uploadContentType({ name: 'IMG_0001.HEIC', type: '' }), 'image/heic');
  assert.equal(uploadContentType({ name: 'notes.txt', type: 'text/plain' }), null);
  assert.equal(uploadContentType({ name: 'photo', type: '' }), null);
});

test('a phone photo is capped on its long edge and a small one is left alone', () => {
  assert.deepEqual(targetSize(4032, 3024), { width: 2048, height: 1536 }, 'landscape 12MP');
  assert.deepEqual(targetSize(3024, 4032), { width: 1536, height: 2048 }, 'portrait 12MP');
  assert.deepEqual(targetSize(1000, 800), { width: 1000, height: 800 }, 'a small photo is never upscaled');
  assert.deepEqual(targetSize(2048, 2048), { width: 2048, height: 2048 }, 'exactly at the cap is untouched');
  assert.deepEqual(targetSize(4096, 4096), { width: 2048, height: 2048 });
});

test('the cutout box picks the format that keeps transparency', () => {
  assert.equal(normalizedType(false), 'image/jpeg');
  assert.equal(normalizedType(true), 'image/png', 'a lifted cutout has alpha and JPEG would flatten it');
});

test('the normalized blob goes up as a type the worker accepts', () => {
  for (const alreadyCutOut of [false, true]) {
    const type = normalizedType(alreadyCutOut);
    assert.ok(WORKER_ACCEPTS.includes(type), `${type} is an accepted upload type`);
    assert.equal(uploadContentType({ type }), type, 'a blob carries no name, so the type has to stand alone');
  }
});

test('normalization that cannot run hands back the file untouched', async () => {
  const file = { name: 'IMG_0001.HEIC', type: 'image/heic' };
  assert.deepEqual(await normalizeForUpload(file, { cutout: false }), { body: file, normalized: false });
  assert.deepEqual(await normalizeForUpload(file, { cutout: true }), { body: file, normalized: false });
  assert.equal(uploadContentType(file), 'image/heic', 'the fallback still uploads as it does today');
});

test('routes parse and build', () => {
  assert.deepEqual(parseRoute('#/upload'), { name: 'upload', id: null });
  assert.deepEqual(parseRoute('#/review/a1'), { name: 'review', id: 'a1' });
  assert.deepEqual(parseRoute(''), { name: 'wardrobe', id: null });
  assert.deepEqual(parseRoute('#/nope'), { name: 'wardrobe', id: null });
  assert.equal(routeHash('review', 'a 1'), '#/review/a%201');
});

function fakeResponse(status, body, { json = true } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (!json) throw new SyntaxError('not json');
      return body;
    },
  };
}

test('a 401 logs back in once and replays the request', async () => {
  const calls = [];
  let logins = 0;
  const api = createApi({
    fetchImpl: async (path, init) => {
      calls.push({ path, method: init.method ?? 'GET' });
      return calls.length === 1 ? fakeResponse(401, { error: 'unauthorized' }) : fakeResponse(200, []);
    },
    onUnauthorized: async () => {
      logins += 1;
    },
  });

  assert.deepEqual(await api.listGarments(), []);
  assert.equal(logins, 1);
  assert.equal(calls.length, 2, 'the request runs again after the login');
});

test('one login covers a whole batch of 401s', async () => {
  let logins = 0;
  let served = 0;
  const api = createApi({
    fetchImpl: async () => {
      served += 1;
      return served <= 3 ? fakeResponse(401, { error: 'unauthorized' }) : fakeResponse(201, { id: 'x' });
    },
    onUnauthorized: async () => {
      logins += 1;
      await sleep(5);
    },
  });

  const file = { name: 'a.jpg', type: 'image/jpeg' };
  const results = await Promise.all([
    api.uploadGarment(file),
    api.uploadGarment(file),
    api.uploadGarment(file),
  ]);

  assert.equal(logins, 1, 'fifty expired uploads must not open fifty logins');
  assert.deepEqual(results, [{ id: 'x' }, { id: 'x' }, { id: 'x' }]);
});

test('a second 401 gives up instead of looping', async () => {
  let logins = 0;
  const api = createApi({
    fetchImpl: async () => fakeResponse(401, { error: 'unauthorized' }),
    onUnauthorized: async () => {
      logins += 1;
    },
  });

  await assert.rejects(() => api.listGarments(), AuthError);
  assert.equal(logins, 1);
});

test('a dropped request reads as a network error, not a silent failure', async () => {
  const api = createApi({
    fetchImpl: async () => {
      throw new TypeError('Load failed');
    },
  });

  await assert.rejects(() => api.listGarments(), (error) => {
    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /No connection/);
    return true;
  });
});

test('a request that gives up on time says so', async () => {
  const api = createApi({
    fetchImpl: async () => {
      const error = new Error('signal timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });

  await assert.rejects(() => api.listGarments(), (error) => {
    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /took too long/);
    return true;
  });
});

test('the server error message reaches the user', async () => {
  const api = createApi({ fetchImpl: async () => fakeResponse(400, { error: 'patch is empty' }) });
  await assert.rejects(() => api.patchGarment('a1', {}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.message, 'patch is empty');
    return true;
  });
});

test('an error page with no JSON body still says something', async () => {
  const api = createApi({ fetchImpl: async () => fakeResponse(502, null, { json: false }) });
  await assert.rejects(() => api.retagGarment('a1'), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.message, 'The server answered 502.');
    return true;
  });
});

test('a wrong password does not reopen the login gate', async () => {
  let logins = 0;
  const api = createApi({
    fetchImpl: async () => fakeResponse(401, { error: 'wrong password' }),
    onUnauthorized: async () => {
      logins += 1;
    },
  });

  await assert.rejects(() => api.login('nope'), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.message, 'That password did not work.');
    return true;
  });
  assert.equal(logins, 0);
});

test('requests match the worker routes', async () => {
  const calls = [];
  const api = createApi({
    fetchImpl: async (path, init) => {
      calls.push({ path, method: init.method ?? 'GET', headers: init.headers, body: init.body });
      return fakeResponse(200, { ok: true });
    },
  });

  const file = { name: 'a.jpg', type: 'image/jpeg' };
  await api.listGarments();
  await api.listGarments({ reviewed: false });
  await api.uploadGarment(file);
  await api.uploadGarment(file, { cutout: true });
  await api.patchGarment('a 1', { warmth: 3 });
  await api.retagGarment('a1');
  await api.archiveGarment('a1');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'GET /api/garments',
      'GET /api/garments?reviewed=0',
      'POST /api/garments',
      'POST /api/garments?cutout=skip',
      'PATCH /api/garments/a%201',
      'POST /api/garments/a1/retag',
      'DELETE /api/garments/a1',
    ],
  );
  assert.equal(calls[2].headers['content-type'], 'image/jpeg', 'the image goes up as a raw body');
  assert.equal(calls[2].body, file);
  assert.equal(calls[4].body, '{"warmth":3}');
});

test('a file the worker would reject never leaves the phone', async () => {
  let served = 0;
  const api = createApi({
    fetchImpl: async () => {
      served += 1;
      return fakeResponse(201, {});
    },
  });

  await assert.rejects(() => api.uploadGarment({ name: 'clip.mov', type: 'video/quicktime' }), (error) => {
    assert.equal(error.status, 415);
    return true;
  });
  assert.equal(served, 0);
});

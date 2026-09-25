import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, AuthError, NetworkError, createApi } from '../client/lib/api.js';
import {
  BODY_TYPES,
  BODY_TYPE_BY_VALUE,
  MIRROR_QUESTIONS,
  OBSERVATION_NAMES,
  deriveBodyType,
  emptyObservations,
  isComplete,
  profileBody,
  readProfile,
  sameObservations,
  unanswered,
} from '../client/lib/body.js';
import {
  countTagStates,
  isUntagged,
  tagState,
  taggingPending,
  uploadStatus,
} from '../client/lib/garments.js';
import { askPosition, positionLine } from '../client/lib/geo.js';
import { createLimiter } from '../client/lib/limiter.js';
import { normalizeForUpload, normalizedType, targetSize } from '../client/lib/normalize.js';
import { CAUTION_WORDS, addableSlots, cautionsFor, pieceLabel } from '../client/lib/outfitcard.js';
import {
  NOTHING_SAVED,
  bookTally,
  garmentIds,
  groupBySet,
  wearEntry,
  orderPieces,
  outfitDay,
  readOutfit,
  readOutfits,
  savedClock,
  savedLine,
  splitRules,
  todayView,
} from '../client/lib/outfits.js';
import { buildPatch, confirmPatch, formatColors, parseColors } from '../client/lib/patch.js';
import { imagePath, retryPath, uploadContentType } from '../client/lib/photo.js';
import {
  canvasPoint,
  clampCrop,
  edgeDrag,
  isLasso,
  rotateCrop,
  rotatedSize,
  sourcePoint,
} from '../client/lib/photoedit.js';
import { forgetPref, readChoice, readPref, writePref } from '../client/lib/prefs.js';
import { parseRoute, routeHash } from '../client/lib/router.js';
import { FIELDS, isAsked, isRelevant, relevantFields } from '../client/lib/vocab.js';
import { readWeather, weatherLine } from '../client/lib/weather.js';

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
  'accessoryKind',
  'shoulderBulk',
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
  photoVersion: 2,
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
  accessoryKind: null,
  shoulderBulk: false,
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
    'seasons',
    'notes',
  ]);

  assert.deepEqual(relevantFields('shoes'), common, 'shoes get neither group');

  assert.deepEqual(relevantFields('accessory'), [
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
    'accessoryKind',
    'shoulderBulk',
    'seasons',
    'notes',
  ]);

  for (const slot of ['base', 'top', 'mid', 'outer']) {
    assert.ok(isRelevant('neckline', slot), `${slot} is a top`);
    assert.ok(!isRelevant('rise', slot));
    assert.ok(!isRelevant('accessoryKind', slot));
  }
  assert.ok(!isRelevant('hem', 'bottom'));
  assert.ok(isRelevant('leg', 'bottom'));
  assert.ok(!isRelevant('accessoryKind', 'shoes'), 'shoes are not an accessory');
  assert.ok(isRelevant('accessoryKind', 'accessory'));
});

test('a field the owner is never asked about keeps its value anyway', () => {
  // `structured` is read off the photo and the styling book's rules need it, so
  // the owner is not asked and the value still has to survive a confirm. It is
  // deliberately not done through `isRelevant`, which means the slot has no use
  // for the field, because `buildPatch` sends null for those.
  assert.ok(!isAsked('structured'), 'the review form does not draw it');
  assert.ok(isAsked('warmth'), 'everything else is still asked');
  assert.ok(
    FIELDS.some((field) => field.name === 'structured'),
    'it stays in FIELDS, which is where the untagged field list comes from',
  );
  assert.ok(isRelevant('structured', 'base'), 'relevant means the slot uses it, and it does');

  const garment = { ...GARMENT, structured: true };
  assert.deepEqual(
    buildPatch(garment, { ...garment, warmth: 4 }),
    { warmth: 4 },
    'confirming an untouched garment never writes the field away',
  );
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

test('image paths point at the worker route and carry the photo version', () => {
  assert.equal(imagePath(GARMENT), '/img/cut/a1?v=2');
  assert.equal(imagePath({ ...GARMENT, imageCutout: null }), '/img/orig/a1?v=2');
  assert.equal(imagePath({ ...GARMENT, photoVersion: 0 }), '/img/cut/a1?v=0', 'an unedited photo is still a version');
  assert.equal(
    imagePath({ ...GARMENT, photoVersion: undefined }),
    '/img/cut/a1',
    'a last resort: every garment the server sends carries a version, and a URL without one caches forever',
  );
});

test('retrying a failed photo keeps the version that makes it a new url', () => {
  assert.equal(retryPath('https://wardrobe.example/img/cut/a1?v=3', 1700), '/img/cut/a1?v=3&r=1700');
  assert.equal(retryPath('https://wardrobe.example/img/orig/a1', 1700), '/img/orig/a1?r=1700');
  assert.equal(
    retryPath('https://wardrobe.example/img/cut/a1?v=3&r=1', 1700),
    '/img/cut/a1?v=3&r=1700',
    'a second tap replaces its own parameter rather than stacking them',
  );
});

test('a pointer maps into the bitmap through the scale the canvas is shown at', () => {
  // A 2048px bitmap laid out 360px wide, 40px down the page.
  const rect = { left: 8, top: 40, width: 360, height: 480 };
  const size = { width: 2048, height: 2731 };

  assert.deepEqual(canvasPoint({ x: 8, y: 40 }, rect, size), { x: 0, y: 0 }, 'the top left corner');
  assert.deepEqual(canvasPoint({ x: 368, y: 520 }, rect, size), { x: 2048, y: 2731 }, 'the bottom right corner');
  assert.deepEqual(canvasPoint({ x: 188, y: 280 }, rect, size), { x: 1024, y: 1365.5 }, 'the middle');
  assert.notDeepEqual(
    canvasPoint({ x: 188, y: 280 }, rect, size),
    { x: 188, y: 280 },
    'reading the event coordinate straight off would erase somewhere else',
  );
});

test('a canvas shown at its own size maps one to one', () => {
  const rect = { left: 0, top: 0, width: 300, height: 200 };
  assert.deepEqual(canvasPoint({ x: 120, y: 90 }, rect, { width: 300, height: 200 }), { x: 120, y: 90 });
});

test('a stray tap encloses no area, so it is not a lasso', () => {
  const point = { x: 1, y: 1 };
  assert.equal(isLasso([]), false);
  assert.equal(isLasso([point]), false);
  assert.equal(isLasso([point, { x: 4, y: 9 }]), false, 'two points are a line, and a line erases nothing');
  assert.equal(isLasso([point, { x: 4, y: 9 }, { x: 7, y: 2 }]), true);
});

/** The transform the editor draws with, written out so the inverse has something to answer to. */
function drawnAt(point, quarterTurns, source, offset) {
  const turned = [
    { x: point.x, y: point.y },
    { x: source.height - point.y, y: point.x },
    { x: source.width - point.x, y: source.height - point.y },
    { x: point.y, y: source.width - point.x },
  ][quarterTurns];
  return { x: turned.x - offset.x, y: turned.y - offset.y };
}

const EDIT_SOURCE = { width: 300, height: 500 };

test('a turn swaps the axes, so a photo of trousers on their side stands up', () => {
  assert.deepEqual(rotatedSize(EDIT_SOURCE, 0), { width: 300, height: 500 });
  assert.deepEqual(rotatedSize(EDIT_SOURCE, 1), { width: 500, height: 300 });
  assert.deepEqual(rotatedSize(EDIT_SOURCE, 2), { width: 300, height: 500 });
  assert.deepEqual(rotatedSize(EDIT_SOURCE, 3), { width: 500, height: 300 });
});

test('one quarter turn is clockwise, and the turned photo fills its frame', () => {
  const none = { x: 0, y: 0 };
  const frame = rotatedSize(EDIT_SOURCE, 1);

  assert.deepEqual(drawnAt({ x: 0, y: 0 }, 1, EDIT_SOURCE, none), { x: 500, y: 0 }, 'top left goes to top right');
  assert.deepEqual(drawnAt({ x: 0, y: 500 }, 1, EDIT_SOURCE, none), { x: 0, y: 0 }, 'bottom left goes to top left');
  assert.deepEqual(drawnAt({ x: 300, y: 500 }, 1, EDIT_SOURCE, none), { x: 0, y: frame.height });
});

test('a lasso point read back off the canvas is the point it was drawn at, after any turn', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 300, y: 500 },
    { x: 41, y: 380 },
    { x: 150, y: 250 },
  ];

  for (const quarterTurns of [0, 1, 2, 3]) {
    for (const crop of [null, { x: 17, y: 23, w: 120, h: 140 }]) {
      for (const point of points) {
        const drawn = drawnAt(point, quarterTurns, EDIT_SOURCE, crop ?? { x: 0, y: 0 });
        assert.deepEqual(
          sourcePoint(drawn, { quarterTurns, crop }, EDIT_SOURCE),
          point,
          `turn ${quarterTurns} at ${point.x},${point.y}`,
        );
      }
    }
  }
});

test('a turn carries the crop with it rather than resetting it', () => {
  const bounds = { width: 100, height: 200 };
  const crop = { x: 10, y: 20, w: 30, h: 40 };

  assert.deepEqual(rotateCrop(crop, bounds, 1), { x: 140, y: 10, w: 40, h: 30 });
  assert.deepEqual(rotateCrop(crop, bounds, -1), { x: 20, y: 60, w: 40, h: 30 });
  assert.deepEqual(
    rotateCrop(rotateCrop(crop, bounds, 1), { width: 200, height: 100 }, -1),
    crop,
    'a turn and a turn back is the framing it started as',
  );
});

test('four turns the same way land back on the framing they started from', () => {
  const start = { x: 10, y: 20, w: 30, h: 40 };

  for (const direction of [1, -1]) {
    let crop = start;
    let bounds = { width: 100, height: 200 };
    for (let turn = 0; turn < 4; turn += 1) {
      crop = rotateCrop(crop, bounds, direction);
      bounds = rotatedSize(bounds, 1);
    }
    assert.deepEqual(crop, start, `four turns of ${direction}`);
    assert.deepEqual(bounds, { width: 100, height: 200 });
  }
});

test('dragging a handle moves that edge and leaves the other three alone', () => {
  const bounds = { width: 400, height: 600 };
  const crop = { x: 100, y: 150, w: 200, h: 300 };

  assert.deepEqual(edgeDrag(crop, 'top', 200, bounds, 32), { x: 100, y: 200, w: 200, h: 250 });
  assert.deepEqual(edgeDrag(crop, 'bottom', 500, bounds, 32), { x: 100, y: 150, w: 200, h: 350 });
  assert.deepEqual(edgeDrag(crop, 'left', 60, bounds, 32), { x: 60, y: 150, w: 240, h: 300 });
  assert.deepEqual(edgeDrag(crop, 'right', 380, bounds, 32), { x: 100, y: 150, w: 280, h: 300 });
});

test('a handle dragged across the crop stops at the smallest crop, on every edge', () => {
  const bounds = { width: 400, height: 600 };
  const crop = { x: 100, y: 150, w: 200, h: 300 };

  assert.deepEqual(edgeDrag(crop, 'top', 9000, bounds, 32), { x: 100, y: 418, w: 200, h: 32 });
  assert.deepEqual(edgeDrag(crop, 'bottom', -9000, bounds, 32), { x: 100, y: 150, w: 200, h: 32 });
  assert.deepEqual(edgeDrag(crop, 'left', 9000, bounds, 32), { x: 268, y: 150, w: 32, h: 300 });
  assert.deepEqual(edgeDrag(crop, 'right', -9000, bounds, 32), { x: 100, y: 150, w: 32, h: 300 });
});

test('a handle dragged off the photo stops at the edge of the photo, on every edge', () => {
  const bounds = { width: 400, height: 600 };
  const crop = { x: 100, y: 150, w: 200, h: 300 };

  assert.deepEqual(edgeDrag(crop, 'top', -80, bounds, 32), { x: 100, y: 0, w: 200, h: 450 });
  assert.deepEqual(edgeDrag(crop, 'bottom', 9000, bounds, 32), { x: 100, y: 150, w: 200, h: 450 });
  assert.deepEqual(edgeDrag(crop, 'left', -80, bounds, 32), { x: 0, y: 150, w: 300, h: 300 });
  assert.deepEqual(edgeDrag(crop, 'right', 9000, bounds, 32), { x: 100, y: 150, w: 300, h: 300 });
});

test('a crop that falls outside the photo is pulled back inside it', () => {
  const bounds = { width: 400, height: 600 };

  assert.deepEqual(clampCrop({ x: -50, y: -50, w: 200, h: 300 }, bounds, 32), { x: 0, y: 0, w: 200, h: 300 });
  assert.deepEqual(clampCrop({ x: 380, y: 590, w: 200, h: 300 }, bounds, 32), { x: 200, y: 300, w: 200, h: 300 });
  assert.deepEqual(clampCrop({ x: 0, y: 0, w: 9000, h: 9000 }, bounds, 32), { x: 0, y: 0, w: 400, h: 600 });
  assert.deepEqual(
    clampCrop({ x: 10, y: 10, w: 4, h: 4 }, bounds, 32),
    { x: 10, y: 10, w: 32, h: 32 },
    'a mis-drag can never collapse the crop to nothing',
  );
  assert.deepEqual(
    clampCrop({ x: 0, y: 0, w: 1, h: 1 }, { width: 20, height: 20 }, 32),
    { x: 0, y: 0, w: 20, h: 20 },
    'a photo smaller than the smallest crop is kept whole',
  );
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
  assert.deepEqual(parseRoute('#/edit/a1'), { name: 'edit', id: 'a1' });
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

// ---------------------------------------------------------------------------
// Profile, Today and Outfits
// ---------------------------------------------------------------------------

const MIRROR = {
  rectangle: { shouldersVsHips: 'equal', waistIsWidest: false, volume: 'even', line: 'straight', thinLegs: false },
  triangle: { shouldersVsHips: 'narrower', waistIsWidest: false, volume: 'bottom', line: 'curved', thinLegs: false },
  inverted_triangle: { shouldersVsHips: 'wider', waistIsWidest: false, volume: 'top', line: 'straight', thinLegs: true },
  circular: { shouldersVsHips: 'equal', waistIsWidest: true, volume: 'center', line: 'curved', thinLegs: false },
};

/** Every value the contract's BodyObservations allows. */
const OBSERVATION_VALUES = {
  shouldersVsHips: ['wider', 'narrower', 'equal'],
  waistIsWidest: [true, false],
  volume: ['top', 'bottom', 'center', 'even'],
  line: ['straight', 'curved'],
  thinLegs: [true, false],
};

test('the five mirror answers land on the book type they describe', () => {
  for (const [expected, answers] of Object.entries(MIRROR)) {
    assert.equal(deriveBodyType(answers), expected, `${expected} is what the book calls this silhouette`);
  }
});

test('the questions the app asks are the ones the contract carries', () => {
  assert.deepEqual(OBSERVATION_NAMES, ['shouldersVsHips', 'waistIsWidest', 'volume', 'line', 'thinLegs']);
  for (const question of MIRROR_QUESTIONS) {
    const allowed = OBSERVATION_VALUES[question.name].map(String);
    assert.deepEqual(
      question.options.map((option) => option.value),
      allowed,
      `${question.name} offers exactly the values the contract allows`,
    );
  }
});

test('the waist question outranks the rest, and thin legs never move the type', () => {
  for (const shouldersVsHips of OBSERVATION_VALUES.shouldersVsHips) {
    for (const volume of OBSERVATION_VALUES.volume) {
      assert.equal(
        deriveBodyType({ ...MIRROR.rectangle, waistIsWidest: true, shouldersVsHips, volume }),
        'circular',
        'the book asks about the waist to catch this one, before it compares anything else',
      );
    }
  }

  assert.equal(
    deriveBodyType({ ...MIRROR.triangle, volume: 'top' }),
    'triangle',
    'the shoulder to hip comparison beats volume when the two disagree',
  );
  assert.equal(deriveBodyType({ ...MIRROR.inverted_triangle, volume: 'center' }), 'inverted_triangle');

  for (const answers of Object.values(MIRROR)) {
    assert.equal(
      deriveBodyType({ ...answers, thinLegs: true }),
      deriveBodyType({ ...answers, thinLegs: false }),
      'the book uses thin legs to harden one rule, not to classify',
    );
  }
});

test('volume decides when the shoulders and hips read equal', () => {
  const equal = { shouldersVsHips: 'equal', waistIsWidest: false, line: 'straight', thinLegs: false };
  assert.equal(deriveBodyType({ ...equal, volume: 'top' }), 'inverted_triangle');
  assert.equal(deriveBodyType({ ...equal, volume: 'bottom' }), 'triangle');
  assert.equal(deriveBodyType({ ...equal, volume: 'center' }), 'circular');
  assert.equal(deriveBodyType({ ...equal, volume: 'even' }), 'rectangle');
});

test('an unfinished mirror walk has no type yet', () => {
  assert.equal(deriveBodyType(emptyObservations()), null);
  assert.equal(deriveBodyType({ ...MIRROR.rectangle, volume: null }), null);
  assert.deepEqual(unanswered({ ...MIRROR.rectangle, volume: null, line: null }), ['volume', 'line']);
  assert.deepEqual(unanswered(MIRROR.rectangle), []);
  assert.ok(isComplete(MIRROR.rectangle));
  assert.ok(!isComplete(emptyObservations()));
});

test('every body type the app can derive has the book description to show', () => {
  for (const value of Object.keys(MIRROR)) {
    const type = BODY_TYPE_BY_VALUE.get(value);
    assert.ok(type !== undefined, `${value} is offered`);
    assert.ok(type.description.length > 0, `${value} carries the book's own description`);
  }
  assert.equal(BODY_TYPES.length, 4, 'the book has four types and no more');
});

test('the stored type and the suggested one are read apart', () => {
  assert.deepEqual(readProfile({ profile: null, suggestedType: null }), {
    profile: null,
    suggestedType: null,
    home: null,
  });
  assert.deepEqual(readProfile(null), { profile: null, suggestedType: null, home: null });

  const stored = { ...MIRROR.rectangle, bodyType: 'circular', language: 'es' };
  const overridden = readProfile({ profile: stored, suggestedType: 'rectangle' });
  assert.equal(overridden.profile.bodyType, 'circular', 'the hand correction is what the app stores');
  assert.equal(overridden.suggestedType, 'rectangle', 'and the answers still say what they say');
  assert.notEqual(overridden.profile.bodyType, overridden.suggestedType, 'which is when the screen shows the note');

  const bare = readProfile(stored);
  assert.equal(bare.profile.bodyType, 'circular', 'a PUT answering with the profile alone still lands');
  assert.equal(bare.suggestedType, 'rectangle', 'and the suggestion is derived rather than shown as missing');
});

test('the home comes through as a pair of numbers, or as nothing at all', () => {
  const stored = { ...MIRROR.rectangle, bodyType: 'rectangle', language: 'en' };
  const home = { lat: -34.111222, lon: -56.333444 };

  assert.deepEqual(readProfile({ profile: stored, suggestedType: 'rectangle', home }).home, home, 'and never rounded');
  assert.equal(readProfile({ profile: stored, suggestedType: 'rectangle' }).home, null, 'a reply without one reads as none');
  assert.equal(readProfile({ profile: null, suggestedType: null, home: { lat: -34.111 } }).home, null, 'half a position is not one');
});

test('the profile PUT carries the observations, the type and the language', () => {
  assert.deepEqual(profileBody(MIRROR.triangle, 'rectangle', 'en'), {
    shouldersVsHips: 'narrower',
    waistIsWidest: false,
    volume: 'bottom',
    line: 'curved',
    thinLegs: false,
    bodyType: 'rectangle',
    language: 'en',
  });
});

test('answers count as unchanged only while all five match', () => {
  assert.ok(sameObservations(MIRROR.rectangle, { ...MIRROR.rectangle, bodyType: 'circular' }), 'the type is not an answer');
  assert.ok(!sameObservations(MIRROR.rectangle, { ...MIRROR.rectangle, thinLegs: true }));
  assert.ok(!sameObservations(MIRROR.rectangle, null));
});

test('a stored position is shown at about a hundred meters', () => {
  assert.equal(positionLine({ lat: -34.111222, lon: -56.333444 }), '-34.111, -56.333');
  assert.equal(positionLine({ lat: 0, lon: 10 }), '0.000, 10.000');
});

test('a browser that cannot give a position says so instead of hanging', async () => {
  assert.deepEqual(await askPosition(), { found: false, cause: 'unsupported' });
});

test('a weather read is only shown when all four numbers came back', () => {
  assert.deepEqual(readWeather({ tempC: 14, feelsLikeC: 12.4, precipProbability: 0.3, windKph: 9 }), {
    tempC: 14,
    feelsLikeC: 12.4,
    precipProbability: 0.3,
    windKph: 9,
  });
  assert.equal(readWeather({ tempC: 14, feelsLikeC: 12 }), null, 'a shape the app does not know is not shown');
  assert.equal(readWeather(null), null);
  assert.equal(
    weatherLine({ tempC: 14.2, feelsLikeC: 12, precipProbability: 0.6, windKph: 4 }),
    '14°, feels like 12°, 60% rain',
  );
  assert.equal(weatherLine({ tempC: -1.4, feelsLikeC: -6, precipProbability: 0, windKph: 40 }), '-1°, feels like -6°');
});

test('preferences survive a browser that has no storage at all', () => {
  assert.equal(globalThis.localStorage, undefined, 'node has none, which is the private browsing case');
  assert.equal(readPref('location', 'ask'), 'ask');
  assert.equal(readChoice('location', ['off'], null), null);
  writePref('location', 'off');
  forgetPref('location');
  assert.equal(readPref('location', 'ask'), 'ask', 'writing where nothing can be written is not an error');
});

// ---------------------------------------------------------------------------
// Tag state
// ---------------------------------------------------------------------------

/** Mirrors TAGGED_FIELDS in src/worker/vision.ts: every field `blankDraft` flags. */
const TAGGED_FIELDS = [
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
  'accessoryKind',
  'shoulderBulk',
  'seasons',
  'notes',
];

const UNTAGGED = { ...GARMENT, id: 'u1', subtype: 'untagged item', uncertain: [...TAGGED_FIELDS] };

test('the app reads an untagged row off the same field list the tagger fills', () => {
  assert.deepEqual(
    [...FIELDS.map((field) => field.name)].sort(),
    [...TAGGED_FIELDS].sort(),
    'a field missing here would make a fresh upload read as tagged',
  );
  assert.ok(isUntagged(UNTAGGED));
  assert.ok(!isUntagged({ ...UNTAGGED, uncertain: TAGGED_FIELDS.slice(1) }), 'one sure field is not an untagged row');
  assert.ok(!isUntagged(GARMENT));
});

test('never tagged and tagged but unconfirmed are counted apart', () => {
  assert.equal(tagState(UNTAGGED), 'untagged', 'nothing has looked at this photo yet');
  assert.equal(tagState(GARMENT), 'unconfirmed', 'the tagger guessed and nobody has confirmed it');
  assert.equal(tagState({ ...GARMENT, reviewed: true }), 'reviewed');
  assert.equal(tagState({ ...UNTAGGED, reviewed: true }), 'reviewed', 'a hand-filled row is done either way');

  assert.deepEqual(countTagStates([UNTAGGED, GARMENT, { ...GARMENT, id: 'r1', reviewed: true }]), {
    untagged: 1,
    unconfirmed: 1,
    reviewed: 1,
  });
  assert.deepEqual(countTagStates([]), { untagged: 0, unconfirmed: 0, reviewed: 0 });
});

test('an upload the tagger never saw reads as saved, not as failed', () => {
  const answer = {
    ...UNTAGGED,
    taggingError: 'ANTHROPIC_API_KEY is not set on this Worker. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    missing: ['ANTHROPIC_API_KEY'],
  };

  const status = uploadStatus(answer);
  assert.equal(status.tagged, false);
  assert.match(status.status, /^Saved/, 'the photo did land, and the row says so first');
  assert.doesNotMatch(status.status, /fail|error|could not/i, 'untagged is the normal state of a fresh upload');
  assert.match(status.note, /Claude/, 'and the note points at who tags it');

  assert.ok(taggingPending({ missing: ['ANTHROPIC_API_KEY'] }), 'either field alone means no tagger ran');
  assert.ok(taggingPending({ taggingError: 'no key' }));
  assert.ok(!taggingPending(GARMENT));
  assert.ok(!taggingPending({ missing: [] }));
  assert.ok(!taggingPending(null));

  assert.deepEqual(uploadStatus(GARMENT), {
    tagged: true,
    status: 'Tagged as oxford shirt. 2 fields to check.',
    note: null,
  });
  assert.equal(uploadStatus({ ...GARMENT, uncertain: [] }).status, 'Tagged as oxford shirt. Nothing flagged.');
  assert.equal(uploadStatus({ ...GARMENT, uncertain: ['warmth'] }).status, 'Tagged as oxford shirt. 1 field to check.');
});

// ---------------------------------------------------------------------------
// Saved outfits
// ---------------------------------------------------------------------------

const RULE_TIGHT = {
  id: 'rect-02',
  short: 'Skim, never cling',
  because: 'with no curve to mark, tight fabric only highlights the flatness.',
};
const RULE_LAYERS = {
  id: 'rect-01',
  short: 'Layers or a V-neckline',
  because: 'layers and V-necks add depth and volume so the torso reads as having shape.',
};
const RULE_LEGS = {
  id: 'rect-04',
  short: 'Straight fitted legs',
  because: 'straight fitted legs add no volume at the hip.',
};
/** A `require` rule, which only ever reaches a card through a swap the owner made. */
const RULE_LOOSE = {
  id: 'rect-06b',
  short: 'Nothing very loose',
  because: 'very loose garments amplify the flatness.',
};

function garment(id, subtype) {
  return { ...GARMENT, id, subtype, imageCutout: null, imageOriginal: `orig/${id}` };
}

/** No trailing Z: every date here is read on the phone that saved it. */
const SAVED = {
  id: 'o1',
  createdAt: '2026-09-03T08:12:00',
  pieces: [
    { slot: 'shoes', garment: garment('s1', 'white sneaker') },
    { slot: 'base', garment: garment('b1', 'navy tee') },
    { slot: 'bottom', garment: garment('p1', 'wide chino') },
    { slot: 'mid', garment: garment('m1', 'grey overshirt') },
  ],
  accessories: [garment('a2', 'leather belt')],
  title: 'Errands without trying too hard',
  rationale: 'The overshirt gives the torso a second layer.',
  cited: [RULE_LAYERS, RULE_TIGHT],
  missed: [RULE_LEGS],
  worn: false,
};

test('a saved outfit comes out in the order the pieces are worn', () => {
  const outfit = readOutfit(SAVED);
  assert.deepEqual(
    orderPieces(outfit.pieces).map((piece) => piece.slot),
    ['base', 'mid', 'bottom', 'shoes'],
    'base through shoes, whatever order they arrived in',
  );
  assert.deepEqual(
    orderPieces([{ slot: 'hat' }, { slot: 'base' }]).map((piece) => piece.slot),
    ['base', 'hat'],
    'a slot the app does not know sinks to the end instead of disappearing',
  );
  assert.deepEqual(orderPieces([]), []);
});

test('an outfit with no pieces is not drawn as an empty card', () => {
  assert.equal(readOutfit({ ...SAVED, pieces: [] }), null);
  assert.equal(readOutfit({ ...SAVED, pieces: [{ slot: 'base' }] }), null, 'a piece with no garment has no photo');
  assert.equal(readOutfit(null), null);
  assert.equal(readOutfit('outfit'), null);

  const loose = readOutfit({ pieces: SAVED.pieces });
  assert.deepEqual(
    { id: loose.id, title: loose.title, rationale: loose.rationale, cited: loose.cited, missed: loose.missed, worn: loose.worn },
    { id: '', title: '', rationale: '', cited: [], missed: [], worn: false },
    'the fields a chat can leave out read as empty, never as undefined on screen',
  );
});

test('an outfit carries the name it was saved under', () => {
  assert.equal(readOutfit(SAVED).title, 'Errands without trying too hard');
  assert.equal(
    readOutfit({ ...SAVED, title: undefined }).title,
    '',
    'an outfit saved before titles existed, which the card shows no line for',
  );
  assert.equal(readOutfit({ ...SAVED, title: 12 }).title, '');
});

test('a cited rule is never also a missed one', () => {
  const both = {
    ...SAVED,
    cited: [RULE_LAYERS, RULE_LAYERS, RULE_TIGHT],
    missed: [RULE_TIGHT, RULE_LEGS, RULE_LEGS],
  };
  const { cited, missed } = splitRules(readOutfit(both));

  assert.deepEqual(cited.map((rule) => rule.id), ['rect-01', 'rect-02'], 'each cited rule shows once');
  assert.deepEqual(missed.map((rule) => rule.id), ['rect-04'], 'a rule the outfit follows is not also missed');
  for (const rule of missed) {
    assert.ok(!cited.some((entry) => entry.id === rule.id), `${rule.id} is on one side only`);
  }
  for (const rule of [...cited, ...missed]) {
    assert.ok(rule.because.length > 0, "every rule shown carries the book's own sentence");
  }

  const halves = readOutfit({ ...SAVED, cited: [{ id: 'rect-01' }, RULE_LAYERS], missed: ['rect-04'] });
  assert.deepEqual(halves.cited, [RULE_LAYERS], 'a rule with no sentence is not a rule the app can show');
  assert.deepEqual(halves.missed, []);

  assert.deepEqual(splitRules(readOutfit({ ...SAVED, cited: [], missed: [] })), {
    cited: [],
    missed: [],
    broke: [],
  });
});

test("a dont the owner's own change broke is read apart from the misses", () => {
  assert.deepEqual(readOutfit(SAVED).broke, [], 'an outfit nobody changed broke none of the donts');
  assert.deepEqual(
    readOutfit({ ...SAVED, broke: [RULE_LOOSE, { id: 'rect-05b' }] }).broke,
    [RULE_LOOSE],
    'a rule with no sentence is not a rule the app can show',
  );

  const { cited, missed, broke } = splitRules(
    readOutfit({ ...SAVED, cited: [RULE_LAYERS], missed: [RULE_LEGS], broke: [RULE_LAYERS, RULE_LOOSE] }),
  );
  assert.deepEqual(cited.map((rule) => rule.id), ['rect-01']);
  assert.deepEqual(missed.map((rule) => rule.id), ['rect-04']);
  assert.deepEqual(
    broke.map((rule) => rule.id),
    ['rect-06b'],
    'a rule the outfit is shown to follow is not also shown as broken',
  );
});

test('every rule reaches its pill with something on it', () => {
  const outfit = readOutfit(SAVED);
  assert.deepEqual(
    outfit.cited.map((rule) => rule.short),
    ['Layers or a V-neckline', 'Skim, never cling'],
  );
  assert.deepEqual(outfit.missed.map((rule) => rule.short), ['Straight fitted legs'], 'a missed rule is named the same way');

  const older = readOutfit({
    ...SAVED,
    cited: [{ id: 'rect-01', because: RULE_LAYERS.because }],
    missed: [{ ...RULE_LEGS, short: '' }],
    broke: [{ ...RULE_LOOSE, short: 12 }],
  });
  assert.deepEqual(
    older.cited.map((rule) => rule.short),
    ['rect-01'],
    'an outfit saved before the book carried short lines still has pills',
  );
  assert.deepEqual(older.missed.map((rule) => rule.short), ['rect-04'], 'and a blank one is no better than none');
  assert.deepEqual(older.broke.map((rule) => rule.short), ['rect-06b']);
  assert.equal(older.cited[0].because, RULE_LAYERS.because, 'the sentence behind the pill is untouched');
});

test('the closed book row counts both sides', () => {
  assert.equal(bookTally(6, 3), '6 kept, 3 missed');
  assert.equal(bookTally(1, 1), '1 kept, 1 missed');
  assert.equal(bookTally(6, 0), '6 kept', 'nothing missed is not worth the words "0 missed"');
  assert.equal(bookTally(0, 3), '3 missed');
  assert.equal(bookTally(0, 0), '', 'the row itself is left off the card at that point');
});

test('a tile names an accessory by its kind and every other piece by its slot', () => {
  assert.equal(pieceLabel('mid', garment('m1', 'grey overshirt')), 'mid');
  assert.equal(pieceLabel('shoes', garment('s1', 'white sneaker')), 'shoes');
  assert.equal(
    pieceLabel('accessory', { ...garment('a1', 'baseball cap'), accessoryKind: 'hat' }),
    'hat',
    'two accessories read as one word otherwise',
  );
  assert.equal(
    pieceLabel('accessory', garment('a2', 'leather belt')),
    'accessory',
    'an accessory nobody tagged still says something under its photo',
  );
  assert.equal(
    pieceLabel('accessory', { ...garment('a3', 'canvas tote'), accessoryKind: 'other' }),
    'accessory',
    'the owner can pick `other` on the review screen and "Change the other" is not a sentence',
  );
});

test('the add row offers every slot the outfit has no tile for, and none at all once it is worn', () => {
  const bare = readOutfit({ ...SAVED, pieces: SAVED.pieces.filter((piece) => piece.slot !== 'mid') });
  assert.deepEqual(
    addableSlots(bare, false),
    ['top', 'mid', 'outer', 'accessory'],
    'base, bottom and shoes are left out: an outfit missing one of those is not one the picker can fix',
  );

  assert.deepEqual(
    addableSlots(readOutfit(SAVED), false),
    ['top', 'outer', 'accessory'],
    'the mid it wears is not offered again, and the belt it wears does not close the accessory chip',
  );

  const layered = readOutfit({
    ...SAVED,
    pieces: [
      ...SAVED.pieces,
      { slot: 'top', garment: garment('t1', 'linen shirt') },
      { slot: 'outer', garment: garment('o1', 'navy trench') },
    ],
  });
  assert.deepEqual(addableSlots(layered, false), ['accessory'], 'every layer is taken, and a list is never full');

  assert.deepEqual(addableSlots(layered, true), [], 'a worn outfit is the record of a day, so the row goes with the taps');
  assert.deepEqual(addableSlots(bare, true), []);
});

test("the owner's corrections ride along with the outfit", () => {
  assert.deepEqual(readOutfit(SAVED).corrections, [], 'an outfit nobody touched was never corrected');

  const corrected = readOutfit({
    ...SAVED,
    corrections: [
      {
        at: '2026-09-03T09:00:00',
        event: 'work',
        slot: 'mid',
        from: { id: 'm1', subtype: 'grey overshirt' },
        to: { id: 'm2', subtype: 'navy cardigan' },
        reason: 'the overshirt is too warm indoors',
      },
      { slot: 'accessory', from: { id: 'a2' }, to: null, reason: 'no belt with this one' },
      { slot: 'outer', from: null, to: { id: 'o1', subtype: 'navy trench' }, reason: 'it turns cold at six' },
      { slot: 'mid', from: null, reason: 'a row with no garment on either side' },
      'not a correction at all',
    ],
  });

  assert.deepEqual(
    corrected.corrections,
    [
      {
        slot: 'mid',
        from: { id: 'm1', subtype: 'grey overshirt' },
        to: { id: 'm2', subtype: 'navy cardigan' },
        reason: 'the overshirt is too warm indoors',
      },
      { slot: 'accessory', from: { id: 'a2', subtype: null }, to: null, reason: 'no belt with this one' },
      { slot: 'outer', from: null, to: { id: 'o1', subtype: 'navy trench' }, reason: 'it turns cold at six' },
    ],
    'a piece added to a slot the outfit never had is kept, a row with neither side is dropped, and a garment with no name reads as null',
  );
});

test('every garment in a saved outfit reaches the wear log once', () => {
  assert.deepEqual(garmentIds(readOutfit(SAVED)), ['s1', 'b1', 'p1', 'm1', 'a2'], 'the accessories are worn too');
  assert.deepEqual(garmentIds({ pieces: [], accessories: [] }), []);
  assert.deepEqual(
    wearEntry(readOutfit(SAVED)),
    { garmentIds: ['s1', 'b1', 'p1', 'm1', 'a2'], outfitId: 'o1' },
    'the wear names the outfit it was, which is what tells two of one day apart',
  );
});

test('nothing saved for today is a sentence, not a blank screen', () => {
  for (const body of [{ outfits: [] }, {}, null, { outfits: [{ pieces: [] }] }, { outfits: null }]) {
    const view = todayView(readOutfits(body));
    assert.equal(view.kind, 'empty');
    assert.equal(view.title, NOTHING_SAVED.title);
    assert.ok(view.title.length > 0, 'a blank screen is the one outcome worth avoiding');
    assert.match(view.detail, /Claude/, 'and it says who saves one, since the app cannot');
  }
});

test('today shows every outfit saved today, with the sets kept together', () => {
  const options = [
    { ...SAVED, id: 'a1', planId: 'plan-a', createdAt: '2026-09-03T08:12:00' },
    { ...SAVED, id: 'a2', planId: 'plan-a', createdAt: '2026-09-03T08:12:30' },
  ];
  const alone = { ...SAVED, id: 'b1', planId: 'plan-b', createdAt: '2026-09-03T19:40:00' };

  const view = todayView(readOutfits({ outfits: [alone, ...options] }));
  assert.equal(view.kind, 'sets');
  assert.deepEqual(
    view.sets.map((set) => set.outfits.map((outfit) => outfit.id)),
    [['b1'], ['a1', 'a2']],
    'the newest group leads, and the two options of one request are one group',
  );
  assert.equal(view.sets[1].outfits[0].pieces.length, 4, 'and every outfit in one is the card it was');

  const one = todayView(readOutfits({ outfits: [SAVED] }));
  assert.equal(one.kind, 'sets', 'a single outfit is a set of one, so neither screen asks which it got');
  assert.deepEqual(one.sets.map((set) => set.outfits.length), [1]);
});

test('the outfits of one request come back as one set, in the order they were composed', () => {
  const plan = (id, createdAt) => ({ ...SAVED, id, planId: 'plan-a', createdAt });
  const set = [plan('a1', '2026-09-03T08:12:00'), plan('a2', '2026-09-03T08:12:30'), plan('a3', '2026-09-03T08:13:00')];
  const later = { ...SAVED, id: 'b1', planId: 'plan-b', createdAt: '2026-09-03T19:40:00' };
  const earlier = { ...SAVED, id: 'c1', planId: 'plan-c', createdAt: '2026-09-01T10:00:00' };

  const sets = groupBySet(readOutfits({ outfits: [earlier, ...set, later] }));
  assert.deepEqual(
    sets.map((one) => [one.setId, one.outfits.map((outfit) => outfit.id)]),
    [
      ['plan-b', ['b1']],
      ['plan-a', ['a1', 'a2', 'a3']],
      ['plan-c', ['c1']],
    ],
    'newest set first, and option 1 is the first outfit Claude wrote rather than the last',
  );
  assert.deepEqual(groupBySet([]), []);
});

test('an outfit saved with no plan on it stands alone instead of joining a false set', () => {
  const older = { ...SAVED, id: 'o0', createdAt: '2026-09-01T19:40:00' };
  const sets = groupBySet(readOutfits({ outfits: [SAVED, older] }));

  assert.deepEqual(
    sets.map((set) => set.outfits.map((outfit) => outfit.id)),
    [['o1'], ['o0']],
    'two outfits from a worker that sent no plan id are two answers, not one set of two',
  );
  assert.notEqual(sets[0].setId, sets[1].setId, 'and neither of them is keyed on the empty string');
  assert.equal(readOutfit({ ...SAVED, planId: 'plan-a' }).planId, 'plan-a', 'a plan id that came through is kept');
  // The reader hands back what arrived, empty included. Standing the id-less
  // outfits apart is the grouping's job, asserted above, so that the reader
  // stays a pure function of one response.
  assert.equal(readOutfit({ ...SAVED, planId: '' }).planId, '');
});

test('the history reads newest first, and drops what it cannot draw', () => {
  const older = { ...SAVED, id: 'o0', createdAt: '2026-09-01T19:40:00', worn: true };
  const newer = { ...SAVED, id: 'o2', createdAt: '2026-09-03T21:05:00' };

  const outfits = readOutfits({ outfits: [older, newer, SAVED, { id: 'o3', pieces: [] }, null] });
  assert.deepEqual(outfits.map((outfit) => outfit.id), ['o2', 'o1', 'o0']);
  assert.equal(outfits[2].worn, true, 'a day already logged says so');
  assert.deepEqual(readOutfits({}), []);
  // Read apart, because the remove control promises the cooldown on the second
  // and a wear from before migration 009 sets the first without it.
  assert.equal(readOutfit({ ...SAVED, worn: true, wearNamed: true }).wearNamed, true);
  assert.equal(readOutfit({ ...SAVED, worn: true }).wearNamed, false, 'a wear naming no outfit is not one the delete can reach');
  assert.deepEqual(readOutfits(null), []);
});

test('a saved outfit says when it was saved', () => {
  const now = new Date('2026-09-03T22:00:00');
  assert.equal(savedLine('2026-09-03T08:12:00', now), 'Today, 08:12');
  assert.equal(savedLine('2026-09-02T19:40:00', now), 'Yesterday, 19:40');
  assert.equal(savedLine('2026-09-01T19:40:00', now), 'Tue 1 Sep');
  assert.equal(savedLine('nope', now), 'Saved', 'a date the app cannot read is not a crash');
  assert.equal(savedClock('2026-09-03T08:12:00'), '08:12');
  assert.equal(savedClock(''), '');
});

test('the screens hit the routes the worker registers', async () => {
  const calls = [];
  const api = createApi({
    fetchImpl: async (path, init) => {
      calls.push({
        path,
        method: init.method ?? 'GET',
        body: init.body,
        type: init.headers?.['content-type'] ?? null,
      });
      return fakeResponse(200, { ok: true });
    },
  });

  await api.getProfile();
  await api.saveProfile(profileBody(MIRROR.circular, 'circular', 'es'));
  await api.getWeather(-34.1112, -56.3334);
  await api.getTodayOutfits();
  await api.listOutfits(20);
  await api.wear(wearEntry(readOutfit(SAVED)));
  await api.putCutout('a 1', new Uint8Array([1]));
  await api.resetCutout('a 1');
  await api.replacePhoto('a 1', new Uint8Array([1]), 'image/jpeg');
  await api.editPiece('o 1', { fromId: 'm1', toId: null, reason: 'too warm indoors' });
  await api.removeOutfit('o 1');
  await api.saveHome(-34.111222, -56.333444);
  await api.clearHome();

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'GET /api/profile',
      'PUT /api/profile',
      'GET /api/weather?lat=-34.1112&lon=-56.3334',
      'GET /api/outfits/today',
      'GET /api/outfits?limit=20',
      'POST /api/wear',
      'PUT /api/garments/a%201/cutout',
      'POST /api/garments/a%201/cutout/reset',
      'PUT /api/garments/a%201/photo',
      'POST /api/outfits/o%201/swap',
      'DELETE /api/outfits/o%201',
      'PUT /api/profile/home',
      'DELETE /api/profile/home',
    ],
  );
  assert.equal(calls[6].type, 'image/png', 'the cutout route answers 415 to anything else');
  assert.equal(calls[8].type, 'image/jpeg');
  assert.equal(
    calls[1].body,
    '{"shouldersVsHips":"equal","waistIsWidest":true,"volume":"center","line":"curved","thinLegs":false,"bodyType":"circular","language":"es"}',
  );
  assert.equal(calls[9].body, '{"fromId":"m1","toId":null,"reason":"too warm indoors"}');
  assert.equal(calls[5].body, '{"garmentIds":["s1","b1","p1","m1","a2"],"outfitId":"o1"}');
  assert.equal(calls[11].body, '{"lat":-34.111222,"lon":-56.333444}', 'the coordinates go over the wire whole');
});

const REQUEST = {
  words: 'I want to wear the beige linen shirt',
  disagreement: 'I would have kept the oxford.',
  honored: [{ id: 't1', subtype: 'linen shirt', waived: ['season'] }],
};

test("an owner's request is read whole, or not at all", () => {
  const read = readOutfit({ ...SAVED, ownerRequest: REQUEST });
  assert.deepEqual(read.ownerRequest, REQUEST);

  assert.equal(readOutfit(SAVED).ownerRequest, null, 'an outfit nobody overrode a filter for');
  assert.equal(
    readOutfit({ ...SAVED, ownerRequest: { ...REQUEST, words: '' } }).ownerRequest,
    null,
    'a waiver with no words behind it is the one thing this section must never draw',
  );
  assert.equal(
    readOutfit({ ...SAVED, ownerRequest: { ...REQUEST, honored: [] } }).ownerRequest,
    null,
    'words with nothing they let in say nothing',
  );
});

test('a waiver code the app does not know is dropped, not drawn', () => {
  const read = readOutfit({
    ...SAVED,
    ownerRequest: { ...REQUEST, honored: [{ id: 't1', waived: ['season', 'vibes'] }] },
  });

  assert.deepEqual(read.ownerRequest.honored, [{ id: 't1', subtype: null, waived: ['season'] }]);
  assert.equal(
    readOutfit({ ...SAVED, ownerRequest: { words: 'x', honored: [{ id: 't1' }] } }).ownerRequest
      .disagreement,
    '',
    'a request with no second opinion still draws',
  );
});

// ---------------------------------------------------------------------------
// What the swap picker cautions about
// ---------------------------------------------------------------------------

test('the event a saved outfit was built for rides along with it', () => {
  assert.equal(readOutfit({ ...SAVED, event: 'formal' }).event, 'formal');
  assert.equal(
    readOutfit({ ...SAVED, event: 'brunch' }).event,
    null,
    'an event code the app does not know must never reach a table lookup',
  );
  assert.equal(readOutfit(SAVED).event, null, 'an outfit saved before the event reached the phone');
});

test('a saved outfit gives up the day it was built for, or gives up nothing', () => {
  assert.deepEqual(outfitDay({ createdAt: '2026-09-03T08:12:00', event: 'formal' }), {
    season: 'spring',
    minFormality: 4,
  });
  assert.deepEqual(
    outfitDay({ createdAt: '2026-09-01 10:00:00', event: 'work' }),
    { season: 'spring', minFormality: 3 },
    'the space separated form the column DEFAULT writes reads the same as the ISO one',
  );

  assert.deepEqual(
    outfitDay({ createdAt: '', event: 'work' }),
    { season: null, minFormality: 3 },
    'no date costs the season and leaves the floor',
  );
  assert.deepEqual(outfitDay({ createdAt: 'saved a while ago', event: 'work' }), {
    season: null,
    minFormality: 3,
  });
  assert.deepEqual(
    outfitDay({ createdAt: '2026-13-04T08:12:00', event: 'work' }).season,
    null,
    'a month no calendar has falls through to no season rather than to spring',
  );
  assert.deepEqual(
    outfitDay({ createdAt: '2026-09-03T08:12:00', event: null }),
    { season: 'spring', minFormality: null },
    'no event costs the floor and leaves the season',
  );
});

/** Nothing has read this photo, so every tag on it is `blankDraft`'s placeholder. */
const NEVER_TAGGED = { ...UNTAGGED, slot: 'base', formality: 3, seasons: [] };

/** Confirmed by hand, so the tag state itself is never one of the reasons under test. */
const confirmed = (over) => ({ ...GARMENT, reviewed: true, uncertain: [], ...over });

const SUMMER = { season: 'summer', minFormality: null };
const SUMMER_FORMAL = { season: 'summer', minFormality: 4 };

test('a garment nobody has tagged says that, and says nothing else', () => {
  assert.deepEqual(cautionsFor(NEVER_TAGGED, SUMMER), ['untagged']);
  assert.deepEqual(
    cautionsFor({ ...NEVER_TAGGED, formality: 1 }, SUMMER_FORMAL),
    ['untagged'],
    'the placeholder fails both filters, and both would be a claim about a photo nobody has read',
  );
});

test('a garment with no season set is told apart from one in the wrong season', () => {
  assert.deepEqual(
    cautionsFor({ ...GARMENT, seasons: ['winter'] }, SUMMER),
    ['season'],
    'a guess nobody confirmed is still a reading, so it is judged like any other',
  );
  assert.deepEqual(cautionsFor({ ...GARMENT, seasons: [] }, SUMMER), ['no_season']);
  assert.deepEqual(
    cautionsFor(confirmed({ seasons: [] }), SUMMER),
    ['no_season'],
    'a reviewed row can carry an empty list too, so this is not the untagged test again',
  );
});

test('the two reasons a day can argue against a candidate stay told apart', () => {
  assert.deepEqual(cautionsFor(confirmed({ seasons: [], formality: 2 }), SUMMER_FORMAL), [
    'no_season',
    'formality',
  ]);
  assert.deepEqual(cautionsFor(confirmed({ seasons: ['winter'], formality: 2 }), SUMMER_FORMAL), [
    'season',
    'formality',
  ]);

  assert.deepEqual(
    cautionsFor(confirmed({ slot: 'accessory', formality: 1, seasons: ['summer'] }), SUMMER_FORMAL),
    [],
    'the floor is about the silhouette, and a ring is not part of one',
  );
  assert.deepEqual(cautionsFor(confirmed({ seasons: ['summer'], formality: 5 }), SUMMER_FORMAL), []);
});

/**
 * A season list is matched against a season, so a day with none has nothing to
 * match it against. `[].includes(null)` and `['winter'].includes(null)` are both
 * false, so a predicate that dropped this guard would call the whole wardrobe
 * out of season on a row whose date cannot be read.
 */
test('a day the row cannot name argues against nothing', () => {
  const winterCoat = confirmed({ seasons: ['winter'], formality: 1 });

  assert.deepEqual(cautionsFor(winterCoat, { season: null, minFormality: null }), []);
  assert.deepEqual(
    cautionsFor(winterCoat, { season: null, minFormality: 4 }),
    ['formality'],
    'no date costs the season line and leaves the floor to speak for itself',
  );
  assert.deepEqual(
    cautionsFor(confirmed({ seasons: [], formality: 5 }), { season: null, minFormality: null }),
    [],
    'an empty season list is only worth saying against a season',
  );
  assert.deepEqual(
    cautionsFor(winterCoat, { season: 'summer', minFormality: null }),
    ['season'],
    'no event costs the formality line and leaves the season to speak for itself',
  );
});

const EVERY_DAY_A_TILE_CAN_MEET = [null, 'spring', 'summer', 'autumn', 'winter'].flatMap((season) =>
  [null, 1, 2, 3, 4, 5].map((minFormality) => ({ season, minFormality })),
);

/**
 * The seam between what a garment can be cautioned for and what the picker has
 * words for. `CAUTION_WORDS` is read only inside `picker`, which no test draws,
 * so a key deleted from it renders the literal string "undefined" under a
 * garment and nothing else in this repo notices.
 */
test('every caution a garment can draw has a word to draw it with', () => {
  const garments = [
    NEVER_TAGGED,
    GARMENT,
    { ...GARMENT, seasons: [] },
    confirmed({ seasons: [], formality: 1 }),
    confirmed({ seasons: ['winter'], formality: 1 }),
    confirmed({ seasons: ['summer'], formality: 5 }),
    confirmed({ slot: 'accessory', seasons: [], formality: 1 }),
  ];

  const drawn = new Set();
  for (const garment of garments) {
    for (const day of EVERY_DAY_A_TILE_CAN_MEET) {
      const cautions = cautionsFor(garment, day);
      assert.ok(
        cautions.length <= 2,
        `${garment.id} against ${day.season}/${day.minFormality} said ${cautions.join(' and ')}`,
      );
      for (const caution of cautions) drawn.add(caution);
    }
  }

  assert.deepEqual(
    [...drawn].sort(),
    Object.keys(CAUTION_WORDS).sort(),
    'the sweep must reach every word, or a stale one could sit here unread',
  );
  for (const caution of drawn) {
    assert.equal(typeof CAUTION_WORDS[caution], 'string', `${caution} has no word`);
  }
});

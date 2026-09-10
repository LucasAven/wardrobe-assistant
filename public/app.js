import { createApi } from './lib/api.js';
import { readProfile } from './lib/body.js';
import { clear, el } from './lib/dom.js';
import { parseRoute } from './lib/router.js';
import { mountEditPhoto } from './lib/screens/editphoto.js';
import { createAuthGate } from './lib/screens/login.js';
import { mountOutfits } from './lib/screens/outfits.js';
import { mountProfile } from './lib/screens/profile.js';
import { mountReview } from './lib/screens/review.js';
import { mountToday } from './lib/screens/today.js';
import { mountUpload } from './lib/screens/upload.js';
import { mountWardrobe } from './lib/screens/wardrobe.js';

const TOAST_MS = 5000;

const shell = {
  screen: document.getElementById('screen'),
  title: document.getElementById('title'),
  meta: document.getElementById('meta'),
  back: document.getElementById('back'),
  refresh: document.getElementById('refresh'),
  badge: document.getElementById('review-badge'),
  overlay: document.getElementById('auth'),
  toast: document.getElementById('toast'),
  tabs: [...document.querySelectorAll('.tab')],
};

let api = null;
const gate = createAuthGate({ overlay: shell.overlay, login: (password) => api.login(password) });
api = createApi({ onUnauthorized: () => gate.open() });

function createStore() {
  let garments = [];
  let loaded = false;
  let inFlight = null;

  function refresh() {
    // One request for a boot and a screen mount that land together.
    if (inFlight === null) {
      inFlight = api
        .listGarments()
        .then((rows) => {
          garments = rows;
          loaded = true;
          return rows;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    get garments() {
      return garments;
    },
    get unreviewed() {
      return garments.filter((garment) => !garment.reviewed);
    },
    refresh,
    ensure: () => (loaded ? Promise.resolve(garments) : refresh()),
    find: (id) => garments.find((garment) => garment.id === id) ?? null,
    upsert(garment) {
      const at = garments.findIndex((row) => row.id === garment.id);
      if (at < 0) garments = [garment, ...garments];
      else garments = garments.map((row) => (row.id === garment.id ? garment : row));
    },
    remove(id) {
      garments = garments.filter((garment) => garment.id !== id);
    },
  };
}

const store = createStore();

/** One record, read once a session. Two screens ask for it and neither should wait twice. */
function createProfileStore() {
  let data = { profile: null, suggestedType: null };
  let loaded = false;
  let inFlight = null;

  function refresh() {
    if (inFlight === null) {
      inFlight = api
        .getProfile()
        .then((body) => {
          data = readProfile(body);
          loaded = true;
          return data;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    get profile() {
      return data.profile;
    },
    get suggestedType() {
      return data.suggestedType;
    },
    refresh,
    ensure: () => (loaded ? Promise.resolve(data) : refresh()),
    set(next) {
      data = next;
      loaded = true;
    },
  };
}

/**
 * Which outfits were logged as worn this session. Whether the Worker flips the
 * outfit's own flag is its business, so the tap is remembered here as well and
 * the same day is never offered twice.
 */
function createWearLog() {
  const worn = new Set();
  return {
    isWorn: (id) => worn.has(id),
    markWorn: (id) => worn.add(id),
  };
}

const profiles = createProfileStore();
const worn = createWearLog();

let toastTimer = null;
function toast(message, kind = 'info') {
  shell.toast.textContent = message;
  shell.toast.dataset.kind = kind;
  shell.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    shell.toast.hidden = true;
  }, TOAST_MS);
}

function refreshBadge() {
  const left = store.unreviewed.length;
  shell.badge.textContent = String(left);
  shell.badge.hidden = left === 0;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

const SCREENS = {
  today: mountToday,
  outfits: mountOutfits,
  profile: mountProfile,
  upload: mountUpload,
  review: mountReview,
  wardrobe: mountWardrobe,
  edit: mountEditPhoto,
};

/**
 * The history hangs off Today and the photo editor off Review, so the tab the
 * user tapped stays lit.
 */
const TAB_FOR_ROUTE = { outfits: 'today', edit: 'review' };

let backTarget = null;
shell.back.addEventListener('click', () => {
  if (backTarget !== null) go(backTarget);
});

let refreshHandler = null;
shell.refresh.addEventListener('click', () => refreshHandler?.());

const ctx = {
  api,
  store,
  profile: profiles,
  worn,
  go,
  toast,
  refreshBadge,
  setTitle(title, meta) {
    shell.title.textContent = title;
    shell.meta.textContent = meta;
  },
  setBack(hash) {
    backTarget = hash;
    shell.back.hidden = hash === null;
  },
  onRefresh(handler) {
    refreshHandler = handler;
    shell.refresh.hidden = handler === null;
  },
};

let screen = null;

function render() {
  const route = parseRoute(location.hash);

  screen?.destroy?.();
  clear(shell.screen);
  ctx.setBack(null);
  ctx.onRefresh(null);
  ctx.setTitle('Wardrobe', '');

  const lit = TAB_FOR_ROUTE[route.name] ?? route.name;
  for (const tab of shell.tabs) {
    if (tab.dataset.route === lit) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  screen = SCREENS[route.name](ctx, route);
  shell.screen.append(screen.node);
  shell.screen.scrollTop = 0;
}

window.addEventListener('hashchange', render);

/**
 * The app opens on what Claude saved for today, unless there is no body type
 * yet, in which case nothing downstream can run and the setup is the only
 * useful screen. A profile that fails to load still lands on Today.
 */
function boot() {
  if (location.hash !== '' && location.hash !== '#' && location.hash !== '#/') {
    render();
    return;
  }

  shell.screen.append(el('div', { class: 'empty' }, el('p', { class: 'empty__text' }, 'Opening.')));
  profiles
    .ensure()
    .catch(() => null)
    .then(() => {
      const landing = profiles.profile === null ? '#/profile' : '#/today';
      if (location.hash === landing) render();
      else location.hash = landing;
    });
}

boot();
store
  .ensure()
  .then(refreshBadge)
  .catch((error) => toast(error.message, 'error'));

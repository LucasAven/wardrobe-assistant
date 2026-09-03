import { createApi } from './lib/api.js';
import { clear } from './lib/dom.js';
import { parseRoute } from './lib/router.js';
import { createAuthGate } from './lib/screens/login.js';
import { mountReview } from './lib/screens/review.js';
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

const SCREENS = { upload: mountUpload, review: mountReview, wardrobe: mountWardrobe };

let backTarget = null;
shell.back.addEventListener('click', () => {
  if (backTarget !== null) go(backTarget);
});

let refreshHandler = null;
shell.refresh.addEventListener('click', () => refreshHandler?.());

const ctx = {
  api,
  store,
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

  for (const tab of shell.tabs) {
    if (tab.dataset.route === route.name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  screen = SCREENS[route.name](ctx, route);
  shell.screen.append(screen.node);
  shell.screen.scrollTop = 0;
}

window.addEventListener('hashchange', render);

render();
store
  .ensure()
  .then(refreshBadge)
  .catch((error) => toast(error.message, 'error'));

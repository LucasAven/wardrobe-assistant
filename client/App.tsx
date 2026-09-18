import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthOverlay } from './screens/AuthOverlay.js';
import { VanillaScreen } from './screens/VanillaScreen.js';
import type { MountScreen } from './screens/VanillaScreen.js';
import { createVanillaCtx } from './lib/ctx.js';
import { garmentsQuery, profileQuery, queryClient } from './lib/queries.js';
import { go, routeSnapshot, subscribeRoute } from './lib/route.js';
import { mountEditPhoto } from './lib/screens/editphoto.js';
import { mountOutfits } from './lib/screens/outfits.js';
import { mountProfile } from './lib/screens/profile.js';
import { mountReview } from './lib/screens/review.js';
import { mountToday } from './lib/screens/today.js';
import { mountUpload } from './lib/screens/upload.js';
import { mountWardrobe } from './lib/screens/wardrobe.js';

const TOAST_MS = 5000;

const ICON = {
  stroke: 'currentColor',
  fill: 'none',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const TABS = [
  {
    route: 'today',
    label: 'Today',
    paths: (
      <>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
      </>
    ),
  },
  {
    route: 'outfits',
    label: 'Outfits',
    paths: (
      <>
        <rect x="3.5" y="3.5" width="17" height="7" rx="2.4" />
        <rect x="3.5" y="13.5" width="17" height="7" rx="2.4" />
      </>
    ),
  },
  {
    route: 'upload',
    label: 'Add',
    paths: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8.5v7M8.5 12h7" />
      </>
    ),
  },
  {
    route: 'review',
    label: 'Review',
    paths: (
      <>
        <path d="M20.5 11.3V12a8.5 8.5 0 1 1-5-7.8" />
        <path d="M20.5 5.5 12 14l-2.5-2.5" />
      </>
    ),
  },
  {
    route: 'wardrobe',
    label: 'Wardrobe',
    paths: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
      </>
    ),
  },
  {
    route: 'profile',
    label: 'Profile',
    paths: (
      <>
        <circle cx="12" cy="8" r="3.6" />
        <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
      </>
    ),
  },
];

/** The photo editor hangs off Review, so the tab the user tapped stays lit. */
const TAB_FOR_ROUTE: Record<string, string> = { edit: 'review' };

const SCREENS: Record<string, MountScreen> = {
  today: mountToday,
  outfits: mountOutfits,
  profile: mountProfile,
  upload: mountUpload,
  review: mountReview,
  wardrobe: mountWardrobe,
  edit: mountEditPhoto,
};

function onLandingHash() {
  return location.hash === '' || location.hash === '#' || location.hash === '#/';
}

export function App() {
  const route = useSyncExternalStore(subscribeRoute, routeSnapshot);

  const [title, setTitleState] = useState({ title: 'Wardrobe', meta: '' });
  const [back, setBackState] = useState<string | null>(null);
  const [refreshHandler, setRefreshHandler] = useState<(() => void) | null>(null);
  const [toastState, setToastState] = useState<{ message: string; kind: string } | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((message: string, kind = 'info') => {
    setToastState({ message, kind });
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }, []);

  const ctx = useMemo(
    () =>
      createVanillaCtx({
        toast,
        setTitle: (next, meta) => setTitleState({ title: next, meta }),
        setBack: (hash) => setBackState(hash),
        onRefresh: (handler) => setRefreshHandler(() => handler),
      }),
    [toast],
  );

  const garments = useQuery(garmentsQuery);
  useEffect(() => {
    if (garments.error instanceof Error) toast(garments.error.message, 'error');
  }, [garments.error, toast]);

  /**
   * The app opens on what Claude saved for today, unless there is no body type
   * yet, in which case nothing downstream can run and the setup is the only
   * useful screen. A profile that fails to load still lands on Today.
   */
  const [booting, setBooting] = useState(onLandingHash);
  useEffect(() => {
    if (!booting) return;
    let live = true;
    queryClient
      .ensureQueryData(profileQuery)
      .catch(() => null)
      .then((data) => {
        if (!live) return;
        go(data?.profile == null ? '#/profile' : '#/today');
        setBooting(false);
      });
    return () => {
      live = false;
    };
  }, [booting]);

  const unreviewed = (garments.data ?? []).filter((garment) => !garment.reviewed).length;
  const lit = TAB_FOR_ROUTE[route.name] ?? route.name;
  const mount = SCREENS[route.name];

  return (
    <>
      <div className="app">
        <header className="topbar">
          <button className="topbar__back" type="button" hidden={back === null} onClick={() => back !== null && go(back)}>
            Back
          </button>
          <h1 className="topbar__title">{title.title}</h1>
          <span className="topbar__meta">{title.meta}</span>
          <button
            className="topbar__refresh"
            type="button"
            hidden={refreshHandler === null}
            onClick={() => refreshHandler?.()}
          >
            Refresh
          </button>
        </header>

        {booting || mount === undefined ? (
          <main className="screen">
            <div className="empty">
              <p className="empty__text">Opening.</p>
            </div>
          </main>
        ) : (
          <VanillaScreen key={`${route.name}/${route.id ?? ''}/${route.nonce}`} mount={mount} ctx={ctx} route={route} />
        )}

        <nav className="tabbar">
          {TABS.map((tab) => (
            <a
              className="tab"
              key={tab.route}
              href={`#/${tab.route}`}
              aria-current={lit === tab.route ? 'page' : undefined}
            >
              <svg className="tab__icon" viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
                {tab.paths}
              </svg>
              <span>{tab.label}</span>
              {tab.route === 'review' && <span className="tab__badge" hidden={unreviewed === 0}>{unreviewed}</span>}
            </a>
          ))}
        </nav>
      </div>

      <AuthOverlay />
      <p className="toast" role="status" hidden={toastState === null} data-kind={toastState?.kind}>
        {toastState?.message}
      </p>
    </>
  );
}

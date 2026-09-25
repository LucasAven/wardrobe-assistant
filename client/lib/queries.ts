import { QueryClient } from '@tanstack/react-query';
import { createApi } from './api.js';
import { authGate } from './authGate.js';
import { readProfile } from './body.js';
import { readOutfit } from './outfits.js';

export const api = createApi({ onUnauthorized: () => authGate.open() });

/**
 * Stale on arrival, which is what the screens this replaces did: every one of
 * them called `load()` from its own mount, so opening a tab asked the server
 * again. Only the two reads that went through the old `ensure()` are cached for
 * the session, and they say so where they are defined.
 *
 * Nothing refetches on its own: no focus, no reconnect, no interval.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

export type Garment = Awaited<ReturnType<typeof api.listGarments>>[number];
export type ProfileData = ReturnType<typeof readProfile>;
/** A SavedOutfit as the card reads it, which is whatever `readOutfit` hands back. */
export type Outfit = NonNullable<ReturnType<typeof readOutfit>>;

export const garmentsKey = ['garments'] as const;
export const profileKey = ['profile'] as const;
/**
 * Every outfit list hangs off this, so one write reaches all of them. Today and
 * the history show the same outfits through the same card, and a swap made on
 * one has to be true on the other.
 */
export const outfitsKey = ['outfits'] as const;
export const todayKey = ['outfits', 'today'] as const;
export const historyKey = (limit: number) => ['outfits', 'list', limit] as const;
export const weatherKey = (lat: number, lon: number) => ['weather', lat, lon] as const;
export const gapsKey = ['gaps'] as const;

/**
 * `gcTime: Infinity` only where a screen is reopened often enough to want its
 * last answer on screen while the refetch runs. On the client default it kept
 * every key the app ever built, including one weather entry per location
 * reading, none of which is read twice.
 */
const KEEP = { gcTime: Infinity } as const;

/**
 * The wardrobe and the profile are the two the old app loaded once a session
 * and refetched only when the user asked, so they keep that. Every screen that
 * changes a garment writes the answer straight into this cache through
 * `upsertGarment` or `removeGarment`, which is what makes one read enough.
 */
export const garmentsQuery = {
  queryKey: garmentsKey,
  queryFn: (): Promise<Garment[]> => api.listGarments(),
  staleTime: Infinity,
  ...KEEP,
};

export const profileQuery = {
  queryKey: profileKey,
  queryFn: (): Promise<ProfileData> => api.getProfile().then(readProfile),
  staleTime: Infinity,
  ...KEEP,
};

export const outfitListOptions = KEEP;

/**
 * A write patches a list the app has read. It never invents one.
 *
 * The wardrobe is cached for the session, so there is no refetch behind it to
 * repair a list this made up. Writing one garment into an entry that holds
 * nothing would install it as the whole wardrobe and pin it there: the grid
 * would read "1 piece", the tab badge would agree with it, and both would
 * disagree with the server until the user tapped Refresh. So a write with
 * nothing to patch marks the entry stale instead and lets the next reader ask.
 *
 * The cancel is the other half. `setQueryData` deliberately leaves a running
 * fetch alone, so a refetch that was already in flight would land afterwards
 * and put the pre-write row back, which for a photo edit means the phone
 * redraws the old picture (`/img` answers `immutable` and the version is in the
 * URL).
 */
function editGarments(edit: (rows: Garment[]) => Garment[]) {
  const rows = queryClient.getQueryData<Garment[]>(garmentsKey);
  if (rows === undefined) {
    void queryClient.invalidateQueries({ queryKey: garmentsKey });
    return;
  }
  void queryClient.cancelQueries({ queryKey: garmentsKey });
  queryClient.setQueryData(garmentsKey, edit(rows));
}

export function upsertGarment(garment: Garment) {
  editGarments((rows) => {
    const at = rows.findIndex((row) => row.id === garment.id);
    return at < 0 ? [garment, ...rows] : rows.map((row) => (row.id === garment.id ? garment : row));
  });
}

export function removeGarment(id: string) {
  editGarments((rows) => rows.filter((row) => row.id !== id));
}

/**
 * The outfit a write handed back, into every list that holds it.
 *
 * The card is given one outfit and does not know which list it came from, so
 * this is what lets it stay a function of its prop. Holding the edit in the
 * card instead made the row above it disagree, and made any re-render of the
 * shell throw the edit away.
 */
export function writeOutfit(next: Outfit) {
  queryClient.setQueriesData<Outfit[]>({ queryKey: outfitsKey }, (rows) =>
    rows === undefined ? undefined : rows.map((row) => (row.id === next.id ? next : row)),
  );
}

export function dropOutfit(id: string) {
  queryClient.setQueriesData<Outfit[]>({ queryKey: outfitsKey }, (rows) =>
    rows === undefined ? undefined : rows.filter((row) => row.id !== id),
  );
}

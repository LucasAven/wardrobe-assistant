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
 * `gcTime: Infinity` keeps the last answer, so a screen reopened shows what it
 * showed before while the refetch is in flight, rather than a spinner. Nothing
 * refetches on its own: no focus, no reconnect, no interval.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: Infinity,
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
export const todayKey = ['outfits', 'today'] as const;
export const outfitsKey = (limit: number) => ['outfits', 'list', limit] as const;
export const weatherKey = (lat: number, lon: number) => ['weather', lat, lon] as const;
export const gapsKey = ['gaps'] as const;
export const reviewKey = (id: string | null) => ['review', id ?? 'queue'] as const;

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
};

export const profileQuery = {
  queryKey: profileKey,
  queryFn: (): Promise<ProfileData> => api.getProfile().then(readProfile),
  staleTime: Infinity,
};

export function readGarments(): Garment[] {
  return queryClient.getQueryData<Garment[]>(garmentsKey) ?? [];
}

export function writeGarments(next: Garment[]) {
  queryClient.setQueryData(garmentsKey, next);
}

export function upsertGarment(garment: Garment) {
  const rows = readGarments();
  const at = rows.findIndex((row) => row.id === garment.id);
  writeGarments(at < 0 ? [garment, ...rows] : rows.map((row) => (row.id === garment.id ? garment : row)));
}

export function removeGarment(id: string) {
  writeGarments(readGarments().filter((row) => row.id !== id));
}

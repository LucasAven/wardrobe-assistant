import { QueryClient } from '@tanstack/react-query';
import { createApi } from './api.js';
import { authGate } from './authGate.js';
import { readProfile } from './body.js';

export const api = createApi({ onUnauthorized: () => authGate.open() });

/**
 * The screens this replaces each loaded once a session and refetched only when
 * the user asked. Nothing here goes stale on its own, so a refetch is always
 * something the app asked for by name.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

export type Garment = Awaited<ReturnType<typeof api.listGarments>>[number];
export type ProfileData = ReturnType<typeof readProfile>;

export const garmentsKey = ['garments'] as const;
export const profileKey = ['profile'] as const;
export const todayKey = ['outfits', 'today'] as const;
export const outfitsKey = (limit: number) => ['outfits', 'list', limit] as const;
export const weatherKey = (lat: number, lon: number) => ['weather', lat, lon] as const;
export const gapsKey = ['gaps'] as const;

export const garmentsQuery = {
  queryKey: garmentsKey,
  queryFn: (): Promise<Garment[]> => api.listGarments(),
};

export const profileQuery = {
  queryKey: profileKey,
  queryFn: (): Promise<ProfileData> => api.getProfile().then(readProfile),
};

export function readGarments(): Garment[] {
  return queryClient.getQueryData<Garment[]>(garmentsKey) ?? [];
}

export function writeGarments(next: Garment[]) {
  queryClient.setQueryData(garmentsKey, next);
}

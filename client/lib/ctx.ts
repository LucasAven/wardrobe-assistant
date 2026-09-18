import { go } from './route.js';
import {
  api,
  garmentsQuery,
  profileKey,
  profileQuery,
  queryClient,
  readGarments,
  removeGarment,
  upsertGarment,
} from './queries.js';
import type { Garment, ProfileData } from './queries.js';
import type { ShellHooks } from './shell.js';
import { isWorn, markWorn } from './worn.js';

const store = {
  get garments(): Garment[] {
    return readGarments();
  },
  refresh: () => queryClient.fetchQuery({ ...garmentsQuery, staleTime: 0 }),
  ensure: () => queryClient.ensureQueryData(garmentsQuery),
  find: (id: string): Garment | null => readGarments().find((row) => row.id === id) ?? null,
  upsert: upsertGarment,
  remove: removeGarment,
};

const profile = {
  get profile(): ProfileData['profile'] {
    return queryClient.getQueryData<ProfileData>(profileKey)?.profile ?? null;
  },
  get suggestedType(): ProfileData['suggestedType'] {
    return queryClient.getQueryData<ProfileData>(profileKey)?.suggestedType ?? null;
  },
  get home(): ProfileData['home'] {
    return queryClient.getQueryData<ProfileData>(profileKey)?.home ?? null;
  },
  refresh: () => queryClient.fetchQuery({ ...profileQuery, staleTime: 0 }),
  ensure: () => queryClient.ensureQueryData(profileQuery),
  set(next: ProfileData) {
    queryClient.setQueryData(profileKey, next);
  },
};

/**
 * What a not yet ported screen is handed. Every read and write goes through the
 * React Query cache, so a screen still running the old code and a React screen
 * reading the same query can never disagree. Delete this file with the last
 * `mount` it serves.
 */
export function createVanillaCtx(shell: ShellHooks) {
  return { api, store, profile, worn: { isWorn, markWorn }, go, ...shell };
}

export type VanillaCtx = ReturnType<typeof createVanillaCtx>;

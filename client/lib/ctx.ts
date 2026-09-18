import { go } from './route.js';
import {
  api,
  garmentsQuery,
  profileKey,
  profileQuery,
  queryClient,
  readGarments,
  writeGarments,
} from './queries.js';
import type { Garment, ProfileData } from './queries.js';

export type ShellHooks = {
  toast: (message: string, kind?: string) => void;
  setTitle: (title: string, meta: string) => void;
  setBack: (hash: string | null) => void;
  onRefresh: (handler: (() => void) | null) => void;
};

/**
 * Which outfits were logged as worn this session. Whether the Worker flips the
 * outfit's own flag is its business, so the tap is remembered here as well and
 * the same day is never offered twice. It is not server state, so it is a plain
 * set rather than a query.
 */
const wornThisSession = new Set<string>();

const store = {
  get garments(): Garment[] {
    return readGarments();
  },
  refresh: () => queryClient.fetchQuery({ ...garmentsQuery, staleTime: 0 }),
  ensure: () => queryClient.ensureQueryData(garmentsQuery),
  find: (id: string): Garment | null => readGarments().find((row) => row.id === id) ?? null,
  upsert(garment: Garment) {
    const rows = readGarments();
    const at = rows.findIndex((row) => row.id === garment.id);
    writeGarments(at < 0 ? [garment, ...rows] : rows.map((row) => (row.id === garment.id ? garment : row)));
  },
  remove(id: string) {
    writeGarments(readGarments().filter((row) => row.id !== id));
  },
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

const worn = {
  isWorn: (id: string) => wornThisSession.has(id),
  markWorn: (id: string) => wornThisSession.add(id),
};

/**
 * What a not yet ported screen is handed. Every read and write goes through the
 * React Query cache, so a screen still running the old code and a React screen
 * reading the same query can never disagree. Delete this file with the last
 * `mount` it serves.
 */
export function createVanillaCtx(shell: ShellHooks) {
  return { api, store, profile, worn, go, ...shell };
}

export type VanillaCtx = ReturnType<typeof createVanillaCtx>;

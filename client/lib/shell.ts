import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';

export type ShellHooks = {
  toast: (message: string, kind?: string) => void;
  setTitle: (title: string, meta: string) => void;
  setBack: (hash: string | null) => void;
  onRefresh: (handler: (() => void) | null) => void;
};

export const ShellContext = createContext<ShellHooks | null>(null);

export function useShell(): ShellHooks {
  const shell = useContext(ShellContext);
  if (shell === null) throw new Error('A screen rendered outside the shell.');
  return shell;
}

/**
 * A message that is dropped once the screen that asked for it has gone.
 *
 * A mutation runs its callbacks from the mutation rather than from the
 * component, so a write started on the profile and finished after the owner
 * moved on popped "Home saved." over Today. What the write does to the cache
 * still runs either way, because that is true wherever the owner is standing.
 *
 * Only for the messages a write sends on success. A write that fails is worth
 * knowing about wherever the owner ended up, so the error toast stays global.
 */
export function useScreenToast() {
  const { toast } = useShell();
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  return useCallback(
    (message: string, kind?: string) => {
      if (live.current) toast(message, kind);
    },
    [toast],
  );
}

/**
 * A read that fails once it has already answered keeps what it drew, and the
 * failure is said in a line rather than in a block over the top of it.
 *
 * React Query keeps `data` through an error, so a screen that gates its error
 * block on `isError` alone renders the error and the content together after a
 * failed Refresh. The old app could not do that: its refresh cleared the body
 * first. The first read failing is still the screen's own empty state, because
 * there is nothing behind it to keep.
 */
export function useRefreshFailure(read: {
  isError: boolean;
  error: Error | null;
  errorUpdatedAt: number;
  data: unknown;
}) {
  const { toast } = useShell();
  // Zero until a read that already had an answer fails, so each distinct
  // failure says so once and a re-render does not repeat it.
  const failedAt = read.isError && read.data !== undefined ? read.errorUpdatedAt : 0;
  const message = read.error === null ? '' : read.error.message;

  useEffect(() => {
    if (failedAt !== 0) toast(message, 'error');
  }, [failedAt, message, toast]);
}

export type ScreenChrome = {
  title: string;
  meta?: string;
  back?: string | null;
  refresh?: (() => void) | null;
};

/**
 * The topbar belongs to the shell and the screen is what knows what goes in it,
 * so every screen sets all of it in one call. Three separate calls would let a
 * screen forget one and inherit the last screen's Back button.
 *
 * Before paint, not after. A passive effect runs once the browser has already
 * drawn, so the first frame of a new screen carried the last one's title, meta
 * and Back target: going from the wardrobe to Add garments showed "Add
 * garments" under a meta still reading "47 pieces".
 */
export function useScreenChrome({ title, meta = '', back = null, refresh = null }: ScreenChrome) {
  const shell = useShell();
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const hasRefresh = refresh !== null;

  useLayoutEffect(() => {
    shell.setTitle(title, meta);
  }, [shell, title, meta]);

  useLayoutEffect(() => {
    shell.setBack(back);
  }, [shell, back]);

  useLayoutEffect(() => {
    shell.onRefresh(hasRefresh ? () => latestRefresh.current?.() : null);
  }, [shell, hasRefresh]);
}

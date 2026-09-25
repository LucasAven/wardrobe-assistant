import { createContext, useContext, useEffect, useRef } from 'react';

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
 */
export function useScreenChrome({ title, meta = '', back = null, refresh = null }: ScreenChrome) {
  const shell = useShell();
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const hasRefresh = refresh !== null;

  useEffect(() => {
    shell.setTitle(title, meta);
  }, [shell, title, meta]);

  useEffect(() => {
    shell.setBack(back);
  }, [shell, back]);

  useEffect(() => {
    shell.onRefresh(hasRefresh ? () => latestRefresh.current?.() : null);
  }, [shell, hasRefresh]);
}

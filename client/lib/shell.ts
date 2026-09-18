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

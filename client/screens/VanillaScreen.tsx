import { useEffect, useMemo, useRef } from 'react';
import { createVanillaCtx } from '../lib/ctx.js';
import type { VanillaCtx } from '../lib/ctx.js';
import type { Route } from '../lib/route.js';
import { useShell } from '../lib/shell.js';

export type MountScreen = (
  ctx: VanillaCtx,
  route: { name: string; id: string | null },
) => { node: Node; destroy?: () => void };

/**
 * Runs a screen that has not been ported yet. It renders the same
 * `main.screen` a ported screen renders, so no wrapper sits between the scroll
 * container and the `.screen__body` whose `min-height` resolves against it.
 */
function VanillaScreen({ mount, route }: { mount: MountScreen; route: Route }) {
  const shell = useShell();
  const ctx = useMemo(() => createVanillaCtx(shell), [shell]);
  const host = useRef<HTMLElement>(null);

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const screen = mount(ctx, { name: route.name, id: route.id });
    parent.append(screen.node);
    return () => {
      screen.destroy?.();
      parent.replaceChildren();
    };
  }, [mount, ctx, route.name, route.id]);

  return <main className="screen" ref={host} />;
}

/** Puts a `mount` behind the same component shape a ported screen has. */
export function vanillaScreen(mount: MountScreen) {
  return function Vanilla({ route }: { route: Route }) {
    return <VanillaScreen mount={mount} route={route} />;
  };
}

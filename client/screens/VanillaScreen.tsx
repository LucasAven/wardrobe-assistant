import { useEffect, useRef } from 'react';
import type { VanillaCtx } from '../lib/ctx.js';
import type { Route } from '../lib/route.js';

export type MountScreen = (
  ctx: VanillaCtx,
  route: { name: string; id: string | null },
) => { node: Node; destroy?: () => void };

/**
 * Runs a screen that has not been ported yet. It renders the same
 * `main.screen` the ported screens render, so no wrapper sits between the
 * scroll container and the `.screen__body` whose `min-height` resolves against
 * it. React keys this on the route, so a route change is a remount.
 */
export function VanillaScreen({ mount, ctx, route }: { mount: MountScreen; ctx: VanillaCtx; route: Route }) {
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

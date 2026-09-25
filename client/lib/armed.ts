import { useEffect, useRef, useState } from 'react';

/**
 * A control that asks twice, for the two places where one tap would be too
 * cheap: archiving a garment, and removing an outfit, which is the only thing
 * in the app that really deletes rows.
 *
 * The first tap arms it and says what the second one does. The arming lapses on
 * its own, so a tap left behind on a screen nobody came back to is not still
 * waiting to delete something.
 *
 * The timer handle is held rather than dropped. The second tap has to cancel
 * it, or a write that fails and re-enables the button gets disarmed mid-retry
 * by a timer from the tap before, which costs the owner both taps again. It is
 * cleared on unmount for the same reason it is held: the card that removes an
 * outfit successfully is the card that goes away.
 */
export function useArmedTap({ ms, onArm, onFire }: { ms: number; onArm: () => void; onFire: () => void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  function tap() {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ms);
      onArm();
      return;
    }
    // Re-armed rather than left armed. A retry after a failed write should
    // still be one tap, but an armed delete with no timer behind it sits there
    // for the rest of the session waiting for a stray tap.
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setArmed(false), ms);
    onFire();
  }

  return { armed, tap };
}

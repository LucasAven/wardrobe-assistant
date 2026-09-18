import { describe, expect, it } from 'vitest';
import { markWorn, subscribeWorn, wornSnapshot } from '../client/lib/worn';

describe('the worn-this-session store', () => {
  it('tells a listener that a wear landed', () => {
    let told = 0;
    const stop = subscribeWorn(() => {
      told += 1;
    });
    markWorn('outfit-a');
    stop();
    expect(told).toBe(1);
  });

  // The history row and the card inside it both read this set, and only one of
  // them re-renders on its own. A wear that does not change identity leaves the
  // other reading the old answer, which is the bug this store replaced.
  it('replaces the set rather than mutating it', () => {
    const before = wornSnapshot();
    markWorn('outfit-b');
    expect(wornSnapshot()).not.toBe(before);
    expect(before.has('outfit-b')).toBe(false);
    expect(wornSnapshot().has('outfit-b')).toBe(true);
  });

  it('stays quiet when the same wear is logged twice', () => {
    markWorn('outfit-c');
    let told = 0;
    const stop = subscribeWorn(() => {
      told += 1;
    });
    markWorn('outfit-c');
    stop();
    expect(told).toBe(0);
  });

  it('drops a listener that stopped', () => {
    let told = 0;
    subscribeWorn(() => {
      told += 1;
    })();
    markWorn('outfit-d');
    expect(told).toBe(0);
  });
});

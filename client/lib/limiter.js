/**
 * Tasks queue on `run` instead of starting there, so picking fifty photos opens
 * at most `limit` connections on a phone radio rather than fifty.
 */
export function createLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }

  const queue = [];
  let active = 0;

  function pump() {
    while (active < limit && queue.length > 0) {
      const start = queue.shift();
      active += 1;
      start();
    }
  }

  function settle(callback) {
    active -= 1;
    pump();
    callback();
  }

  return {
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          let running;
          try {
            running = Promise.resolve(task());
          } catch (error) {
            running = Promise.reject(error);
          }
          running.then(
            (value) => settle(() => resolve(value)),
            (error) => settle(() => reject(error)),
          );
        });
        pump();
      });
    },
  };
}

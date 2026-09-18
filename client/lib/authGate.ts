/**
 * One login prompt for the whole app. Every request that hit the same 401 waits
 * on the promise this hands back, and one successful login resumes all of them.
 * It holds no DOM, so React renders the form and this owns the queue.
 */
let open = false;
let waiting: Array<() => void> = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const authGate = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  isOpen: () => open,
  open(): Promise<void> {
    if (!open) {
      open = true;
      emit();
    }
    return new Promise((resolve) => waiting.push(resolve));
  },
  close() {
    open = false;
    const resume = waiting;
    waiting = [];
    emit();
    for (const done of resume) done();
  },
};

import type { ReactNode } from 'react';

/**
 * The frame every screen draws inside. It was written out by hand in all seven
 * of them, and three kept a private `Body` that was the same two elements.
 *
 * `App` still writes its own for the "Opening." placeholder, which has no
 * `screen__body` and so is not this.
 */
export function Screen({ children, bodyClass = '' }: { children: ReactNode; bodyClass?: string }) {
  return (
    <main className="screen">
      <section className={bodyClass === '' ? 'screen__body' : `screen__body ${bodyClass}`}>{children}</section>
    </main>
  );
}

/** A screen with nothing on it yet, saying why, and sometimes offering a way out. */
export function Empty({ text, action = null }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__text">{text}</p>
      {action}
    </div>
  );
}

export function TryAgain({ onRetry }: { onRetry: () => void }) {
  return (
    <button className="btn btn--primary" type="button" onClick={onRetry}>
      Try again
    </button>
  );
}

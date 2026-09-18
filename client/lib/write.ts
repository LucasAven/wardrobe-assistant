import { useMutation } from '@tanstack/react-query';
import { useShell } from './shell.js';

/** What the api threw, said in the one line a toast has room for. */
export function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A write with its failure already handled. Every screen was repeating the same
 * three things around one api call: a boolean for "a write is in flight", a
 * catch that toasts whatever came back, and a finally that puts the boolean
 * down again. That is what a mutation already is, so this is one with the toast
 * wired in and `isPending` in place of the boolean.
 *
 * `onDone` runs only when the write succeeded, which is where the cache write
 * and whatever the screen does next belong. Pass `onFailed` only when a screen
 * has to do something besides say so.
 */
export function useWrite<TResult, TInput = void>({
  run,
  onDone,
  onFailed,
}: {
  run: (input: TInput) => Promise<TResult>;
  onDone?: (result: TResult, input: TInput) => void;
  onFailed?: (error: Error) => void;
}) {
  const { toast } = useShell();
  return useMutation<TResult, Error, TInput>({
    mutationFn: run,
    ...(onDone === undefined ? {} : { onSuccess: onDone }),
    onError: (error) => {
      if (onFailed !== undefined) onFailed(error);
      else toast(said(error), 'error');
    },
  });
}

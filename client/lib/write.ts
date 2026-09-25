import { useMutation } from '@tanstack/react-query';
import type { UseMutationOptions } from '@tanstack/react-query';
import { useShell } from './shell.js';

/** What the api threw, in the one line there is room to show. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `useMutation` with the shell toast already wired to `onError`. Every screen
 * was repeating the same three things around one api call: a boolean for "a
 * write is in flight", a catch that toasts whatever came back, and a finally
 * that puts the boolean down again. Only the toast is worth wrapping, so the
 * options stay React Query's own rather than a second vocabulary to translate.
 *
 * A caller that passes its own `onError` replaces the toast instead of adding
 * to it, so one that still wants it said has to say it.
 */
export function useWrite<TResult, TInput = void>(options: UseMutationOptions<TResult, Error, TInput>) {
  const { toast } = useShell();
  return useMutation<TResult, Error, TInput>({
    onError: (error) => toast(errorMessage(error), 'error'),
    ...options,
  });
}

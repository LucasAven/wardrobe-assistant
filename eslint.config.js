import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The rules that pay for themselves on this codebase, and no more.
 *
 * `react-hooks` is why this file exists. The React port's review found a hook
 * below an early return, a `setState` during a render, and several deliberate
 * gaps in a dependency array, and all three are what these rules catch.
 *
 * `lint` passes `--max-warnings 0`, because `exhaustive-deps` is a warning in
 * the recommended set and a warning nothing fails on is a rule nobody reads. So
 * a gap that is on purpose has to say so in a disable comment with a reason.
 *
 * These rules see what they can trace. `set-state-in-effect` catches the toast
 * in `App.tsx` and not the same shape in `shell.ts`, where the setter arrives
 * through context, so a clean run is not a proof that the pattern is absent.
 *
 * `client/lib/*.js` is linted for the same hook and correctness rules as
 * everything else, but it is still not type-checked: `tsconfig.client.json`
 * sets `allowJs` without `checkJs` on purpose, because `test/ui.selftest.mjs`
 * imports those files under plain node with no transform.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    rules: {
      /**
       * `_` marks a binding that exists to be skipped. The rest-sibling case is
       * the common one in the tests, where a row is destructured to prove a
       * column is absent from what the wire carries.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['client/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**'],
    // The Worker runtime, which is neither node nor a browser but shares the
    // fetch and stream globals with both.
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
  {
    files: ['scripts/**', 'test/**', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
);

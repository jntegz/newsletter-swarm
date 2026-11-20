import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Secrets and bindings must come from the validated env (see @swarm/runtime defineEnv).
// A `??`/`||` fallback on `env.X` is how the legacy code shipped public dev secrets to production.
// Matched however the env object is named (`env`, `e`, `apiEnv`, `c.env`, `this.env`), and any
// UPPER_SNAKE property defaulted to a literal, which is what an env value looks like.
const FALLBACK = 'LogicalExpression[operator=/^(\\?\\?|\\|\\|)$/]';
const ENV_KEY = '/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/';
const envFallback = (selector) => ({
  selector,
  message: 'Do not default env values inline. Declare them in the worker env schema instead.',
});
const noEnvFallback = [
  envFallback(`${FALLBACK} > MemberExpression.left[object.name=/^(env|.+Env)$/]`),
  envFallback(`${FALLBACK} > MemberExpression.left[object.property.name='env']`),
  envFallback(`${FALLBACK} > MemberExpression.left[object.name='e'][property.name=${ENV_KEY}]`),
  envFallback(
    `${FALLBACK}[right.type=/^(Literal|TemplateLiteral)$/] > MemberExpression.left[property.name=${ENV_KEY}]:not([object.name=/^(e|env|.+Env)$/]):not([object.property.name='env'])`,
  ),
];

// FIELD_KEYS authority (docs/security.md "The vault"): only the vault opens or seals a value. Its
// primitives (engine fields.ts, which the vault runs) and the vault's own operations may be
// imported by packages/vault and workers/vault only. Callers reach them through their VAULT
// binding (@swarm/vault); their tests seed legacy values with @swarm/vault/testing, which no
// worker's src may import.
const SEALING = ['encrypt', 'decrypt', 'encryptFor', 'decryptFor', 'sealV3', 'openV3'];
const VAULT_ONLY_NAMES = [...SEALING, 'toStored', 'fromStored', 'macFor'];
const vaultOnly = (extra = []) => ({
  paths: [
    {
      name: '@swarm/engine',
      importNames: VAULT_ONLY_NAMES,
      message:
        'Only the vault opens or seals values (FIELD_KEYS). Use the vault through the VAULT binding (@swarm/vault).',
    },
    {
      name: '@swarm/vault/core',
      message: 'The vault’s operations run in workers/vault (and its test fake) only.',
    },
    ...extra,
  ],
  patterns: [
    {
      group: ['**/engine/src/fields', '**/engine/src/fields.ts', '**/vault/src/core/**'],
      message: 'Only the vault opens or seals values (FIELD_KEYS).',
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'research-do-not-commit/**',
      '.claude/**',
      'design/**',
      '**/worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Package imports (node:, cloudflare:, npm and @swarm/*) come first, then relative imports, as
    // one block. Order within each group is left to the author: route and handler lists are
    // usually grouped by feature, not alphabetically.
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { 'import-x': importX },
    rules: {
      'import-x/first': 'error',
      'import-x/order': [
        'error',
        {
          groups: [
            ['builtin', 'external', 'internal', 'unknown'],
            ['parent', 'sibling', 'index'],
          ],
          'newlines-between': 'never',
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-restricted-syntax': ['error', ...noEnvFallback],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/vault/**', 'workers/vault/**', 'packages/engine/**'],
    rules: { 'no-restricted-imports': ['error', vaultOnly()] },
  },
  {
    // Runtime code may not even take the test fixtures.
    files: ['**/src/**/*.{ts,tsx}'],
    ignores: ['packages/vault/**', 'workers/vault/**', 'packages/engine/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        vaultOnly([
          {
            name: '@swarm/vault/testing',
            message: 'Test fixtures only: runtime code reaches the vault through its binding.',
          },
        ]),
      ],
    },
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    files: ['**/*.{js,mjs}', '**/*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },
);

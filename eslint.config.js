import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/', 'coverage/'],
  },
  {
    // Everything in this package — src, tests, fixtures, config — runs as Node. TypeScript
    // files lint clean without this because typescript-eslint turns `no-undef` off in favour of
    // the compiler's own check; plain JS/MJS files (the fake host stub, this config) have no
    // such backstop, so `no-undef` needs Node's globals declared explicitly.
    languageOptions: {
      globals: globals.node,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // src/reviewer-tools.ts is loaded by path into a foreign (reviewer) process, outside this
    // package's own runtime. Its dependency footprint must stay minimal, so it may import
    // nothing but Node builtins — no runtime deps, no sibling src modules with their own
    // dependency chains. Enforced structurally rather than left as a convention.
    files: ['src/reviewer-tools.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Gitignore-style: restrict everything, then un-restrict the node: builtins.
              group: ['*', '!node:*'],
              message:
                'src/reviewer-tools.ts loads inside a foreign reviewer process and may only import Node builtins (node:*).',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
];

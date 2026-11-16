import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'coverage/**'] },
  { linterOptions: { noInlineConfig: true } },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts}'],
    plugins: {
      local: {
        rules: {
          'no-comments': {
            meta: {
              type: 'problem',
              schema: [],
              messages: { forbidden: '代码中不允许出现注释。' },
            },
            create(context) {
              return {
                Program() {
                  for (const comment of context.sourceCode.getAllComments()) {
                    if (comment.type !== 'Shebang') {
                      context.report({ loc: comment.loc, messageId: 'forbidden' });
                    }
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'local/no-comments': 'error',
      'max-lines': ['error', { max: 500 }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['packages/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['test/probe.ts'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: false }],
    },
  },
);

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
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
    rules: { 'local/no-comments': 'error' },
  },
);

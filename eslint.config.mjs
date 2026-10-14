import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.scratch/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': hooks, boundaries },
    settings: {
      'boundaries/elements': ['shared', 'records', 'desktop', 'renderer'].map(
        (type) => ({ type, pattern: `app/${type}/**` }),
      ),
      'import/resolver': { typescript: { project: './tsconfig.json' } },
    },
    rules: {
      ...hooks.configs.flat.recommended.rules,
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { element: { type: 'shared' } },
              allow: { to: { element: { types: { anyOf: ['shared'] } } } },
            },
            {
              from: { element: { type: 'records' } },
              allow: {
                to: { element: { types: { anyOf: ['shared', 'records'] } } },
              },
            },
            {
              from: { element: { type: 'desktop' } },
              allow: {
                to: { element: { types: { anyOf: ['shared', 'desktop'] } } },
              },
            },
            {
              from: { element: { type: 'renderer' } },
              allow: {
                to: { element: { types: { anyOf: ['shared', 'renderer'] } } },
              },
            },
          ],
        },
      ],
    },
  },
);

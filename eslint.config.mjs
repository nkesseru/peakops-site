import next from 'eslint-config-next';

export default [
  // Next.js flat config (includes TypeScript, React, etc.)
  next(),

  // Project-specific tweaks
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts'
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'import/no-anonymous-default-export': 'off',
      '@next/next/no-html-link-for-pages': 'off'
    }
  }
];

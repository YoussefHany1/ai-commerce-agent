// ESLint 9 flat config. Replaces `.eslintrc.json` + `next lint`, which Next 16
// removed. The two presets map to what the old config extended.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'next-env.d.ts',
      // Standalone output is a build artifact, not source.
      'dist/**',
    ],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;

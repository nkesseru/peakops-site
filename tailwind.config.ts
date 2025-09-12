import type { Config } from 'tailwindcss';

const config: Config = {
  // Use class strategy for dark mode (works with next-themes)
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: 'var(--ink)',
        graphite: 'var(--graphite)',
        teal: 'var(--teal)',
        gold: 'var(--gold)',
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
        },
      },
      borderRadius: {
        xl: '24px',
        lg: '12px',
      },
      boxShadow: {
        soft: 'var(--shadow)',
      },
    },
  },
  plugins: [],
};

export default config;

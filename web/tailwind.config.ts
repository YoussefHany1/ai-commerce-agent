import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Cairo',
          'Tahoma',
          'sans-serif',
        ],
      },
      colors: {
        bg: {
          depth: '#0A0A0F',
        },
        surface: {
          DEFAULT: '#111118',
          elevated: '#1A1A24',
          sidebar: '#0D0D14',
        },
        accent: {
          violet: '#7C3AED',
          light: '#9D6FF5',
          cyan: '#06B6D4',
        },
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
        muted: '#94A3B8',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(0,0,0,0.05), 0 1px 3px 0 rgba(0,0,0,0.04)',
        glow: '0 0 0 1px rgba(124,58,237,0.35), 0 10px 40px -10px rgba(124,58,237,0.45)',
        'glow-cyan': '0 0 0 1px rgba(6,182,212,0.3), 0 10px 40px -10px rgba(6,182,212,0.35)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'float-in': {
          '0%': { opacity: '0', transform: 'translateY(4px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.8s infinite',
        'fade-in-up': 'fade-in-up 0.4s ease-out both',
        'fade-in': 'fade-in 0.25s ease-out both',
        'scale-in': 'scale-in 0.18s ease-out both',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
        float: 'float-in 0.2s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
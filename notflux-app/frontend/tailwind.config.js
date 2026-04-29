/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0d0d0d',
          surface: '#1a1a1a',
          card: '#242424',
          overlay: 'rgba(0,0,0,0.7)',
        },
        accent: {
          DEFAULT: '#6C47FF',
          light: '#9270ff',
          dark: '#4f34cc',
        },
        ping: {
          blue: '#1B6AFF',
          purple: '#6C47FF',
        },
        text: {
          primary: '#ffffff',
          secondary: '#a3a3a3',
          muted: '#5c5c5c',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'slide-in': 'slideIn 0.25s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'pulse-dot': 'pulseDot 1.4s infinite',
        'shimmer': 'shimmer 2s infinite linear',
        'spin': 'spin 1s linear infinite',
      },
      keyframes: {
        slideIn: {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%, 80%, 100%': { transform: 'scale(0)', opacity: '0.2' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
      },
    },
  },
  plugins: [],
};

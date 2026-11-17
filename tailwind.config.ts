import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#070A0F',
          900: '#0A0E14',
          850: '#0D131B',
          800: '#111721',
          750: '#151D29',
          700: '#1A2230',
          600: '#222C3D',
          500: '#2C3849'
        },
        fg: {
          hi: '#E8EEF7',
          mid: '#8A99AD',
          lo: '#5A6678'
        },
        accent: {
          cyan: '#22D3EE',
          violet: '#7C6BFF',
          teal: '#2DD4BF'
        },
        state: {
          ok: '#34D399',
          warn: '#FBBF24',
          danger: '#F87171',
          info: '#60A5FA'
        }
      },
      fontFamily: {
        sans: ['PingFang SC', 'Helvetica Neue', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'JetBrains Mono', 'Menlo', 'monospace']
      },
      fontSize: {
        display: ['26px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        title: ['15px', { lineHeight: '22px' }],
        body: ['13px', { lineHeight: '20px' }],
        caption: ['11px', { lineHeight: '16px' }]
      },
      boxShadow: {
        glass: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 40px -24px rgba(0,0,0,0.9)',
        glow: '0 0 0 1px rgba(34,211,238,0.28), 0 0 28px -6px rgba(34,211,238,0.35)'
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(circle at 20% 0%, rgba(124,107,255,0.12), transparent 45%), radial-gradient(circle at 85% 10%, rgba(34,211,238,0.10), transparent 40%)'
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '0.35', transform: 'scaleX(0.85)' },
          '50%': { opacity: '1', transform: 'scaleX(1)' }
        },
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(34,211,238,0.45)' },
          '70%': { boxShadow: '0 0 0 6px rgba(34,211,238,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(34,211,238,0)' }
        },
        rise: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' }
        }
      },
      animation: {
        breathe: 'breathe 2.4s ease-in-out infinite',
        pulseRing: 'pulseRing 2s ease-out infinite',
        rise: 'rise 180ms ease-out both',
        shimmer: 'shimmer 1.6s infinite'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}

export default config

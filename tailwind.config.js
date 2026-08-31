/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        edition: {
          gold: '#C5A880',
          darkGold: '#A58B62',
          black: '#1A1A1A',
          charcoal: '#2E2E2E',
          cream: '#FAF8F5',
          950: '#0a0b0d',
        }
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', 'serif'],
      }
    },
  },
  plugins: [],
}

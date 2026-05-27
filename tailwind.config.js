/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./App.tsx",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        trail: '#1890ff',
        safe: '#52c41a',
        warning: '#faad14',
        danger: '#ff4d4f',
        dark: '#1a1a1a',
        muted: '#888888',
      },
    },
  },
  plugins: [],
};

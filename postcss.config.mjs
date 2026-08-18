// Tailwind v4 ships as a PostCSS plugin rather than a config-file-driven
// build step; `src/app/globals.css` carries the whole design system in CSS
// (`@theme`), so there is deliberately no `tailwind.config.js` here.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;

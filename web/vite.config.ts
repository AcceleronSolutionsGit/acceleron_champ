import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Base path.
 *
 * The PM2 deployment serves the console under /acceleron_champ/ (nginx alias),
 * so that stays the default. Vercel serves it at the domain root, so a Vercel
 * build defaults to '/' on its own — VERCEL is set in every Vercel build.
 *
 * This is deliberately not left to an environment variable someone must
 * remember: getting it wrong bakes /acceleron_champ/assets/... into index.html,
 * those files don't exist at that path, the SPA rewrite answers with index.html,
 * and the browser rejects the HTML as a module script. The result is a blank
 * page with one console error and no server-side sign of trouble.
 *
 * VITE_BASE_PATH still overrides both, for a deployment under some other prefix.
 *
 * BASE_URL flows through to the router basename (web/src/App.tsx) and the API
 * base (web/src/api.ts), so this single switch moves the whole app.
 */
const base = process.env.VITE_BASE_PATH || (process.env.VERCEL ? '/' : '/acceleron_champ/')

// Dev: Vite serves the SPA on :5173 and proxies API + webhook calls to the
// application service on :8081. Production: `vite build` emits web/dist, which
// Vercel serves statically (or the server serves as static files under PM2 —
// see server/src/app.ts).
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/acceleron_champ/api': {
        target: 'http://localhost:8081',
        rewrite: (p) => p.replace(/^\/acceleron_champ/, ''),
      },
      '/acceleron_champ/webhook': {
        target: 'http://localhost:8081',
        rewrite: (p) => p.replace(/^\/acceleron_champ/, ''),
      },
      '/api': 'http://localhost:8081',
      '/webhook': 'http://localhost:8081',
    },
  },
})

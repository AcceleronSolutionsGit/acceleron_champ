import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Base path.
 *
 * The PM2 deployment serves the console under /acceleron_champ/ (nginx alias),
 * so that stays the default. Vercel serves it at the domain root, so the Vercel
 * project sets VITE_BASE_PATH=/ in its environment variables.
 *
 * BASE_URL flows through to the router basename (web/src/App.tsx) and the API
 * base (web/src/api.ts), so this single switch moves the whole app.
 */
const base = process.env.VITE_BASE_PATH || '/acceleron_champ/'

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

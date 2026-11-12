import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE: where the app is served. "/Kyra-UI-V1/" matches the KYRA backend (it serves the build there)
// and GitHub Pages. KYRA_BACKEND: where `npm run dev` sends /api (default the backend on port 3000), so
// the dev server and the backend look like one site: no CORS, and the camera preview can be read.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backend = env.KYRA_BACKEND || "http://localhost:3000";
  return {
    plugins: [react()],
    base: env.VITE_BASE || "/Kyra-UI-V1/",
    server: {
      proxy: {
        "/api": { target: backend, changeOrigin: true },
        "/looks": { target: backend, changeOrigin: true },
      },
    },
  };
});

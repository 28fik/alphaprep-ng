import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    // During `npm run dev`, forward /api calls to a local Pages dev server
    proxy: { "/api": "http://localhost:8788" },
  },
});

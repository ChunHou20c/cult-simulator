import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // src/update.ts registers the worker and decides when to reload.
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Cult Simulator",
        short_name: "Cults",
        description: "One shared world a day.",
        theme_color: "#16130f",
        background_color: "#16130f",
        display: "standalone",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      workbox: {
        // Take over the first visit right away so its models and music get cached.
        clientsClaim: true,
        // App shell is precached; packs are cached by their hashed URL forever.
        globPatterns: ["**/*.{js,css,html,svg}"],
        // config.js is per-deployment runtime config, never precached.
        globIgnores: ["packs/**", "config.js"],
        runtimeCaching: [
          {
            // 3D models: fetched on first 3D visit, then served offline.
            urlPattern: ({ url }) => url.pathname.startsWith("/models/"),
            handler: "CacheFirst",
            options: { cacheName: "models", expiration: { maxEntries: 20 } },
          },
          {
            // Background music: each track is fetched when first heard, then served offline.
            urlPattern: ({ url }) => url.pathname.startsWith("/music/"),
            handler: "CacheFirst",
            options: { cacheName: "music", expiration: { maxEntries: 10 }, rangeRequests: true },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/packs/"),
            handler: "CacheFirst",
            options: { cacheName: "packs", expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
  server: { host: true },
});

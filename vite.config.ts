import { defineConfig, type Plugin } from "vite";

/**
 * Every build gets an id: compiled into the page as __BUILD__ and written to dist/build.txt
 * for the server. The page sends it with every action, and the server refuses actions from
 * any other build (an open page from before an update), which then reloads.
 */
const BUILD = Date.now().toString(36);
const buildId = (): Plugin => ({
  name: "build-id",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "build.txt", source: BUILD });
  },
});

// Relative base so the build works from any static host path (e.g. GitHub Pages).
export default defineConfig({ base: "./", define: { __BUILD__: JSON.stringify(BUILD) }, plugins: [buildId()] });

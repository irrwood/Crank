import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react()],
  build: {
    outDir: "dist/assets",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, "src/main.tsx"),
      name: "CrankCodexWidget",
      formats: ["iife"],
      fileName: () => "widget.js"
    },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});

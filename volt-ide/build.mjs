/**
 * Volt IDE build script — builds Monaco workers separately from main app
 */
import * as esbuild from "esbuild";

// Build 1: Monaco editor worker (IIFE format, separate file)
await esbuild.build({
    entryPoints: {
        "editor.worker": "node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
    },
    bundle: true,
    format: "iife",
    outdir: "src/dist/workers",
    minify: true,
    loader: { ".ttf": "file", ".css": "empty" },
});

// Build 2: Main app (ESM)
await esbuild.build({
    entryPoints: ["src/js/app.js"],
    bundle: true,
    format: "esm",
    outfile: "src/dist/app.js",
    minify: true,
    loader: { ".ttf": "dataurl" },
});

console.log("Build complete");

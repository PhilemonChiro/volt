import * as esbuild from "esbuild";

await esbuild.build({
    entryPoints: ["src/js/app.js"],
    bundle: true,
    format: "esm",
    outfile: "src/dist/app.js",
    minify: true,
    loader: { ".ttf": "dataurl" },
});

console.log("Build complete");

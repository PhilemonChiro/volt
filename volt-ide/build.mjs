// Simple copy — Monaco is loaded via AMD, not bundled
import { copyFileSync, mkdirSync } from "fs";
mkdirSync("src/dist", { recursive: true });
copyFileSync("src/js/app.js", "src/dist/app.js");
console.log("Build complete");

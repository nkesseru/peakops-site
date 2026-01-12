const esbuild = require("esbuild");

esbuild.buildSync({
  entryPoints: ["index.mjs"],
  outfile: "index.js",
  platform: "node",
  format: "cjs",
  target: ["node20"],
  bundle: true,
  sourcemap: false,
  logLevel: "info",
});

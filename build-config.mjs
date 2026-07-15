// Generates public/config.js from Netlify env vars, so the GMAPS key is NOT in git.
// Runs as the Netlify build command (see netlify.toml).
import { writeFileSync } from "node:fs";

const key = process.env.GMAPS_KEY || "";
const id = process.env.GMAPS_ID || "";

writeFileSync(
  "public/config.js",
  `window.GMAPS_KEY=${JSON.stringify(key)};window.GMAPS_ID=${JSON.stringify(id)};\n`
);

console.log(`config.js written (GMAPS_KEY ${key ? "set" : "EMPTY"}, GMAPS_ID ${id ? "set" : "empty"})`);

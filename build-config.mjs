// Genereert public/config.js uit Netlify-env-vars, zodat de GMAPS-sleutel NIET in git staat.
// Draait als Netlify build-command (zie netlify.toml).
import { writeFileSync } from "node:fs";

const key = process.env.GMAPS_KEY || "";
const id = process.env.GMAPS_ID || "";

writeFileSync(
  "public/config.js",
  `window.GMAPS_KEY=${JSON.stringify(key)};window.GMAPS_ID=${JSON.stringify(id)};\n`
);

console.log(`config.js geschreven (GMAPS_KEY ${key ? "gezet" : "LEEG"}, GMAPS_ID ${id ? "gezet" : "leeg"})`);

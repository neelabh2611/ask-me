import path from "node:path";
import fs from "node:fs";
const PUB = new URL("../public/", import.meta.url).pathname;
console.log("PUB:", JSON.stringify(PUB));
const fp = path.normalize(path.join(PUB, "/index.html"));
console.log("fp:", JSON.stringify(fp));
console.log("starts:", fp.startsWith(PUB), "exists:", fs.existsSync(fp));

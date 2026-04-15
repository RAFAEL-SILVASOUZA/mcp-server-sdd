import { readFileSync, writeFileSync, copyFileSync } from "fs";

// Copy dashboard HTML to dist (cross-platform replacement for `cp`)
copyFileSync("src/dashboard.html", "dist/dashboard.html");
console.log("Copied dashboard.html to dist/");

// Add shebang to dist/index.js
const file = "dist/index.js";
const content = readFileSync(file, "utf8");

if (!content.startsWith("#!/")) {
  writeFileSync(file, "#!/usr/bin/env node\n" + content);
  console.log("Shebang added to dist/index.js");
}

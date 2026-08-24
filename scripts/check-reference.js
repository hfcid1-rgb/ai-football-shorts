import fs from "node:fs";
import path from "node:path";
import settings from "../config/settings.json" with { type: "json" };

const refPath = path.resolve(process.cwd(), settings.referenceImagePath);

if (!fs.existsSync(refPath)) {
  console.error(
    [
      "",
      "ERROR: Reference image not found.",
      `Expected file at: ${settings.referenceImagePath}`,
      "",
      "Upload your character image to assets/reference/character.png",
      "before running this workflow. No Runway credits were used.",
      "",
    ].join("\n")
  );
  process.exit(1);
}

const stats = fs.statSync(refPath);
if (stats.size === 0) {
  console.error(`ERROR: ${settings.referenceImagePath} exists but is empty (0 bytes).`);
  process.exit(1);
}

console.log(`OK: reference image found (${(stats.size / 1024).toFixed(1)} KB).`);

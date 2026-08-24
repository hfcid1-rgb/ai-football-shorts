/**
 * Runway image-to-video generation.
 *
 * IMPORTANT: Runway's API surface evolves. This script targets the official
 * @runwayml/sdk (imageToVideo.create -> waitForTaskOutput, async task polling
 * under the hood, "X-Runway-Version" handled internally by the SDK). If Runway
 * has changed method names/parameters since this was written, check
 * https://docs.dev.runwayml.com/ before running FULL mode.
 *
 * Modes:
 *   --mode=test  -> generates exactly ONE short clip (default, cheap)
 *   --mode=full  -> generates the entire scene sequence (expensive, must be
 *                   explicitly requested via the workflow_dispatch input)
 */

import fs from "node:fs";
import path from "node:path";
import RunwayML, { TaskFailedError } from "@runwayml/sdk";
import settings from "../config/settings.json" with { type: "json" };
import scenes from "../prompts/scenes.json" with { type: "json" };

function parseMode() {
  const arg = process.argv.find((a) => a.startsWith("--mode="));
  const mode = (arg ? arg.split("=")[1] : process.env.GENERATION_MODE || "test").toLowerCase();
  if (mode !== "test" && mode !== "full") {
    console.error(`ERROR: invalid mode "${mode}". Use --mode=test or --mode=full.`);
    process.exit(1);
  }
  return mode;
}

function requireApiKey() {
  const key = process.env.RUNWAYML_API_SECRET;
  if (!key) {
    console.error(
      [
        "",
        "ERROR: RUNWAYML_API_SECRET is not set.",
        "In GitHub Actions this must come from:",
        "  ${{ secrets.RUNWAYML_API_SECRET }}",
        "Never hardcode this value in source or logs.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
  return key;
}

function requireReferenceImage() {
  const refPath = path.resolve(process.cwd(), settings.referenceImagePath);
  if (!fs.existsSync(refPath)) {
    console.error(`ERROR: reference image missing at ${settings.referenceImagePath}`);
    process.exit(1);
  }
  return refPath;
}

function imageToDataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function buildScenePrompt(scene) {
  const style = scenes.globalStyle;
  return { promptText: `${scene.prompt}. ${style}` };
}

async function generateClip(client, referenceDataUri, scene, outDir) {
  const { promptText } = buildScenePrompt(scene);
  console.log(`\n--- Generating: ${scene.id} (${scene.camera}) ---`);

  let task;
  try {
    task = await client.imageToVideo
      .create({
        model: settings.runway.model,
        promptImage: referenceDataUri,
        promptText,
        ratio: settings.runway.ratio,
        duration: scene.durationSeconds ?? settings.runway.clipDurationSeconds,
        contentModeration: { publicFigureThreshold: "auto" },
      })
      .waitForTaskOutput({ timeout: settings.runway.pollTimeoutMs });
  } catch (err) {
    if (err instanceof TaskFailedError) {
      console.error(`FAILED: ${scene.id} - Runway task failed: ${err.taskDetails?.failure ?? err.message}`);
    } else {
      console.error(`FAILED: ${scene.id} - ${err.message ?? err}`);
    }
    throw err;
  }

  const videoUrl = task.output?.[0];
  if (!videoUrl) {
    throw new Error(`No output URL returned for scene ${scene.id}`);
  }

  const res = await fetch(videoUrl);
  if (!res.ok) {
    throw new Error(`Download failed for ${scene.id}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${String(scene.order ?? 0).padStart(2, "0")}_${scene.id}.mp4`);
  fs.writeFileSync(outPath, buf);
  console.log(`OK: saved ${outPath}`);
  return outPath;
}

async function main() {
  const mode = parseMode();
  const apiKey = requireApiKey();
  const refPath = requireReferenceImage();
  const referenceDataUri = imageToDataUri(refPath);

  const client = new RunwayML({ apiKey });
  const outDir = path.resolve(process.cwd(), settings.output.rawClipsDir);

  console.log(`Mode: ${mode.toUpperCase()}`);

  if (mode === "test") {
    const scene = { ...scenes.testMode, order: 0 };
    await generateClip(client, referenceDataUri, scene, outDir);
    console.log("\nTEST MODE complete. Review the clip before running FULL mode.");
    return;
  }

  // FULL mode: sequential generation, bounded by fullMode.maxClips as a hard cap.
  const sequence = scenes.fullSequence.slice(0, settings.fullMode.maxClips);
  console.log(`FULL MODE: generating ${sequence.length} clips sequentially.`);

  const results = [];
  for (const scene of sequence) {
    try {
      const outPath = await generateClip(client, referenceDataUri, scene, outDir);
      results.push(outPath);
    } catch (err) {
      console.error(`\nFULL MODE aborted at scene "${scene.id}" to avoid wasting further credits.`);
      console.error(String(err.message ?? err));
      process.exit(1);
    }
  }

  console.log(`\nFULL MODE complete: ${results.length}/${sequence.length} clips generated.`);
}

main().catch((err) => {
  console.error("Unhandled error during generation:", err.message ?? err);
  process.exit(1);
});

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

// Hard limits for downloading generated clips from the network.
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB per clip
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Downloads a generated clip defensively: HTTPS only, no redirects to
 * other protocols, bounded time and size, and a sanity check that the
 * response really is a video. Untrusted network data never gets more
 * than MAX_DOWNLOAD_BYTES of disk/memory.
 */
async function downloadVideo(videoUrl, label) {
  let url;
  try {
    url = new URL(videoUrl);
  } catch {
    throw new Error(`Invalid output URL for ${label}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS download for ${label} (${url.protocol})`);
  }

  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Download failed for ${label}: HTTP ${res.status}`);
  }
  if (new URL(res.url).protocol !== "https:") {
    throw new Error(`Download for ${label} was redirected to a non-HTTPS URL`);
  }

  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type && !type.startsWith("video/") && !type.startsWith("application/octet-stream")) {
    throw new Error(`Unexpected content-type for ${label}: ${type}`);
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Clip for ${label} is too large (${declared} bytes)`);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Clip for ${label} exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

  const buf = await downloadVideo(videoUrl, scene.id);

  fs.mkdirSync(outDir, { recursive: true });
  // Scene ids end up in a file path; strip anything that could escape outDir.
  const safeId = String(scene.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const outPath = path.join(outDir, `${String(scene.order ?? 0).padStart(2, "0")}_${safeId}.mp4`);
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

/**
 * FFmpeg post-production pipeline.
 *
 * Takes whatever raw clips exist in output/raw/ (produced by generate.js,
 * either 1 test clip or the full sequence), and produces a single vertical
 * 1080x1920 H.264/AAC MP4 in output/final/.
 *
 * Requires the `ffmpeg` binary to be available on PATH (installed as a
 * separate GitHub Actions step).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import settings from "../config/settings.json" with { type: "json" };

const RAW_DIR = path.resolve(process.cwd(), settings.output.rawClipsDir);
const PROCESSED_DIR = path.resolve(process.cwd(), "output/processed");
const FINAL_DIR = path.resolve(process.cwd(), settings.output.finalDir);
const { width, height, fps } = settings.output;

function run(args, label) {
  console.log(`\n$ ffmpeg ${args.join(" ")}`);
  try {
    execFileSync("ffmpeg", args, { stdio: "inherit" });
  } catch (err) {
    throw new Error(`FFmpeg step failed (${label}): ${err.message}`);
  }
}

function ensureFfmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    console.error("ERROR: ffmpeg is not installed or not on PATH.");
    process.exit(1);
  }
}

function listRawClips() {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs
    .readdirSync(RAW_DIR)
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .sort() // filenames are zero-padded with scene order, e.g. 01_scene_...
    .map((f) => path.join(RAW_DIR, f));
}

function normalizeClip(inputPath, index, isSlowMoScene) {
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  const outPath = path.join(PROCESSED_DIR, `norm_${String(index).padStart(2, "0")}.mp4`);

  // Scale to cover 1080x1920, center-crop, fixed fps, fade in/out, optional
  // gentle slow-motion for the dramatic strike shot, subtle zoom-in ("Ken Burns").
  const speedFilter = isSlowMoScene ? "setpts=1.6*PTS," : "";
  const vf =
    `${speedFilter}` +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
    `zoompan=z='min(zoom+0.0007,1.06)':d=1:s=${width}x${height},` +
    `fps=${fps},` +
    `fade=t=in:st=0:d=0.25,fade=t=out:st=999:d=0.25`; // fade-out timing fixed below

  run(
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      vf.replace("st=999", `st=${isSlowMoScene ? 7.5 : 4.5}`),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    `normalize ${path.basename(inputPath)}`
  );

  return outPath;
}

function concatClips(processedPaths) {
  fs.mkdirSync(FINAL_DIR, { recursive: true });
  const listFile = path.join(PROCESSED_DIR, "concat_list.txt");
  fs.writeFileSync(
    listFile,
    processedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );

  const concatOut = path.join(PROCESSED_DIR, "concat_silent.mp4");
  run(
    ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatOut],
    "concat clips"
  );
  return concatOut;
}

function buildDrawtextFilters() {
  return settings.overlays
    .map((o) => {
      const y =
        o.position === "top" ? "h*0.08" : o.position === "bottom" ? "h*0.85" : "(h-text_h)/2";
      const escaped = o.text.replace(/:/g, "\\:").replace(/'/g, "\\'");
      const start = o.start;
      const end = o.start + o.duration;
      return (
        `drawtext=text='${escaped}':fontcolor=white:fontsize=64:` +
        `borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=${y}:` +
        `enable='between(t,${start},${end})':alpha='if(lt(t,${start + 0.3}),(t-${start})/0.3,if(gt(t,${end - 0.3}),(${end}-t)/0.3,1))'`
      );
    })
    .join(",");
}

function overlayTextAndAudio(concatSilentPath) {
  const drawtext = buildDrawtextFilters();
  const audioPath = path.resolve(process.cwd(), settings.audio.optionalTrackPath);
  const hasAudio = fs.existsSync(audioPath);
  const finalOut = path.join(FINAL_DIR, settings.output.finalFilename);

  const args = ["-y", "-i", concatSilentPath];
  if (hasAudio) args.push("-i", audioPath);

  const videoFilter = drawtext ? drawtext : "null";
  args.push("-vf", videoFilter);

  if (hasAudio) {
    args.push(
      "-filter:a",
      `loudnorm=I=${settings.audio.targetLoudnessLUFS}:TP=-1.5:LRA=11`,
      "-shortest"
    );
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p"
  );

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  args.push(finalOut);
  run(args, "overlay text + audio + final encode");

  console.log(hasAudio ? "Audio track found and mixed in." : "No optional audio track found — final video will be silent (this is expected, not an error).");
  return finalOut;
}

function main() {
  ensureFfmpegAvailable();

  const rawClips = listRawClips();
  if (rawClips.length === 0) {
    console.error(`ERROR: no clips found in ${settings.output.rawClipsDir}. Run generation first.`);
    process.exit(1);
  }
  console.log(`Found ${rawClips.length} raw clip(s) to process.`);

  const processed = rawClips.map((clipPath, i) => {
    const isSlowMo = clipPath.includes("slowmo_strike");
    return normalizeClip(clipPath, i, isSlowMo);
  });

  const concatSilent = concatClips(processed);
  const finalPath = overlayTextAndAudio(concatSilent);

  console.log(`\nDONE. Final video: ${finalPath}`);
}

main();

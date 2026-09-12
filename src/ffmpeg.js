const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const FONTS_DIR = path.join(__dirname, "..", "assets", "fonts");
const FONT_FAMILY = "DejaVu Sans";

// ffmpeg-static не собран с фильтром drawtext, поэтому текст накладывается
// через subtitles(libass): генерируем .srt на всю длительность ролика.
function escapeSrtText(text) {
  return String(text).replace(/\r?\n/g, " ").trim();
}

// Экранирование пути для встраивания в значение опции фильтра ffmpeg.
function escapeFilterPath(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

const ALIGNMENT_BY_POSITION = { top: 8, center: 5, bottom: 2 };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

async function probeDuration(filePath) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`ffprobe exited with code ${code}\n${err}`));
    });
  });
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Не удалось определить длительность файла: ${filePath}`);
  }
  return duration;
}

async function probeHasAudio(filePath) {
  const args = [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    filePath,
  ];
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(out));
  });
  return stdout.trim().length > 0;
}

/**
 * Склеивает список видеофайлов в один с плавными переходами (crossfade).
 * @param {string[]} inputFiles - пути к клипам в нужном порядке
 * @param {string} outputFile - путь для результата
 * @param {number} transitionDuration - длительность перехода в секундах
 */
async function mergeWithCrossfade(inputFiles, outputFile, transitionDuration = 0.5) {
  if (inputFiles.length < 1) {
    throw new Error("Нужен хотя бы один клип");
  }
  if (inputFiles.length === 1) {
    await run(ffmpegPath, ["-y", "-i", inputFiles[0], "-c", "copy", outputFile]);
    return;
  }

  const durations = [];
  const hasAudioFlags = [];
  for (const f of inputFiles) {
    durations.push(await probeDuration(f));
    hasAudioFlags.push(await probeHasAudio(f));
  }
  const allHaveAudio = hasAudioFlags.every(Boolean);

  // Переход не может быть длиннее самого короткого клипа
  const shortest = Math.min(...durations);
  const d = Math.min(transitionDuration, Math.max(0.1, shortest / 2));

  const inputArgs = [];
  inputFiles.forEach((f) => {
    inputArgs.push("-i", f);
  });

  const filterParts = [];
  let cumulative = durations[0];
  let lastVideoLabel = "0:v";
  let lastAudioLabel = "0:a";

  for (let i = 1; i < inputFiles.length; i++) {
    const offset = cumulative - d;
    const outV = `v${i}`;
    filterParts.push(
      `[${lastVideoLabel}][${i}:v]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`
    );
    lastVideoLabel = outV;

    if (allHaveAudio) {
      const outA = `a${i}`;
      filterParts.push(
        `[${lastAudioLabel}][${i}:a]acrossfade=d=${d.toFixed(3)}[${outA}]`
      );
      lastAudioLabel = outA;
    }

    cumulative = cumulative + durations[i] - d;
  }

  const filterComplex = filterParts.join(";");

  const mapArgs = ["-map", `[${lastVideoLabel}]`];
  if (allHaveAudio) {
    mapArgs.push("-map", `[${lastAudioLabel}]`);
  } else {
    mapArgs.push("-an");
  }

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex", filterComplex,
    ...mapArgs,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
  ];
  if (allHaveAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push(outputFile);

  await run(ffmpegPath, args);
}

/**
 * Обрезает видео до заданной длительности (в секундах).
 */
async function trimToDuration(input, output, seconds) {
  const hasAudio = await probeHasAudio(input);
  const args = [
    "-y",
    "-i", input,
    "-t", String(seconds),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
  ];
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push(output);
  await run(ffmpegPath, args);
}

/**
 * Накладывает текст на видео.
 * @param {{content: string, position?: "top"|"center"|"bottom"}} textConfig
 */
async function applyTextOverlay(input, output, textConfig) {
  const hasAudio = await probeHasAudio(input);
  const { content, position = "bottom" } = textConfig;
  const alignment = ALIGNMENT_BY_POSITION[position] || ALIGNMENT_BY_POSITION.bottom;

  const srtPath = `${output}.srt`;
  const srtContent = [
    "1",
    "00:00:00,000 --> 99:59:59,000",
    escapeSrtText(content),
    "",
  ].join("\n");
  fs.writeFileSync(srtPath, srtContent, "utf8");

  const forceStyle = [
    `FontName=${FONT_FAMILY}`,
    "FontSize=28",
    "PrimaryColour=&H00FFFFFF",
    "BorderStyle=3",
    "BackColour=&H80000000",
    "Outline=0",
    "Shadow=0",
    `Alignment=${alignment}`,
    "MarginV=40",
  ].join(",");

  const subtitlesFilter =
    `subtitles='${escapeFilterPath(srtPath)}':fontsdir='${escapeFilterPath(FONTS_DIR)}':` +
    `force_style='${forceStyle}'`;

  const args = [
    "-y",
    "-i", input,
    "-vf", subtitlesFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
  ];
  if (hasAudio) args.push("-c:a", "copy");
  else args.push("-an");
  args.push(output);

  try {
    await run(ffmpegPath, args);
  } finally {
    fs.rmSync(srtPath, { force: true });
  }
}

/**
 * Накладывает фоновую музыку на видео (с приглушением, если у видео уже есть звук).
 */
async function mixMusic(videoInput, musicInput, outputFile, { volume = 0.25 } = {}) {
  const hasOriginalAudio = await probeHasAudio(videoInput);

  const args = ["-y", "-i", videoInput, "-stream_loop", "-1", "-i", musicInput];
  let filter;
  if (hasOriginalAudio) {
    filter =
      `[1:a]volume=${volume}[music];` +
      `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
  } else {
    filter = `[1:a]volume=${volume}[aout]`;
  }
  args.push(
    "-filter_complex", filter,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputFile
  );
  await run(ffmpegPath, args);
}

module.exports = {
  mergeWithCrossfade,
  trimToDuration,
  applyTextOverlay,
  mixMusic,
  probeDuration,
  probeHasAudio,
};

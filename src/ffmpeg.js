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
 * Размер кадра так, как его показывает плеер (с учётом поворота из метаданных:
 * ffmpeg при декодировании сам разворачивает такие клипы).
 */
async function probeVideoSize(filePath) {
  const args = ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", filePath];
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
  const stream = (JSON.parse(stdout).streams || [])[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error(`В файле нет видеодорожки: ${filePath}`);
  }
  const sideData = (stream.side_data_list || []).find((s) => s.rotation !== undefined);
  const rotation = Number(sideData ? sideData.rotation : (stream.tags || {}).rotate) || 0;
  const rotated = Math.abs(rotation) % 180 === 90;
  return rotated
    ? { width: stream.height, height: stream.width }
    : { width: stream.width, height: stream.height };
}

const OUTPUT_FPS = 30;
const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/**
 * Склеивает список видеофайлов в один с плавными переходами (crossfade).
 * Клипы могут быть разного размера и частоты кадров: все приводятся к размеру
 * первого клипа (с чёрными полями) и к OUTPUT_FPS, иначе xfade не работает.
 * Клипы без звука получают тишину, чтобы не терять звук остальных.
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
  const sizes = [];
  for (const f of inputFiles) {
    sizes.push(await probeVideoSize(f)); // заодно отсекает файлы без видео
    durations.push(await probeDuration(f));
    hasAudioFlags.push(await probeHasAudio(f));
  }
  const withAudio = hasAudioFlags.some(Boolean);

  // Итоговый кадр — по первому клипу; libx264 с yuv420p требует чётных сторон
  const first = sizes[0];
  const width = first.width - (first.width % 2);
  const height = first.height - (first.height % 2);

  // Переход не может быть длиннее самого короткого клипа
  const shortest = Math.min(...durations);
  const d = Math.min(transitionDuration, Math.max(0.1, shortest / 2));

  const inputArgs = [];
  inputFiles.forEach((f) => {
    inputArgs.push("-i", f);
  });

  const filterParts = [];
  inputFiles.forEach((f, i) => {
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${OUTPUT_FPS},format=yuv420p[nv${i}]`
    );
    if (withAudio) {
      // Звук подгоняем ровно под длительность клипа, чтобы не копился рассинхрон
      const dur = durations[i].toFixed(3);
      const source = hasAudioFlags[i] ? `[${i}:a]${AUDIO_FORMAT},apad` : `anullsrc=r=48000:cl=stereo,${AUDIO_FORMAT}`;
      filterParts.push(`${source},atrim=end=${dur},asetpts=PTS-STARTPTS[na${i}]`);
    }
  });

  let cumulative = durations[0];
  let lastVideoLabel = "nv0";
  let lastAudioLabel = "na0";

  for (let i = 1; i < inputFiles.length; i++) {
    const offset = cumulative - d;
    const outV = `v${i}`;
    filterParts.push(
      `[${lastVideoLabel}][nv${i}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`
    );
    lastVideoLabel = outV;

    if (withAudio) {
      const outA = `a${i}`;
      filterParts.push(
        `[${lastAudioLabel}][na${i}]acrossfade=d=${d.toFixed(3)}[${outA}]`
      );
      lastAudioLabel = outA;
    }

    cumulative = cumulative + durations[i] - d;
  }

  const filterComplex = filterParts.join(";");

  const mapArgs = ["-map", `[${lastVideoLabel}]`];
  if (withAudio) {
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
  if (withAudio) {
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
  probeVideoSize,
};

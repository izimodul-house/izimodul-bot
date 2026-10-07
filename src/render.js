const path = require("path");
const { mergeWithCrossfade, trimToDuration, applyTextOverlay, mixMusic } = require("./ffmpeg");

/**
 * Полный цикл сборки ролика: склейка с crossfade → текст → обрезка → музыка.
 * Промежуточные файлы кладёт в workDir.
 * @param {string[]} clips - пути к клипам в нужном порядке
 * @param {string} workDir - папка для промежуточных файлов
 * @param {{transition?: number, text?: {content: string, position?: string}|null,
 *          durationLimit?: number|null, musicPath?: string|null}} options
 * @returns {Promise<string>} путь к готовому ролику
 */
async function renderClips(clips, workDir, { transition = 0.5, text = null, durationLimit = null, musicPath = null } = {}) {
  let current = path.join(workDir, "01_merged.mp4");
  await mergeWithCrossfade(clips, current, transition);

  if (text) {
    const next = path.join(workDir, "02_text.mp4");
    await applyTextOverlay(current, next, text);
    current = next;
  }

  if (durationLimit) {
    const next = path.join(workDir, "03_trimmed.mp4");
    await trimToDuration(current, next, durationLimit);
    current = next;
  }

  if (musicPath) {
    const next = path.join(workDir, "04_music.mp4");
    await mixMusic(current, musicPath, next);
    current = next;
  }

  return current;
}

module.exports = { renderClips };

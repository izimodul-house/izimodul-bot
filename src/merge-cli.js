// Склейка клипов с компьютера без Telegram — тем же движком, что и у бота.
// Пример: npm run merge -- clip1.mp4 clip2.mp4 clip3.mp4 -o result.mp4
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs } = require("util");
const { renderClips } = require("./render");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"]);
const TEXT_POSITIONS = ["top", "center", "bottom"];
// npm run запускает скрипт из папки проекта; исходная папка пользователя — в INIT_CWD
const BASE_DIR = process.env.INIT_CWD || process.cwd();

const USAGE = `Склейка нескольких клипов в один ролик с плавными переходами.

Использование:
  npm run merge -- <клип или папка> [ещё клипы...] [опции]

Клипы склеиваются в том порядке, в котором перечислены. Если указана папка,
берутся все видео из неё, отсортированные по имени (1.mp4, 2.mp4, ..., 10.mp4).

Опции:
  -o, --output <файл>        куда сохранить результат (по умолчанию merged.mp4)
  -t, --transition <сек>     длительность перехода, по умолчанию 0.5
      --text <текст>         наложить текст на весь ролик
      --text-position <поз>  top | center | bottom (по умолчанию bottom)
      --duration <сек>       обрезать итоговый ролик до этой длительности
      --music <файл>         фоновая музыка (приглушается под звук клипов)
  -h, --help                 эта справка`;

function fail(message) {
  console.error(`Ошибка: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

function parsePositiveNumber(value, name) {
  const parsed = parseFloat(String(value).replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} должно быть положительным числом, получено «${value}»`);
  return parsed;
}

function collectClips(inputs) {
  const clips = [];
  for (const input of inputs) {
    const resolved = path.resolve(BASE_DIR, input);
    if (!fs.existsSync(resolved)) fail(`файл или папка не найдены: ${input}`);
    if (fs.statSync(resolved).isDirectory()) {
      const files = fs
        .readdirSync(resolved)
        .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((name) => path.join(resolved, name));
      if (files.length === 0) fail(`в папке нет видеофайлов: ${input}`);
      clips.push(...files);
    } else {
      clips.push(resolved);
    }
  }
  return clips;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o", default: "merged.mp4" },
        transition: { type: "string", short: "t", default: "0.5" },
        text: { type: "string" },
        "text-position": { type: "string", default: "bottom" },
        duration: { type: "string" },
        music: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const clips = collectClips(positionals);
  if (clips.length < 2) fail("нужно минимум 2 клипа для склейки");

  const transition = parsePositiveNumber(values.transition, "--transition");
  if (transition >= 5) fail("--transition должен быть меньше 5 секунд");

  let text = null;
  if (values.text !== undefined) {
    if (!TEXT_POSITIONS.includes(values["text-position"])) {
      fail(`--text-position должен быть одним из: ${TEXT_POSITIONS.join(", ")}`);
    }
    if (values.text.trim()) text = { content: values.text, position: values["text-position"] };
  }

  const durationLimit = values.duration !== undefined ? parsePositiveNumber(values.duration, "--duration") : null;

  let musicPath = null;
  if (values.music !== undefined) {
    musicPath = path.resolve(BASE_DIR, values.music);
    if (!fs.existsSync(musicPath)) fail(`файл с музыкой не найден: ${values.music}`);
  }

  const output = path.resolve(BASE_DIR, values.output);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "izimodul-merge-"));

  console.log(`Склеиваю ${clips.length} клип(ов):`);
  clips.forEach((clip, i) => console.log(`  ${i + 1}. ${clip}`));

  try {
    const result = await renderClips(clips, workDir, { transition, text, durationLimit, musicPath });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(result, output);
    console.log(`\nГотово: ${output}`);
  } catch (err) {
    console.error(`\nНе получилось склеить видео:\n${err.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();

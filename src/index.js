require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Bot, InputFile } = require("grammy");
const {
  getOrCreateSession,
  resetSession,
  clearSession,
  getSettings,
  updateSettings,
  getSettingsDir,
} = require("./sessions");
const { mergeWithCrossfade, trimToDuration, applyTextOverlay, mixMusic } = require("./ffmpeg");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен бота.");
  process.exit(1);
}

const bot = new Bot(token);

const DEFAULT_TRANSITION = 0.5;
const MAX_CLIPS = 30;
const MAX_OUTPUT_DURATION = 180; // сек, разумный потолок для итогового ролика
const MAX_TEXT_LENGTH = 200;

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Привет! Я склею твои короткие ролики в один мультик с плавными переходами.",
      "",
      "Как пользоваться:",
      "1. /new — начать новую склейку",
      "2. Присылай видео по одному, в нужном порядке",
      "3. При желании настрой ролик (см. ниже)",
      "4. /render — я склею их и пришлю результат",
      "",
      "Настройки (сохраняются между подборками):",
      "/duration 15 — ограничить длину итогового ролика 15 секундами (/duration off — снять ограничение)",
      "/text Привет мир! — наложить текст на видео (/text off — убрать; /text top|center|bottom Привет — задать положение)",
      "/music — в ответ на аудио/голосовое сообщение задаст фоновую музыку (/music off — убрать)",
      "/settings — показать текущие настройки",
      "",
      "Другие команды:",
      "/render 0.8 — задать длительность перехода между клипами в секундах (по умолчанию 0.5)",
      "/list — сколько клипов уже добавлено",
      "/cancel — очистить текущую подборку клипов (настройки не трогает)",
    ].join("\n")
  );
});

bot.command("settings", async (ctx) => {
  const s = getSettings(ctx.chat.id);
  await ctx.reply(
    [
      "Текущие настройки:",
      `— Длительность ролика: ${s.durationLimit ? `${s.durationLimit} сек` : "без ограничения"}`,
      `— Текст: ${s.text ? `"${s.text.content}" (${s.text.position})` : "нет"}`,
      `— Музыка: ${s.musicPath ? "добавлена" : "нет"}`,
    ].join("\n")
  );
});

bot.command("duration", async (ctx) => {
  const arg = ctx.match ? ctx.match.trim() : "";
  if (!arg || arg.toLowerCase() === "off") {
    updateSettings(ctx.chat.id, { durationLimit: null });
    await ctx.reply("Ограничение длительности снято.");
    return;
  }
  const seconds = parseFloat(arg.replace(",", "."));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_OUTPUT_DURATION) {
    await ctx.reply(`Укажи число секунд от 1 до ${MAX_OUTPUT_DURATION}, например: /duration 15`);
    return;
  }
  updateSettings(ctx.chat.id, { durationLimit: seconds });
  await ctx.reply(`Готово: итоговый ролик будет обрезан до ${seconds} сек.`);
});

bot.command("text", async (ctx) => {
  const arg = ctx.match ? ctx.match.trim() : "";
  if (!arg || arg.toLowerCase() === "off") {
    updateSettings(ctx.chat.id, { text: null });
    await ctx.reply("Текст на видео убран.");
    return;
  }

  let position = "bottom";
  let content = arg;
  const match = arg.match(/^(top|center|bottom)\s+(.+)$/i);
  if (match) {
    position = match[1].toLowerCase();
    content = match[2];
  }

  if (content.length > MAX_TEXT_LENGTH) {
    await ctx.reply(`Текст слишком длинный (максимум ${MAX_TEXT_LENGTH} символов).`);
    return;
  }

  updateSettings(ctx.chat.id, { text: { content, position } });
  await ctx.reply(`Текст задан: "${content}" (позиция: ${position}).`);
});

bot.command("music", async (ctx) => {
  const arg = ctx.match ? ctx.match.trim().toLowerCase() : "";
  if (arg === "off") {
    const s = getSettings(ctx.chat.id);
    if (s.musicPath) fs.rmSync(s.musicPath, { force: true });
    updateSettings(ctx.chat.id, { musicPath: null });
    await ctx.reply("Фоновая музыка убрана.");
    return;
  }

  const replySource =
    ctx.message.reply_to_message?.audio ||
    ctx.message.reply_to_message?.voice ||
    ctx.message.reply_to_message?.document;

  if (!replySource) {
    await ctx.reply(
      "Пришли аудиофайл или голосовое сообщение и ответь на него командой /music (или /music off, чтобы убрать музыку)."
    );
    return;
  }

  try {
    const settingsDir = getSettingsDir(ctx.chat.id);
    const file = await ctx.api.getFile(replySource.file_id);
    const ext = path.extname(file.file_path || "") || ".mp3";
    const localPath = path.join(settingsDir, `music${ext}`);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const s = getSettings(ctx.chat.id);
    if (s.musicPath) fs.rmSync(s.musicPath, { force: true });

    fs.writeFileSync(localPath, buffer);
    updateSettings(ctx.chat.id, { musicPath: localPath });
    await ctx.reply("Фоновая музыка сохранена. Она будет наложена на итоговый ролик.");
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать аудиофайл, попробуй ещё раз.");
  }
});

bot.command("new", async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply("Новая подборка начата. Присылай видео по одному в нужном порядке.");
});

bot.command("cancel", async (ctx) => {
  clearSession(ctx.chat.id);
  await ctx.reply("Подборка очищена.");
});

bot.command("list", async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  await ctx.reply(`В подборке ${session.clips.length} клип(ов).`);
});

async function downloadClip(ctx, fileId, ext) {
  const session = getOrCreateSession(ctx.chat.id);
  const file = await ctx.api.getFile(fileId);
  const localPath = path.join(session.dir, `clip_${session.clips.length}${ext}`);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  session.clips.push(localPath);
  return session;
}

bot.on("message:video", async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  if (session.clips.length >= MAX_CLIPS) {
    await ctx.reply(`Достигнут лимит в ${MAX_CLIPS} клипов. Отправь /render, чтобы собрать ролик.`);
    return;
  }
  try {
    const updated = await downloadClip(ctx, ctx.message.video.file_id, ".mp4");
    await ctx.reply(`Добавлено (${updated.clips.length}). Присылай следующий клип или отправь /render.`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать это видео, попробуй ещё раз.");
  }
});

bot.on("message:video_note", async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  if (session.clips.length >= MAX_CLIPS) {
    await ctx.reply(`Достигнут лимит в ${MAX_CLIPS} клипов. Отправь /render, чтобы собрать ролик.`);
    return;
  }
  try {
    const updated = await downloadClip(ctx, ctx.message.video_note.file_id, ".mp4");
    await ctx.reply(`Добавлено (${updated.clips.length}). Присылай следующий клип или отправь /render.`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать это видео, попробуй ещё раз.");
  }
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type || !doc.mime_type.startsWith("video/")) return;
  const session = getOrCreateSession(ctx.chat.id);
  if (session.clips.length >= MAX_CLIPS) {
    await ctx.reply(`Достигнут лимит в ${MAX_CLIPS} клипов. Отправь /render, чтобы собрать ролик.`);
    return;
  }
  try {
    const ext = path.extname(doc.file_name || "") || ".mp4";
    const updated = await downloadClip(ctx, doc.file_id, ext);
    await ctx.reply(`Добавлено (${updated.clips.length}). Присылай следующий клип или отправь /render.`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать этот файл, попробуй ещё раз.");
  }
});

bot.command("render", async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  if (session.clips.length < 2) {
    await ctx.reply("Нужно минимум 2 клипа, чтобы сделать склейку с переходами. Пришли ещё видео.");
    return;
  }

  const arg = ctx.match ? ctx.match.trim() : "";
  let transition = DEFAULT_TRANSITION;
  if (arg) {
    const parsed = parseFloat(arg.replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 5) {
      transition = parsed;
    } else {
      await ctx.reply("Не понял длительность перехода, использую значение по умолчанию 0.5 сек.");
    }
  }

  const statusMsg = await ctx.reply("Склеиваю ролики, подожди немного...");
  const settings = getSettings(ctx.chat.id);

  try {
    let current = path.join(session.dir, "01_merged.mp4");
    await mergeWithCrossfade(session.clips, current, transition);

    if (settings.text) {
      const next = path.join(session.dir, "02_text.mp4");
      await applyTextOverlay(current, next, settings.text);
      current = next;
    }

    if (settings.durationLimit) {
      const next = path.join(session.dir, "03_trimmed.mp4");
      await trimToDuration(current, next, settings.durationLimit);
      current = next;
    }

    if (settings.musicPath) {
      const next = path.join(session.dir, "04_music.mp4");
      await mixMusic(current, settings.musicPath, next);
      current = next;
    }

    await ctx.replyWithVideo(new InputFile(current), {
      caption: "Готово! Вот твой мультик 🎬",
    });
    clearSession(ctx.chat.id);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не получилось склеить видео. Попробуй ещё раз или пришли клипы заново с /new.");
  } finally {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch {
      // сообщение уже могло быть удалено — не критично
    }
  }
});

bot.catch((err) => {
  console.error("Ошибка бота:", err);
});

bot.start();
console.log("Бот запущен.");

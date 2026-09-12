require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Bot, InputFile } = require("grammy");
const { getOrCreateSession, resetSession, clearSession } = require("./sessions");
const { mergeWithCrossfade } = require("./ffmpeg");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен бота.");
  process.exit(1);
}

const bot = new Bot(token);

const DEFAULT_TRANSITION = 0.5;
const MAX_CLIPS = 30;

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Привет! Я склею твои короткие ролики в один мультик с плавными переходами.",
      "",
      "Как пользоваться:",
      "1. /new — начать новую склейку",
      "2. Присылай видео по одному, в нужном порядке",
      "3. /render — я склею их с крос­сфейдом и пришлю результат",
      "",
      "Другие команды:",
      "/render 0.8 — задать длительность перехода в секундах (по умолчанию 0.5)",
      "/list — сколько клипов уже добавлено",
      "/cancel — очистить текущую подборку",
    ].join("\n")
  );
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
  const outputFile = path.join(session.dir, "output.mp4");

  try {
    await mergeWithCrossfade(session.clips, outputFile, transition);
    await ctx.replyWithVideo(new InputFile(outputFile), {
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

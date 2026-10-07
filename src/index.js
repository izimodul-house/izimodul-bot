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
  setPendingInput,
  getPendingInput,
  clearPendingInput,
} = require("./sessions");
const { renderClips } = require("./render");
const {
  mainMenuText,
  mainMenuKeyboard,
  durationMenuKeyboard,
  textMenuKeyboard,
  musicMenuKeyboard,
  musicMenuText,
} = require("./menu");

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

async function showMainMenu(ctx) {
  const session = getOrCreateSession(ctx.chat.id);
  const settings = getSettings(ctx.chat.id);
  await ctx.reply(mainMenuText(settings, session.clips.length), {
    reply_markup: mainMenuKeyboard(settings, session.clips.length),
  });
}

async function editToMainMenu(ctx) {
  const session = getOrCreateSession(ctx.chat.id);
  const settings = getSettings(ctx.chat.id);
  await ctx.editMessageText(mainMenuText(settings, session.clips.length), {
    reply_markup: mainMenuKeyboard(settings, session.clips.length),
  });
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Привет! Я склею твои короткие ролики в один мультик с плавными переходами.",
      "",
      "Как пользоваться:",
      "1. /new — начать новую склейку",
      "2. Присылай видео по одному, в нужном порядке",
      "3. /menu — настроить длительность, текст и музыку кнопками",
      "4. Собери ролик кнопкой «Собрать ролик» в меню (или командой /render)",
      "",
      "/list — сколько клипов уже добавлено",
      "/cancel — очистить текущую подборку клипов (настройки не трогает)",
    ].join("\n")
  );
  await showMainMenu(ctx);
});

bot.command(["menu", "settings"], async (ctx) => {
  await showMainMenu(ctx);
});

async function renderVideo(ctx, transition = DEFAULT_TRANSITION) {
  const session = getOrCreateSession(ctx.chat.id);
  if (session.clips.length < 2) {
    await ctx.reply("Нужно минимум 2 клипа, чтобы сделать склейку с переходами. Пришли ещё видео.");
    return;
  }

  const statusMsg = await ctx.reply("Склеиваю ролики, подожди немного...");
  const settings = getSettings(ctx.chat.id);

  try {
    const result = await renderClips(session.clips, session.dir, {
      transition,
      text: settings.text,
      durationLimit: settings.durationLimit,
      musicPath: settings.musicPath,
    });

    await ctx.replyWithVideo(new InputFile(result), {
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
}

bot.command("render", async (ctx) => {
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
  await renderVideo(ctx, transition);
});

bot.command("new", async (ctx) => {
  resetSession(ctx.chat.id);
  clearPendingInput(ctx.chat.id);
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

  await saveMusicFromMessage(ctx, replySource);
});

async function saveMusicFromMessage(ctx, mediaSource) {
  try {
    const settingsDir = getSettingsDir(ctx.chat.id);
    const file = await ctx.api.getFile(mediaSource.file_id);
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
    await showMainMenu(ctx);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать аудиофайл, попробуй ещё раз.");
  }
}

// Если пользователь присылает аудио/голосовое сообщение без ответа на /music,
// но перед этим нажал в меню «Музыка» — тоже принимаем его как фоновую музыку.
bot.on(["message:audio", "message:voice"], async (ctx) => {
  const pending = getPendingInput(ctx.chat.id);
  if (!pending || pending.type !== "music") return;
  clearPendingInput(ctx.chat.id);
  const media = ctx.message.audio || ctx.message.voice;
  await saveMusicFromMessage(ctx, media);
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
    await ctx.reply(`Достигнут лимит в ${MAX_CLIPS} клипов. Собери ролик через /menu или /render.`);
    return;
  }
  try {
    const updated = await downloadClip(ctx, ctx.message.video.file_id, ".mp4");
    await ctx.reply(`Добавлено (${updated.clips.length}). Присылай следующий клип, настрой /menu или отправь /render.`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать это видео, попробуй ещё раз.");
  }
});

bot.on("message:video_note", async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  if (session.clips.length >= MAX_CLIPS) {
    await ctx.reply(`Достигнут лимит в ${MAX_CLIPS} клипов. Собери ролик через /menu или /render.`);
    return;
  }
  try {
    const updated = await downloadClip(ctx, ctx.message.video_note.file_id, ".mp4");
    await ctx.reply(`Добавлено (${updated.clips.length}). Присылай следующий клип, настрой /menu или отправь /render.`);
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
    await ctx.reply(`Достигнут лимит в ${MAX_CLIPS} клипов. Собери ролик через /menu или /render.`);
    return;
  }
  try {
    const ext = path.extname(doc.file_name || "") || ".mp4";
    const updated = await downloadClip(ctx, doc.file_id, ext);
    await ctx.reply(`Добавлено (${updated.clips.length}). Присылай следующий клип, настрой /menu или отправь /render.`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось скачать этот файл, попробуй ещё раз.");
  }
});

// Обработка свободного текста, введённого после нажатия кнопок меню.
bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return; // команды обрабатываются отдельно

  const pending = getPendingInput(ctx.chat.id);
  if (!pending) return;

  if (pending.type === "duration") {
    const seconds = parseFloat(ctx.message.text.trim().replace(",", "."));
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_OUTPUT_DURATION) {
      await ctx.reply(`Укажи число секунд от 1 до ${MAX_OUTPUT_DURATION}.`);
      return;
    }
    clearPendingInput(ctx.chat.id);
    updateSettings(ctx.chat.id, { durationLimit: seconds });
    await ctx.reply(`Готово: итоговый ролик будет обрезан до ${seconds} сек.`);
    await showMainMenu(ctx);
    return;
  }

  if (pending.type === "text") {
    const content = ctx.message.text.trim();
    if (content.length > MAX_TEXT_LENGTH) {
      await ctx.reply(`Текст слишком длинный (максимум ${MAX_TEXT_LENGTH} символов).`);
      return;
    }
    clearPendingInput(ctx.chat.id);
    const position = getSettings(ctx.chat.id).textDraftPosition || "bottom";
    updateSettings(ctx.chat.id, { text: { content, position } });
    await ctx.reply(`Текст задан: "${content}".`);
    await showMainMenu(ctx);
    return;
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

  try {
    if (data === "menu:main") {
      await ctx.answerCallbackQuery();
      await editToMainMenu(ctx);
      return;
    }

    if (data === "menu:duration") {
      await ctx.answerCallbackQuery();
      const settings = getSettings(chatId);
      await ctx.editMessageText("Выбери длительность итогового ролика:", {
        reply_markup: durationMenuKeyboard(settings),
      });
      return;
    }

    if (data.startsWith("duration:set:")) {
      const seconds = parseInt(data.split(":")[2], 10);
      updateSettings(chatId, { durationLimit: seconds });
      await ctx.answerCallbackQuery({ text: `Установлено: ${seconds} сек` });
      await ctx.editMessageText("Выбери длительность итогового ролика:", {
        reply_markup: durationMenuKeyboard(getSettings(chatId)),
      });
      return;
    }

    if (data === "duration:off") {
      updateSettings(chatId, { durationLimit: null });
      await ctx.answerCallbackQuery({ text: "Ограничение снято" });
      await ctx.editMessageText("Выбери длительность итогового ролика:", {
        reply_markup: durationMenuKeyboard(getSettings(chatId)),
      });
      return;
    }

    if (data === "duration:custom") {
      setPendingInput(chatId, { type: "duration" });
      await ctx.answerCallbackQuery();
      await ctx.reply(`Пришли число секунд (от 1 до ${MAX_OUTPUT_DURATION}).`);
      return;
    }

    if (data === "menu:text") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Настройка текста на видео:", {
        reply_markup: textMenuKeyboard(getSettings(chatId)),
      });
      return;
    }

    if (data.startsWith("text:pos:")) {
      const position = data.split(":")[2];
      const settings = getSettings(chatId);
      const patch = { textDraftPosition: position };
      if (settings.text) patch.text = { ...settings.text, position };
      updateSettings(chatId, patch);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Настройка текста на видео:", {
        reply_markup: textMenuKeyboard(getSettings(chatId)),
      });
      return;
    }

    if (data === "text:input") {
      setPendingInput(chatId, { type: "text" });
      await ctx.answerCallbackQuery();
      await ctx.reply(`Пришли текст для наложения на видео (максимум ${MAX_TEXT_LENGTH} символов).`);
      return;
    }

    if (data === "text:off") {
      updateSettings(chatId, { text: null });
      await ctx.answerCallbackQuery({ text: "Текст убран" });
      await ctx.editMessageText("Настройка текста на видео:", {
        reply_markup: textMenuKeyboard(getSettings(chatId)),
      });
      return;
    }

    if (data === "menu:music") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(musicMenuText, { reply_markup: musicMenuKeyboard(getSettings(chatId)) });
      return;
    }

    if (data === "music:off") {
      const s = getSettings(chatId);
      if (s.musicPath) fs.rmSync(s.musicPath, { force: true });
      updateSettings(chatId, { musicPath: null });
      await ctx.answerCallbackQuery({ text: "Музыка убрана" });
      await ctx.editMessageText(musicMenuText, { reply_markup: musicMenuKeyboard(getSettings(chatId)) });
      return;
    }

    if (data === "menu:new") {
      resetSession(chatId);
      clearPendingInput(chatId);
      await ctx.answerCallbackQuery({ text: "Подборка очищена" });
      await editToMainMenu(ctx);
      return;
    }

    if (data === "menu:render") {
      await ctx.answerCallbackQuery();
      await renderVideo(ctx);
      return;
    }

    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error(err);
    try {
      await ctx.answerCallbackQuery({ text: "Что-то пошло не так" });
    } catch {
      // игнорируем — колбэк мог уже устареть
    }
  }
});

bot.catch((err) => {
  console.error("Ошибка бота:", err);
});

bot.start();
console.log("Бот запущен.");

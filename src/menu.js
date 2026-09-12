const { InlineKeyboard } = require("grammy");

const DURATION_PRESETS = [10, 15, 30, 60];
const POSITION_LABELS = { top: "Верх", center: "Центр", bottom: "Низ" };

function formatDuration(settings) {
  return settings.durationLimit ? `${settings.durationLimit} сек` : "не задана";
}

function formatText(settings) {
  if (!settings.text) return "не задан";
  const short =
    settings.text.content.length > 20
      ? `${settings.text.content.slice(0, 20)}…`
      : settings.text.content;
  return `«${short}»`;
}

function formatMusic(settings) {
  return settings.musicPath ? "добавлена" : "нет";
}

function mainMenuText(settings, clipsCount) {
  return [
    "Настройки ролика:",
    `⏱ Длительность: ${formatDuration(settings)}`,
    `📝 Текст: ${formatText(settings)}`,
    `🎵 Музыка: ${formatMusic(settings)}`,
    "",
    `В подборке клипов: ${clipsCount}`,
  ].join("\n");
}

function mainMenuKeyboard(settings, clipsCount) {
  const kb = new InlineKeyboard()
    .text(`⏱ Длительность: ${formatDuration(settings)}`, "menu:duration")
    .row()
    .text(`📝 Текст: ${formatText(settings)}`, "menu:text")
    .row()
    .text(`🎵 Музыка: ${formatMusic(settings)}`, "menu:music")
    .row();

  if (clipsCount >= 2) {
    kb.text("🎬 Собрать ролик", "menu:render").row();
  }
  kb.text("🆕 Новая подборка клипов", "menu:new");
  return kb;
}

function durationMenuKeyboard(settings) {
  const kb = new InlineKeyboard();
  DURATION_PRESETS.forEach((sec, i) => {
    const label = settings.durationLimit === sec ? `✅ ${sec} сек` : `${sec} сек`;
    kb.text(label, `duration:set:${sec}`);
    if (i % 2 === 1) kb.row();
  });
  if (DURATION_PRESETS.length % 2 !== 0) kb.row();
  kb.text("✏️ Своё значение", "duration:custom").row();
  kb.text("🚫 Без ограничения", "duration:off").row();
  kb.text("◀️ Назад", "menu:main");
  return kb;
}

function textMenuKeyboard(settings) {
  const kb = new InlineKeyboard();
  ["top", "center", "bottom"].forEach((pos) => {
    const active = settings.textDraftPosition === pos;
    kb.text(`${active ? "✅ " : ""}${POSITION_LABELS[pos]}`, `text:pos:${pos}`);
  });
  kb.row();
  kb.text("✏️ Ввести текст", "text:input").row();
  if (settings.text) {
    kb.text("🗑 Убрать текст", "text:off").row();
  }
  kb.text("◀️ Назад", "menu:main");
  return kb;
}

function musicMenuKeyboard(settings) {
  const kb = new InlineKeyboard();
  if (settings.musicPath) {
    kb.text("🗑 Убрать музыку", "music:off").row();
  }
  kb.text("◀️ Назад", "menu:main");
  return kb;
}

const musicMenuText =
  "Чтобы добавить фоновую музыку: пришли аудио или голосовое сообщение и ответь на него командой /music.\n\n" +
  "Трек зациклится на всю длину ролика и будет тише звука из клипов.";

module.exports = {
  DURATION_PRESETS,
  mainMenuText,
  mainMenuKeyboard,
  durationMenuKeyboard,
  textMenuKeyboard,
  musicMenuKeyboard,
  musicMenuText,
};

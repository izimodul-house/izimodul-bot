const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_TMP_DIR = path.join(os.tmpdir(), "izimodul-bot-sessions");

const sessions = new Map();
// Настройки (длительность, текст, музыка) переживают /new — это профиль чата,
// а не конкретная подборка клипов.
const settingsStore = new Map();

function defaultSettings() {
  return {
    durationLimit: null, // секунды, null = без ограничения
    text: null, // { content, position } | null
    musicPath: null, // путь к загруженному аудиофайлу | null
  };
}

function getSettingsDir(chatId) {
  const dir = path.join(BASE_TMP_DIR, String(chatId), "settings");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSettings(chatId) {
  let settings = settingsStore.get(chatId);
  if (!settings) {
    settings = defaultSettings();
    settingsStore.set(chatId, settings);
  }
  return settings;
}

function updateSettings(chatId, patch) {
  const settings = getSettings(chatId);
  Object.assign(settings, patch);
  return settings;
}

function clearSettings(chatId) {
  const settings = getSettings(chatId);
  if (settings.musicPath) {
    fs.rmSync(settings.musicPath, { force: true });
  }
  settingsStore.set(chatId, defaultSettings());
}

function getOrCreateSession(chatId) {
  let session = sessions.get(chatId);
  if (!session) {
    const dir = path.join(BASE_TMP_DIR, String(chatId), String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    session = { dir, clips: [] };
    sessions.set(chatId, session);
  }
  return session;
}

function resetSession(chatId) {
  const existing = sessions.get(chatId);
  if (existing) {
    fs.rmSync(existing.dir, { recursive: true, force: true });
    sessions.delete(chatId);
  }
  return getOrCreateSession(chatId);
}

function clearSession(chatId) {
  const existing = sessions.get(chatId);
  if (existing) {
    fs.rmSync(existing.dir, { recursive: true, force: true });
    sessions.delete(chatId);
  }
}

module.exports = {
  getOrCreateSession,
  resetSession,
  clearSession,
  getSettings,
  updateSettings,
  clearSettings,
  getSettingsDir,
};

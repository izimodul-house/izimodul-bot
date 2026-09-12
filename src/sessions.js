const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_TMP_DIR = path.join(os.tmpdir(), "izimodul-bot-sessions");

const sessions = new Map();

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

module.exports = { getOrCreateSession, resetSession, clearSession };

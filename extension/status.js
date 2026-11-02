"use strict";
// Human-readable sync status, shared by the popup and the viewer page.
const SYNC_ERRORS = {
  login: "Вы не вошли в Steam. Войдите в открывшейся вкладке и нажмите «Обновить» ещё раз.",
  "no-table": "Не удалось найти таблицу сообщений на странице Steam.",
  timeout: "Steam слишком долго не отвечал. Попробуйте позже.",
  cancelled: "Обновление отменено: вкладка Steam была закрыта."
};

function syncStatusText(s) {
  if (!s || !s.state) return "История ещё не загружалась.";
  if (s.state === "syncing") return `Загружаю историю… строк: ${s.rows || 0}`;
  if (s.state === "error") return SYNC_ERRORS[s.error] || "Не удалось загрузить историю.";
  return `Обновлено ${new Date(s.syncedAt).toLocaleString("ru-RU")}, строк: ${s.rows}.` +
    (s.partial ? " Steam перестал отвечать — история может быть неполной." : "");
}

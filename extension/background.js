"use strict";
// Opens the Steam message-log page in a background tab, injects collector.js and stores
// the collected history in chrome.storage.local. Nothing leaves the browser.
const LOG_URL = "https://help.steampowered.com/ru/accountdata/GetFriendMessagesLog";
const TIMEOUT_MIN = 15;

// the running sync survives service-worker restarts in session storage
const getSync = async () => (await chrome.storage.session.get("sync")).sync || null;
const setSync = sync => chrome.storage.session.set({ sync });

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get("status");
  await chrome.storage.local.set({ status: { ...status, ...patch } });
}

async function startSync(interactive) {
  if (await getSync()) return;
  await setStatus({ state: "syncing", rows: 0, error: null });
  chrome.action.setBadgeText({ text: "…" });
  const tab = await chrome.tabs.create({ url: LOG_URL, active: false });
  await setSync({ tabId: tab.id, interactive, injected: false });
  chrome.alarms.create("syncTimeout", { delayInMinutes: TIMEOUT_MIN });
}

async function finish(sync, patch, closeTab = true) {
  await setSync(null);
  chrome.alarms.clear("syncTimeout");
  await setStatus(patch);
  chrome.action.setBadgeText({ text: patch.error ? "!" : "" });
  if (closeTab) chrome.tabs.remove(sync.tabId).catch(() => {});
}

async function fail(sync, error) {
  // not signed in: during a manual sync show the tab so the user can sign in themselves
  const showLogin = error === "login" && sync.interactive;
  if (showLogin) chrome.tabs.update(sync.tabId, { active: true }).catch(() => {});
  await finish(sync, { state: "error", error }, !showLogin);
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const sync = await getSync();
  if (!sync || tabId !== sync.tabId || info.status !== "complete" || sync.injected) return;
  if (!/^https:\/\/help\.steampowered\.com\/.*accountdata/i.test(tab.url || "")) return fail(sync, "login");
  await setSync({ ...sync, injected: true });
  chrome.scripting.executeScript({ target: { tabId }, files: ["extension/collector.js"] })
    .catch(() => fail(sync, "no-table"));
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const sync = await getSync();
  if (sync && tabId === sync.tabId) finish(sync, { state: "error", error: "cancelled" }, false);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    if (msg.type === "sync") return startSync(true);
    // results are accepted only from the tab this extension opened itself
    const sync = await getSync();
    if (!sync || !sender.tab || sender.tab.id !== sync.tabId) return;
    if (msg.type === "progress") return setStatus({ rows: msg.rows });
    if (msg.type === "error") return fail(sync, msg.reason);
    if (msg.type === "done") {
      await chrome.storage.local.set({ history: msg.html });
      return finish(sync, { state: "ok", rows: msg.rows, partial: msg.partial, syncedAt: Date.now(), error: null });
    }
  })();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "autoSync") return startSync(false);
  if (alarm.name === "syncTimeout") {
    const sync = await getSync();
    if (sync) fail(sync, "timeout");
  }
});

// daily sync only after the user has turned it on in the popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.autoSync) return;
  if (changes.autoSync.newValue) chrome.alarms.create("autoSync", { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  else chrome.alarms.clear("autoSync");
});

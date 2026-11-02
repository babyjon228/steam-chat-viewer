"use strict";
const $ = s => document.querySelector(s);

function render(s) {
  $("#status").textContent = syncStatusText(s);
  $("#status").classList.toggle("err", !!s && s.state === "error");
  $("#sync").disabled = !!s && s.state === "syncing";
}

chrome.storage.local.get(["status", "autoSync"]).then(({ status, autoSync }) => {
  render(status);
  $("#auto").checked = !!autoSync;
});
chrome.storage.onChanged.addListener(ch => { if (ch.status) render(ch.status.newValue); });

$("#open").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
$("#sync").onclick = () => chrome.runtime.sendMessage({ type: "sync" });
$("#auto").onchange = e => chrome.storage.local.set({ autoSync: e.target.checked });

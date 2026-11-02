"use strict";
// Shared by the bookmarklet (app.js) and the browser extension (injected as a content script).
// Presses "Load more" on the Steam message-log page until the whole history is loaded and
// resolves with an HTML document that holds only the tables (no page scripts or session data).
function steamCollect(onProgress) {
  const MORE = /загрузить ещё|загрузить еще|показать ещё|показать еще|load more|show more/i;
  const rowCount = () => document.querySelectorAll("table tr").length;
  const moreButton = () => [...document.querySelectorAll("a, button, input[type=button], [onclick], [role=button]")]
    .find(el => el.offsetParent !== null && MORE.test(el.value || el.textContent || ""));
  const result = partial => ({
    html: `<!doctype html><meta charset="utf-8"><title>Steam chat export</title>\n` +
      [...document.querySelectorAll("table")].map(t => t.outerHTML).join("\n"),
    rows: rowCount(),
    partial
  });

  return new Promise((resolve, reject) => {
    let waited = 0, lastCount = -1, idle = 0;
    const tick = () => {
      if (!document.querySelector("table")) {
        // the page may still be rendering; give it 10 s
        if (++waited > 20) {
          const login = /login/i.test(location.href) || document.querySelector("input[type=password]");
          return reject(new Error(login ? "login" : "no-table"));
        }
        return setTimeout(tick, 500);
      }
      const n = rowCount();
      if (n !== lastCount) { lastCount = n; idle = 0; } else idle++;
      onProgress(n);
      const btn = moreButton();
      if (!btn) return idle >= 3 ? resolve(result(false)) : setTimeout(tick, 700);
      if (idle === 0 || idle % 15 === 0) btn.click();   // click once per new page, retry if stuck
      if (idle > 60) return resolve(result(true));      // Steam stopped responding
      setTimeout(tick, 700);
    };
    tick();
  });
}

// Inside the extension: run right away and report back to the background worker.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && location.hostname === "help.steampowered.com") {
  steamCollect(rows => chrome.runtime.sendMessage({ type: "progress", rows }))
    .then(r => chrome.runtime.sendMessage({ type: "done", ...r }))
    .catch(e => chrome.runtime.sendMessage({ type: "error", reason: e.message }));
}

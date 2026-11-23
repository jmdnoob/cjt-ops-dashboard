/*!
 * CJT Extension Download — its own standalone page (split out of setup.js
 * 2026-11-23, section "7. AAA Work Order Extractor", so dispatcher-level
 * staff can be given this page without ever touching Setup's billing/
 * connection/security config). Just a download button + an on-page
 * install checklist for the AAA Work Order Extractor browser extension —
 * no GHL API calls of any kind, so no locationId/privateToken needed at
 * all. Hosted on GitHub next to dashboard.js/setup.js, loaded the same
 * way (jsDelivr).
 *
 * ============================================================================
 * WHAT TO PASTE INTO THE "Extension" GHL PAGE (Website/Funnel builder ->
 * Custom HTML/CSS/JS element). Use a Custom Menu Link to this page's own
 * GHL URL, set to "Embedded iframe". This page never touches live GHL
 * data, so it's safe to give to any staff role.
 *
 *   <div id="cjt-extension-root"></div>
 *   <script>
 *     window.CJT_CONFIG = {
 *       // Both optional — default to this repo's own GitHub Releases.
 *       extensionRepo: "jmdnoob/cjt-ops-dashboard",
 *       extensionAsset: "AAA-GHL-Extractor.zip"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/jmdnoob/cjt-ops-dashboard@main/extension-download.js"></script>
 *
 * Use "@main", not "@latest" — see the same note on setup.js/dashboard.js.
 * ============================================================================
 */
(function () {
  "use strict";

  var DEFAULTS = {
    extensionRepo: "jmdnoob/cjt-ops-dashboard",
    extensionAsset: "AAA-GHL-Extractor.zip",
  };
  var CONFIG = Object.assign({}, DEFAULTS, window.CJT_CONFIG || {});

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // A webpage can never install or run software on a visitor's computer by
  // itself — this only gets them the zip with one click. The actual install
  // (unzip + Load unpacked in the browser) still happens locally, once, on
  // each computer that needs the extension — but as of 2026-10-15 that's
  // the whole install: no installer script, no OS detection needed (one
  // zip, same steps on Mac/Windows/Linux), no GHL token touches this
  // computer at all. The URL below is GitHub's stable "always the newest
  // Release" link — publishing a new GitHub Release with the same asset
  // filename is the only thing that has to happen to ship an update; this
  // link never changes.
  function releaseAssetUrl(repo, asset) {
    return "https://github.com/" + repo + "/releases/latest/download/" + encodeURIComponent(asset);
  }

  // installSteps/openInstallSteps: the on-page checklist that pops up the
  // instant someone clicks the download button, so the guidance reads as
  // part of that click even though the file-save itself is the browser's
  // own UI. The overlay is appended to <body>, not #cjt-extension-root, so
  // it always covers the full viewport.
  function installSteps() {
    return [
      "Your download has started in the browser (its own download bar/notification, not this page) — wait for it to finish.",
      'Unzip <span class="mono">AAA-GHL-Extractor.zip</span> (double-click it on Mac; right-click → <b>Extract All…</b> on Windows) — you\'ll get a folder called <span class="mono">aaa-browser-extension</span>. Put it somewhere permanent (not the Downloads folder, so it doesn\'t get cleaned up later).',
      'In Chrome, go to <span class="mono">chrome://extensions</span> (Edge, Brave, and Vivaldi all work the same way — just use that browser\'s own <span class="mono">://extensions</span> page instead).',
      'Turn on <b>Developer mode</b> (top-right toggle).',
      'Click <b>Load unpacked</b> and select the <span class="mono">aaa-browser-extension</span> folder you unzipped.',
      "That's it — no installer, no GHL token to enter, nothing else to configure. Open an AAA Work Order page and click the extension icon to try it."
    ];
  }
  // Checklist progress persists per-computer (localStorage), so closing the
  // popup — or leaving the page and coming back later to finish install —
  // doesn't lose which steps were already done. This is a per-browser
  // convenience only: it never leaves this machine and nothing here is
  // synced anywhere.
  var INSTALL_PROGRESS_KEY = "cjtExtInstallProgress";
  function loadProgress() {
    try {
      var raw = window.localStorage.getItem(INSTALL_PROGRESS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveProgress(idxArr) {
    try { window.localStorage.setItem(INSTALL_PROGRESS_KEY, JSON.stringify(idxArr)); } catch (e) { /* private/blocked storage — checklist still works, just won't persist */ }
  }
  function openInstallSteps() {
    var steps = installSteps();
    var checkedIdx = {};
    loadProgress().forEach(function (i) { checkedIdx[i] = true; });

    var overlay = document.createElement("div");
    overlay.className = "extInstallOverlay";
    var stepsHtml = steps
      .map(function (s, i) {
        var isDone = !!checkedIdx[i];
        return (
          '<li class="' + (isDone ? "done" : "") + '">' +
          '<span class="stepNum">' + (i + 1) + "</span>" +
          '<label class="stepText">' +
          '<input type="checkbox" data-idx="' + i + '"' + (isDone ? " checked" : "") + ">" +
          '<span class="stepTxt">' + s + "</span>" +
          "</label>" +
          "</li>"
        );
      })
      .join("");
    overlay.innerHTML =
      '<div class="extInstallCard">' +
      '<button type="button" class="extInstallClose" aria-label="Close">&times;</button>' +
      '<div class="extInstallTitle">Installing the extension</div>' +
      '<div class="extInstallSub">Follow these steps once the download above finishes. Check each one off as you go — your progress is saved on this computer, so it’s still here if you close this and come back.</div>' +
      '<ol class="extInstallSteps">' + stepsHtml + "</ol>" +
      '<div class="extInstallProgress"><span class="extInstallProgressText"></span> · <button type="button" class="extInstallReset">Reset checklist</button></div>' +
      '<div class="btnRow"><button type="button" class="btn primary extInstallDone">Close</button></div>' +
      "</div>";
    document.body.appendChild(overlay);

    var progressText = overlay.querySelector(".extInstallProgressText");
    function refreshProgressText() {
      var done = overlay.querySelectorAll(".extInstallSteps input[type=checkbox]:checked").length;
      progressText.textContent = done + " of " + steps.length + " done";
    }
    refreshProgressText();

    function persist() {
      var idxs = [];
      Array.prototype.forEach.call(overlay.querySelectorAll(".extInstallSteps input[type=checkbox]:checked"), function (cb) {
        idxs.push(Number(cb.getAttribute("data-idx")));
      });
      saveProgress(idxs);
    }

    Array.prototype.forEach.call(overlay.querySelectorAll(".extInstallSteps input[type=checkbox]"), function (cb) {
      cb.addEventListener("change", function () {
        var li = cb.closest("li");
        if (li) li.classList.toggle("done", cb.checked);
        refreshProgressText();
        persist();
      });
    });

    overlay.querySelector(".extInstallReset").addEventListener("click", function () {
      Array.prototype.forEach.call(overlay.querySelectorAll(".extInstallSteps input[type=checkbox]"), function (cb) {
        cb.checked = false;
        var li = cb.closest("li");
        if (li) li.classList.remove("done");
      });
      refreshProgressText();
      saveProgress([]);
    });

    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.querySelector(".extInstallClose").addEventListener("click", close);
    overlay.querySelector(".extInstallDone").addEventListener("click", close);
    // Deliberately no "click outside the card to close" — someone mid-way
    // through checking off steps shouldn't be able to lose the popup with
    // one stray click. Explicit X, Close button, or Escape only.
    document.addEventListener("keydown", onKey);
  }

  var CSS_TEXT = [
    ':root{--ext-bg:#f5f6f8;--ext-panel:#fff;--ext-border:#e4e4e9;--ext-text:#19191c;--ext-text-dim:#6b7280;--ext-accent:#19191c;--ext-accent-strong:#000}',
    '#cjt-extension-root *{box-sizing:border-box}',
    '#cjt-extension-root{background:var(--ext-bg);color:var(--ext-text);font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px 16px 60px}',
    '#cjt-extension-root .wrap{max-width:640px;margin:0 auto}',
    '#cjt-extension-root h1{font-size:19px;margin:0 0 6px;font-weight:700}',
    '#cjt-extension-root .sub{font-size:12.5px;color:var(--ext-text-dim);line-height:1.55;margin-bottom:20px;max-width:60ch}',
    '#cjt-extension-root .card{background:var(--ext-panel);border:1px solid var(--ext-border);border-radius:14px;padding:20px 22px;box-shadow:0 1px 2px rgba(25,25,28,.05),0 2px 10px rgba(25,25,28,.06)}',
    '#cjt-extension-root .hint{font-size:11.5px;color:var(--ext-text-dim);line-height:1.5;margin-top:10px}',
    '#cjt-extension-root .btnRow{display:flex;gap:10px;flex-wrap:wrap}',
    '#cjt-extension-root .btn{appearance:none;border:1px solid var(--ext-border);background:var(--ext-panel);color:var(--ext-text);font-family:inherit;font-size:13px;font-weight:600;padding:10px 18px;border-radius:9px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}',
    '#cjt-extension-root .btn.primary{background:var(--ext-accent);border-color:var(--ext-accent);color:#fff}',
    '#cjt-extension-root .btn.primary:hover{background:var(--ext-accent-strong)}',
    '#cjt-extension-root .btn:disabled{opacity:.5;cursor:not-allowed}',
    '.mono{font-family:"Roboto",ui-monospace,SFMono-Regular,Menlo,monospace}',
    // extInstall* rules are unscoped (not under #cjt-extension-root) because
    // the checklist overlay is appended straight to <body> — see
    // openInstallSteps() — so it always covers the full viewport regardless
    // of where #cjt-extension-root sits on the page. Class names are
    // deliberately distinctive to keep collisions with the host GHL page's
    // own CSS unlikely.
    '.extInstallOverlay{position:fixed;inset:0;background:rgba(25,25,28,.6);display:flex;align-items:center;justify-content:center;z-index:999999;padding:16px;font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.extInstallCard{position:relative;background:#fff;color:#19191c;border-radius:14px;padding:26px 26px 22px;max-width:420px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.28);max-height:82vh;overflow-y:auto}',
    '.extInstallClose{position:absolute;top:14px;right:14px;border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:#6b7280;padding:4px}',
    '.extInstallClose:hover{color:#19191c}',
    '.extInstallTitle{font-size:17px;font-weight:700;margin-bottom:4px;padding-right:20px}',
    '.extInstallSub{font-size:12.5px;color:#6b7280;line-height:1.5;margin-bottom:16px}',
    '.extInstallSteps{list-style:none;margin:0 0 14px;padding:0;display:flex;flex-direction:column;gap:12px}',
    '.extInstallSteps li{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5}',
    '.extInstallSteps .stepNum{flex:0 0 auto;width:20px;height:20px;border-radius:999px;background:#fff6de;color:#19191c;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}',
    '.extInstallSteps li.done .stepNum{background:#dcfce7;color:#15803d}',
    '.extInstallSteps label.stepText{display:flex;gap:8px;align-items:flex-start;flex:1;min-width:0;cursor:pointer}',
    '.extInstallSteps label.stepText input[type="checkbox"]{flex:0 0 auto;width:15px;height:15px;margin-top:2px;accent-color:#19191c;cursor:pointer}',
    '.extInstallSteps .stepTxt b{font-weight:700}',
    '.extInstallSteps li.done .stepTxt{color:#8a92a3;text-decoration:line-through}',
    '.extInstallProgress{font-size:11.5px;color:#8a92a3;margin:0 0 14px}',
    '.extInstallReset{background:none;border:none;padding:0;font-size:12px;color:#19191c;cursor:pointer;text-decoration:underline}',
    '.extInstallSteps .mono{font-family:"Roboto",ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef1f5;padding:1px 5px;border-radius:4px;font-size:12px}'
  ].join("\n");

  function renderExtensionDownload(wrap) {
    var repo = (CONFIG.extensionRepo || "").trim();
    var asset = (CONFIG.extensionAsset || "").trim();
    if (!repo) {
      wrap.innerHTML = '<div class="hint">Set <span class="mono">extensionRepo</span> in CJT_CONFIG (e.g. "your-org/cjt-ops-dashboard") to show the download button here.</div>';
      return;
    }
    var btn = asset
      ? '<a class="btn primary" id="extDownloadBtn" href="' + esc(releaseAssetUrl(repo, asset)) + '" target="_blank" rel="noopener noreferrer" download>Download the extension</a>'
      : '<button type="button" class="btn" disabled>Download the extension (not published yet)</button>';
    wrap.innerHTML =
      '<div class="btnRow">' + btn + "</div>" +
      '<div class="hint">Same download for Mac, Windows, and Linux — works in Chrome, Edge, Brave, or Vivaldi. ' +
      "Click to start the download — a step-by-step install checklist pops up here right away to walk you through the rest (it's just unzip and load it in the browser, no installer). This button only starts the download; the checklist covers the rest." +
      "</div>";
    // Don't preventDefault on click — the browser's own download must
    // still fire normally. This only opens the on-page checklist for what
    // to do once that download lands.
    var a = wrap.querySelector("#extDownloadBtn");
    if (a) a.addEventListener("click", function () { openInstallSteps(); });
  }

  function mount() {
    var root = document.getElementById("cjt-extension-root");
    if (!root) {
      console.error("[CJT Extension] #cjt-extension-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);
    var fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;900&display=swap";
    document.head.appendChild(fontLink);

    root.innerHTML =
      '<div class="wrap">' +
      '<h1>AAA Work Order Extractor</h1>' +
      '<div class="sub">The dispatcher-side companion tool: it reads an AAA work order page and can sync it straight into the dispatch pipeline. No GHL token or setup ever lives on the dispatcher\'s computer — the extension just talks to a shared cloud bridge. Install is one download, no installer to run: unzip it and load it in Chrome.</div>' +
      '<div class="card"><div id="extDownloadWrap"></div></div>' +
      '</div>';

    renderExtensionDownload(root.querySelector("#extDownloadWrap"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

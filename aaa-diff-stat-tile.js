/*!
 * CJT AAA Payment Difference — plain stat tile.
 * Hosted on GitHub next to the other CJT tools, loaded the same way
 * (jsDelivr). This is the single missing number next to GHL's own native
 * "Expected Tow Amount" / "AAA Actual Payments" tiles: a plain, big-number
 * view of Actual − Expected, styled to drop in beside those two native
 * tiles. GHL can't produce this tile itself — its widgets only Sum/Average
 * a field's STORED value, and the only "difference" field GHL has is Text
 * (kept that way deliberately to preserve the sign — see setup.js's
 * moneyProp() comment) — so this reads the real Number-typed
 * expected_tow_amount / gross_paid_amount off the "aaa_payments" custom
 * object instead and computes the subtraction itself in the browser.
 *
 * All-time total, no date filter — pay_date on this object isn't reliably
 * populated yet (setup.js only started writing it 2026-10-08; see its own
 * comment), so this intentionally doesn't try to slice by year/month. Once
 * pay_date is reliable this can grow a period filter the same way
 * aaa-diff-widget.js's table view could.
 *
 * ============================================================================
 * WHAT TO PASTE INTO GHL (Website/Funnel builder -> Custom HTML/CSS/JS
 * element) — e.g. right next to GHL's native Expected/Actual tiles on the
 * Dashboard page:
 *
 *   <div id="cjt-aaa-stat-root"></div>
 *   <script>
 *     // Same CJT_CONFIG block already pasted on your dashboard/setup pages
 *     // — reuse it as-is, this only reads locationId/privateToken (and
 *     // objectKeys.aaa / apiVersions.objects if you've customized those).
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@main/aaa-diff-stat-tile.js"></script>
 *
 * IMPORTANT: use "@main" here, not "@latest" — see the same note at the top
 * of setup.js/dashboard.js for why "@latest" is a trap on this repo.
 * ============================================================================
 */
(function () {
  "use strict";

  var DEFAULTS = {
    apiBase: "https://services.leadconnectorhq.com",
    locationId: "",
    privateToken: "",
    objectKeys: { aaa: "aaa_payments" },
    apiVersions: { objects: "v3" },
  };
  var CONFIG = Object.assign({}, DEFAULTS, window.CJT_CONFIG || {});
  CONFIG.objectKeys = Object.assign({}, DEFAULTS.objectKeys, (window.CJT_CONFIG || {}).objectKeys || {});
  CONFIG.apiVersions = Object.assign({}, DEFAULTS.apiVersions, (window.CJT_CONFIG || {}).apiVersions || {});

  // Same rate-limit pacing + 429 retry/backoff as the other CJT tools (see
  // setup.js's comment for the full rationale). This tile only makes a
  // handful of paginated calls per load, so it's unlikely to ever need the
  // backoff path, but it stays consistent with the rest of the system.
  var RATE_LIMIT_WINDOW_MS = 10000;
  var RATE_LIMIT_MAX_PER_WINDOW = 70;
  var requestTimestamps = [];
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function rateLimitGate() {
    var now = Date.now();
    requestTimestamps = requestTimestamps.filter(function (t) { return now - t < RATE_LIMIT_WINDOW_MS; });
    if (requestTimestamps.length < RATE_LIMIT_MAX_PER_WINDOW) {
      requestTimestamps.push(now);
      return Promise.resolve();
    }
    var oldest = requestTimestamps[0];
    return sleep(RATE_LIMIT_WINDOW_MS - (now - oldest) + 25).then(rateLimitGate);
  }
  function ghlApi(path, opts) {
    opts = opts || {};
    var headers = { Authorization: "Bearer " + CONFIG.privateToken, Version: opts.version || CONFIG.apiVersions.objects };
    if (opts.body) headers["Content-Type"] = "application/json";
    var maxRetries = 5;
    function attempt(retryCount) {
      return rateLimitGate().then(function () {
        return fetch(CONFIG.apiBase + path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
      }).then(function (res) {
        if (res.status === 429) {
          if (retryCount >= maxRetries) {
            return res.text().then(function (t) { throw new Error("GHL API 429 " + path + " (still rate-limited after " + maxRetries + " retries): " + t.slice(0, 300)); });
          }
          var retryAfterHeader = res.headers && res.headers.get && res.headers.get("Retry-After");
          var retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : NaN;
          var waitMs = isNaN(retryAfterMs) ? Math.min(1000 * Math.pow(2, retryCount), 15000) : retryAfterMs;
          waitMs += Math.floor(Math.random() * 300);
          return sleep(waitMs).then(function () { return attempt(retryCount + 1); });
        }
        if (!res.ok) return res.text().then(function (t) { throw new Error("GHL API " + res.status + " " + path + ": " + t.slice(0, 300)); });
        return res.json();
      });
    }
    return attempt(0);
  }
  function objectSchemaKey(shortKey) { return "custom_objects." + shortKey; }
  function loadAllObjectRecords(schemaKey) {
    var pageLimit = 100;
    var all = [];
    function next(searchAfter) {
      var body = { locationId: CONFIG.locationId, page: 1, pageLimit: pageLimit, query: "" };
      if (searchAfter) body.searchAfter = searchAfter;
      return ghlApi("/objects/" + objectSchemaKey(schemaKey) + "/records/search", { method: "POST", version: CONFIG.apiVersions.objects, body: body }).then(function (res) {
        var batch = res.records || [];
        all = all.concat(batch);
        if (batch.length < pageLimit || all.length > 5000) return all;
        var last = batch[batch.length - 1];
        return next(last && last.searchAfter);
      });
    }
    return next(null);
  }

  function propVal(v) {
    if (v && typeof v === "object" && "value" in v) return v.value;
    return v;
  }

  // Sums Actual − Expected across every reconciled payment — all-time, no
  // date filter (see the top-of-file note for why). A row only counts
  // toward the difference when BOTH its Expected and Actual are present;
  // rows with no Expected Tow Amount yet are tallied separately so they're
  // visible, never silently folded into the total as if they were zero.
  function computeNetDiff(records) {
    var netDiff = 0, count = 0, missingExpectedCount = 0;
    records.forEach(function (rec) {
      var p = rec.properties || {};
      var gross = propVal(p.gross_paid_amount);
      var expected = propVal(p.expected_tow_amount);
      if (expected == null) { missingExpectedCount += 1; return; }
      if (gross == null) return;
      netDiff += (gross - expected);
      count += 1;
    });
    return { netDiff: netDiff, count: count, missingExpectedCount: missingExpectedCount };
  }

  window.__CJT_AAA_STAT_INTERNAL__ = {
    CONFIG: CONFIG,
    propVal: propVal,
    computeNetDiff: computeNetDiff,
    loadAllObjectRecords: loadAllObjectRecords,
  };

  // ---------------------------------------------------------------------
  // UI — deliberately plain: a label, one big number, a small caption.
  // No buttons, no filters, no table — matches the flat "$23.78K"-style
  // tiles GHL's own native Dashboard widgets show.
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--ast-panel:#fff;--ast-border:#e1e5eb;--ast-text:#1a2130;--ast-text-dim:#626b7a;--ast-crit:#b91c1c;--ast-good:#15803d}',
    '#cjt-aaa-stat-root *{box-sizing:border-box}',
    // container-type:inline-size turns this element into a CSS "query
    // container" so the cqw units below are a live percentage of ITS actual
    // rendered width, recalculated continuously by the browser's layout
    // engine — not a one-shot JS measurement that can run before GHL's
    // embed has finished sizing the surrounding card/iframe.
    '#cjt-aaa-stat-root{background:var(--ast-panel);border:1px solid var(--ast-border);border-radius:12px;padding:24px 28px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;width:100%;container-type:inline-size}',
    '#cjt-aaa-stat-root .astLabel{font-size:14px;font-weight:600;color:var(--ast-text)}',
    // This clamp() is the baseline size — pure CSS, works even with
    // JavaScript disabled/blocked, and is what GHL's own native tiles are
    // visually matched to (a short value like "$23.78K" sits near the
    // 128px ceiling on a normal-width tile). mount()'s fitNumberFont() only
    // trims this further, and only for a value long enough to actually
    // overflow — it never has to do the initial "make it big" work anymore.
    '#cjt-aaa-stat-root .astNum{font-weight:600;line-height:1.15;color:var(--ast-text);margin-top:14px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;font-size:clamp(40px,18cqw,128px)}',
    '#cjt-aaa-stat-root .astNum.pos{color:var(--ast-crit)}',
    '#cjt-aaa-stat-root .astNum.neg{color:var(--ast-good)}',
    '#cjt-aaa-stat-root .astCaption{font-size:12.5px;color:var(--ast-text-dim);margin-top:10px;line-height:1.5}',
    '#cjt-aaa-stat-root .astErr{font-size:13px;color:var(--ast-crit)}'
  ].join("\n");

  // Formats like GHL's own tiles: "$23.78K" above $1,000, full cents below.
  function formatAbbrev(n) {
    var neg = n < 0;
    var abs = Math.abs(n);
    var out;
    if (abs >= 1000000) out = "$" + (abs / 1000000).toFixed(2) + "M";
    else if (abs >= 1000) out = "$" + (abs / 1000).toFixed(2) + "K";
    else out = "$" + abs.toFixed(2);
    return neg ? "-" + out : out;
  }
  window.__CJT_AAA_STAT_INTERNAL__.formatAbbrev = formatAbbrev;

  // The CSS clamp(40px, 18cqw, 128px) on .astNum is the baseline size and
  // does the "make it big" work on its own, continuously, with no JS
  // involved. This function's only job now is to trim that baseline
  // further for a value long enough to actually overflow the tile (e.g. a
  // big "$123,456.78" style number) — it never forces the size up, so it
  // can't fight the CSS or lock in a too-small result the way a
  // reset-every-call measurement loop could.
  var FIT_MIN_PX = 24;
  function fitNumberFont(el) {
    // Always start back at the CSS baseline, not the previous (possibly
    // already-shrunk) inline size — otherwise a shrink from a long value
    // would never grow back when a later value is shorter.
    el.style.fontSize = "";
    // clientWidth is 0 before the element has a real box (not yet attached,
    // a parent still collapsed, etc). Measuring against 0 would shrink the
    // font to the floor for no reason, so skip — the CSS baseline stays in
    // effect and the ResizeObserver/caller below retries once there's a
    // real width to check against.
    if (el.clientWidth < 10) return;
    var size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth && size > FIT_MIN_PX) {
      size -= 2;
      el.style.fontSize = size + "px";
    }
  }

  function mount() {
    var root = document.getElementById("cjt-aaa-stat-root");
    if (!root) {
      console.error("[CJT AAA Stat Tile] #cjt-aaa-stat-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);

    root.innerHTML =
      '<div class="astLabel">AAA Payment Difference (Actual − Expected)</div>' +
      '<div class="astNum" id="astNum">—</div>' +
      '<div class="astCaption" id="astCaption">Loading…</div>';

    var numEl = root.querySelector("#astNum");
    var captionEl = root.querySelector("#astCaption");
    var internal = window.__CJT_AAA_STAT_INTERNAL__;

    if (!CONFIG.locationId || !CONFIG.privateToken) {
      captionEl.className = "astErr";
      captionEl.textContent = "Missing locationId/privateToken in CJT_CONFIG for this tile.";
      return;
    }

    // Double rAF = "wait until the browser has actually painted a layout",
    // which is what makes el.clientWidth trustworthy inside fitNumberFont().
    // A single rAF can still fire before GHL's own embed/iframe has finished
    // sizing itself; two in a row reliably lands after that.
    function scheduleFit() {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (numEl.textContent && numEl.textContent !== "—") fitNumberFont(numEl);
        });
      });
    }

    internal.loadAllObjectRecords(CONFIG.objectKeys.aaa)
      .then(function (records) {
        var r = internal.computeNetDiff(records);
        numEl.textContent = formatAbbrev(r.netDiff);
        numEl.className = "astNum " + (r.netDiff > 0 ? "pos" : r.netDiff < 0 ? "neg" : "");
        scheduleFit();
        var caption = "All-time · " + r.count + " reconciled job(s)";
        if (r.missingExpectedCount > 0) caption += " · " + r.missingExpectedCount + " excluded (no Expected Tow Amount yet)";
        captionEl.className = "astCaption";
        captionEl.textContent = caption;
      })
      .catch(function (err) {
        captionEl.className = "astErr";
        captionEl.textContent = "Couldn't load AAA payment data: " + err.message;
      });

    // Extra safety net: GHL's page can still reflow after our data loads
    // (late web fonts, other widgets finishing, a sidebar collapsing), so
    // re-check once more on full page load.
    window.addEventListener("load", scheduleFit);

    // Re-fit if the tile's own box ever changes width (a GHL layout change,
    // the page being resized, a sidebar toggling, etc.) — not just on
    // window resize, since an iframe's content area can change size
    // without the window itself firing a resize event.
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (numEl.textContent && numEl.textContent !== "—") fitNumberFont(numEl);
      }).observe(root);
    } else {
      window.addEventListener("resize", function () {
        if (numEl.textContent && numEl.textContent !== "—") fitNumberFont(numEl);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

/*!
 * CJT AAA Payment Difference Widget — standalone, read-only.
 * Hosted on GitHub next to dashboard.js/setup.js, loaded the same way
 * (jsDelivr). Fixes the gap GHL's own native Dashboard widgets can't close:
 * they can only Count/Sum/Average a field's STORED value, never compute one
 * field minus another live — and the Opportunity's "AAA Payment Difference"
 * field is deliberately Text (not Number), to preserve the sign, which
 * means GHL's native widgets can't touch it at all (see setup.js's
 * moneyProp()/aaaPaymentDifference comments for why it's Text).
 *
 * This widget sidesteps both problems: it reads straight off the
 * "aaa_payments" custom object (which has real Number-typed
 * expected_tow_amount / gross_paid_amount), computes Actual − Expected
 * itself in the browser, and recomputes instantly whenever you change the
 * Year/Month filters — no refetch needed, since everything is pulled once
 * and filtered/summed client-side. "Refresh data" re-pulls from GHL if new
 * reconciliations have happened since the page loaded.
 *
 * ============================================================================
 * WHAT TO PASTE INTO GHL (Website/Funnel builder -> Custom HTML/CSS/JS
 * element) — anywhere you want this widget to show up, including right on
 * the Dashboard page next to (or instead of) the native widget:
 *
 *   <div id="cjt-aaa-diff-root"></div>
 *   <script>
 *     // Same CJT_CONFIG block already pasted on your dashboard/setup pages
 *     // — reuse it as-is, this widget only reads locationId/privateToken
 *     // (and objectKeys.aaa / apiVersions.objects if you've customized
 *     // those). If this element is on its own page with no CJT_CONFIG
 *     // already on it, paste the full block from your dashboard snippet.
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@main/aaa-diff-widget.js"></script>
 *
 * IMPORTANT: use "@main" here, not "@latest" — see the same note at the top
 * of setup.js/dashboard.js for why "@latest" is a trap on this repo.
 *
 * UNVERIFIED — confirm against a real token before relying on this in front
 * of a client: the Pay Date parsing below handles the two date shapes seen
 * in this project's real data ("YYYY-MM-DD" and "M/D/YYYY"), falling back to
 * the browser's own Date parser for anything else — a pay_date written in
 * some other format will fall into "No pay date" (excluded whenever a
 * specific Year/Month is selected, called out in its own tile so it's never
 * silently dropped) rather than being miscategorized.
 * ============================================================================
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config — same shape as setup.js/dashboard.js, so the same pasted
  // CJT_CONFIG block works unmodified.
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // GHL API client — identical rate-limit pacing + 429 retry/backoff as
  // setup.js/dashboard.js (see setup.js's comment for the full rationale).
  // This widget only does a handful of paginated GET-equivalent calls per
  // load (POST .../records/search, 100 at a time), so it's unlikely to ever
  // need the backoff path itself, but it shares the same client so a page
  // that embeds this ALONGSIDE dashboard.js/setup.js still has every call
  // across all three pulling from one combined, correctly-paced budget...
  // almost: each file keeps its own requestTimestamps array (no shared
  // module/state between separately-loaded scripts), so this is really
  // "paced the same way," not "sharing one live budget" — still fine in
  // practice since this widget's own call volume is tiny.
  // ---------------------------------------------------------------------
  var RATE_LIMIT_WINDOW_MS = 10000;
  var RATE_LIMIT_MAX_PER_WINDOW = 70;
  var requestTimestamps = [];

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function rateLimitGate() {
    var now = Date.now();
    requestTimestamps = requestTimestamps.filter(function (t) { return now - t < RATE_LIMIT_WINDOW_MS; });
    if (requestTimestamps.length < RATE_LIMIT_MAX_PER_WINDOW) {
      requestTimestamps.push(now);
      return Promise.resolve();
    }
    var oldest = requestTimestamps[0];
    var waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 25;
    return sleep(waitMs).then(rateLimitGate);
  }
  function ghlApi(path, opts) {
    opts = opts || {};
    var headers = {
      Authorization: "Bearer " + CONFIG.privateToken,
      Version: opts.version || CONFIG.apiVersions.objects,
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    var maxRetries = 5;
    function attempt(retryCount) {
      return rateLimitGate().then(function () {
        return fetch(CONFIG.apiBase + path, {
          method: opts.method || "GET",
          headers: headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      }).then(function (res) {
        if (res.status === 429) {
          if (retryCount >= maxRetries) {
            return res.text().then(function (t) {
              throw new Error("GHL API 429 " + path + " (still rate-limited after " + maxRetries + " retries): " + t.slice(0, 300));
            });
          }
          var retryAfterHeader = res.headers && res.headers.get && res.headers.get("Retry-After");
          var retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : NaN;
          var waitMs = isNaN(retryAfterMs) ? Math.min(1000 * Math.pow(2, retryCount), 15000) : retryAfterMs;
          waitMs += Math.floor(Math.random() * 300);
          return sleep(waitMs).then(function () { return attempt(retryCount + 1); });
        }
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error("GHL API " + res.status + " " + path + ": " + t.slice(0, 300));
          });
        }
        return res.json();
      });
    }
    return attempt(0);
  }

  function objectSchemaKey(shortKey) {
    return "custom_objects." + shortKey;
  }

  // Paginates POST /objects/:schemaKey/records/search using searchAfter —
  // identical to dashboard.js's loadAllObjectRecords().
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

  // ---------------------------------------------------------------------
  // Pure data functions — exposed below for testing, no DOM/network.
  // ---------------------------------------------------------------------
  function propVal(v) {
    if (v && typeof v === "object" && "value" in v) return v.value;
    return v;
  }

  // Handles the two Pay Date shapes seen in this project's real data
  // ("YYYY-MM-DD" from a cleaned CSV import, "M/D/YYYY" from AAA's raw
  // Salesforce export) by parsing the digits directly — NOT via `new
  // Date("YYYY-MM-DD")`, which JS parses as UTC midnight and can silently
  // shift into the wrong local day/month right at a month boundary. Falls
  // back to the browser's own Date parser for anything else; returns null
  // (never a guess) if nothing parses.
  function parsePayDateParts(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
    var mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (mdy) return { year: Number(mdy[3]), month: Number(mdy[1]) };
    var d = new Date(s);
    if (!isNaN(d.getTime())) return { year: d.getFullYear(), month: d.getMonth() + 1 };
    return null;
  }

  // Maps one aaa_payments record to the row shape this widget uses. The
  // difference is ALWAYS computed live here (gross - expected) when both
  // are present — never trusted from the record's own stored
  // payment_difference_value — so this widget stays correct even if a
  // record's stored value ever drifts from its own gross/expected fields.
  // Falls back to the stored value only when one side is missing (nothing
  // to compute from).
  function mapRecord(rec) {
    var p = rec.properties || {};
    var gross = propVal(p.gross_paid_amount);
    var expected = propVal(p.expected_tow_amount);
    var storedDiff = p.payment_difference_value;
    var diff = (gross != null && expected != null) ? (gross - expected) : (typeof storedDiff === "number" ? storedDiff : null);
    return {
      recordId: rec.id,
      paymentId: p.aaa_payment_id || null,
      wo: p.work_order_number || null,
      payDate: p.pay_date || null,
      dateParts: parsePayDateParts(p.pay_date),
      status: p.reconciliation_status || null,
      gross: gross,
      expected: expected,
      diff: diff,
    };
  }

  function distinctYears(rows) {
    var seen = {};
    var years = [];
    rows.forEach(function (r) {
      if (r.dateParts && !seen[r.dateParts.year]) { seen[r.dateParts.year] = true; years.push(r.dateParts.year); }
    });
    return years.sort(function (a, b) { return b - a; });
  }

  // year/month are "all" or a number (string or numeric both accepted).
  function filterRows(rows, year, month) {
    if (year === "all" && month === "all") return rows.slice();
    return rows.filter(function (r) {
      if (!r.dateParts) return false;
      if (year !== "all" && String(r.dateParts.year) !== String(year)) return false;
      if (month !== "all" && String(r.dateParts.month) !== String(month)) return false;
      return true;
    });
  }

  function computeAggregates(rows) {
    var agg = {
      count: rows.length,
      totalExpected: 0, expectedCount: 0,
      totalActual: 0, actualCount: 0,
      netDiff: 0, diffCount: 0,
      overpaid: 0, underpaid: 0,
      noExpectedCount: 0,
    };
    rows.forEach(function (r) {
      if (r.expected != null) { agg.totalExpected += r.expected; agg.expectedCount += 1; }
      else { agg.noExpectedCount += 1; }
      if (r.gross != null) { agg.totalActual += r.gross; agg.actualCount += 1; }
      if (r.diff != null) {
        agg.netDiff += r.diff;
        agg.diffCount += 1;
        if (r.diff > 0) agg.overpaid += r.diff;
        else if (r.diff < 0) agg.underpaid += -r.diff;
      }
    });
    return agg;
  }

  window.__CJT_AAA_DIFF_INTERNAL__ = {
    CONFIG: CONFIG,
    propVal: propVal,
    parsePayDateParts: parsePayDateParts,
    mapRecord: mapRecord,
    distinctYears: distinctYears,
    filterRows: filterRows,
    computeAggregates: computeAggregates,
    loadAllObjectRecords: loadAllObjectRecords,
  };

  // ---------------------------------------------------------------------
  // UI layer
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--adw-bg:#f3f5f8;--adw-panel:#fff;--adw-border:#e1e5eb;--adw-text:#1a2130;--adw-text-dim:#626b7a;--adw-accent:#1d4ed8;--adw-accent-soft:#e7edfc;--adw-good:#15803d;--adw-good-soft:#e1f4e8;--adw-crit:#b91c1c;--adw-crit-soft:#fbe4e2;--adw-chip-bg:#eef1f5}',
    '#cjt-aaa-diff-root *{box-sizing:border-box}',
    '#cjt-aaa-diff-root{background:var(--adw-bg);color:var(--adw-text);font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px 16px;border-radius:14px}',
    '#cjt-aaa-diff-root .mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}',
    '#cjt-aaa-diff-root .adwTop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}',
    '#cjt-aaa-diff-root h2{font-size:16px;margin:0;font-weight:700}',
    '#cjt-aaa-diff-root .adwAsOf{font-size:11.5px;color:var(--adw-text-dim)}',
    '#cjt-aaa-diff-root .adwFilters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px}',
    '#cjt-aaa-diff-root select{border:1px solid var(--adw-border);border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit;background:var(--adw-panel);color:var(--adw-text)}',
    '#cjt-aaa-diff-root .btn{appearance:none;border:1px solid var(--adw-border);background:var(--adw-panel);color:var(--adw-text);font-family:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px;cursor:pointer}',
    '#cjt-aaa-diff-root .btn:hover{border-color:var(--adw-accent);color:var(--adw-accent)}',
    '#cjt-aaa-diff-root .btn:disabled{opacity:.5;cursor:not-allowed}',
    '#cjt-aaa-diff-root .adwStatus{font-size:12.5px;color:var(--adw-text-dim);margin-bottom:12px}',
    '#cjt-aaa-diff-root .adwStatus.err{color:var(--adw-crit)}',
    '#cjt-aaa-diff-root .tileGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}',
    '#cjt-aaa-diff-root .tile{background:var(--adw-panel);border:1px solid var(--adw-border);border-radius:10px;padding:12px 14px}',
    '#cjt-aaa-diff-root .tile .n{font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:700}',
    '#cjt-aaa-diff-root .tile .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--adw-text-dim);margin-top:3px}',
    '#cjt-aaa-diff-root .tile.net .n.pos{color:var(--adw-crit)}',
    '#cjt-aaa-diff-root .tile.net .n.neg{color:var(--adw-good)}',
    '#cjt-aaa-diff-root .tile.net .n.zero{color:var(--adw-text)}',
    '#cjt-aaa-diff-root .tile.over .n{color:var(--adw-crit)}',
    '#cjt-aaa-diff-root .tile.under .n{color:var(--adw-good)}',
    '#cjt-aaa-diff-root .adwNote{font-size:11.5px;color:var(--adw-text-dim);margin:-6px 0 16px;line-height:1.5}',
    '#cjt-aaa-diff-root .tableWrap{background:var(--adw-panel);border:1px solid var(--adw-border);border-radius:10px;overflow-x:auto}',
    '#cjt-aaa-diff-root table{border-collapse:collapse;width:100%;font-size:12.5px;min-width:620px}',
    '#cjt-aaa-diff-root thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--adw-text-dim);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--adw-border);white-space:nowrap}',
    '#cjt-aaa-diff-root tbody td{padding:8px 12px;border-bottom:1px solid var(--adw-border);white-space:nowrap}',
    '#cjt-aaa-diff-root tbody tr:last-child td{border-bottom:none}',
    '#cjt-aaa-diff-root .diffPos{color:var(--adw-crit);font-weight:600}',
    '#cjt-aaa-diff-root .diffNeg{color:var(--adw-good);font-weight:600}',
    '#cjt-aaa-diff-root .adwEmpty{padding:18px;text-align:center;color:var(--adw-text-dim);font-size:13px}'
  ].join("\n");

  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var neg = n < 0;
    var s = "$" + Math.abs(n).toFixed(2);
    return neg ? "-" + s : s;
  }

  function mount() {
    var root = document.getElementById("cjt-aaa-diff-root");
    if (!root) {
      console.error("[CJT AAA Diff Widget] #cjt-aaa-diff-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);

    root.innerHTML =
      '<div class="adwTop"><h2>AAA Payment Reconciliation</h2><span class="adwAsOf" id="adwAsOf"></span></div>' +
      '<div class="adwFilters">' +
      '<select id="adwYear"></select>' +
      '<select id="adwMonth"></select>' +
      '<button type="button" class="btn" id="adwRefresh">Refresh data</button>' +
      '</div>' +
      '<div class="adwStatus" id="adwStatus">Loading…</div>' +
      '<div id="adwBody" hidden>' +
      '<div class="tileGrid">' +
      '<div class="tile"><div class="n mono" id="tExpected">—</div><div class="l">Expected Tow Amount</div></div>' +
      '<div class="tile"><div class="n mono" id="tActual">—</div><div class="l">AAA Actual Paid</div></div>' +
      '<div class="tile net"><div class="n mono" id="tNet">—</div><div class="l">Net Difference (Actual − Expected)</div></div>' +
      '<div class="tile over"><div class="n mono" id="tOver">—</div><div class="l">Total Overpaid</div></div>' +
      '<div class="tile under"><div class="n mono" id="tUnder">—</div><div class="l">Total Underpaid</div></div>' +
      '<div class="tile"><div class="n mono" id="tCount">—</div><div class="l">Jobs in view</div></div>' +
      '</div>' +
      '<div class="adwNote" id="adwNote"></div>' +
      '<div id="adwTableWrap"></div>' +
      '</div>';

    var els = {};
    ["adwYear", "adwMonth", "adwRefresh", "adwStatus", "adwBody", "adwAsOf", "tExpected", "tActual", "tNet", "tOver", "tUnder", "tCount", "adwNote", "adwTableWrap"]
      .forEach(function (id) { els[id] = root.querySelector("#" + id); });

    var allRows = [];
    var internal = window.__CJT_AAA_DIFF_INTERNAL__;

    function populateFilters() {
      var years = internal.distinctYears(allRows);
      var currentYear = new Date().getFullYear();
      var defaultYear = years.indexOf(currentYear) !== -1 ? String(currentYear) : "all";
      var prevYear = els.adwYear.value || defaultYear;
      var prevMonth = els.adwMonth.value || "all";

      els.adwYear.innerHTML = '<option value="all">All years</option>' +
        years.map(function (y) { return '<option value="' + y + '">' + y + "</option>"; }).join("");
      els.adwMonth.innerHTML = '<option value="all">All months</option>' +
        MONTH_NAMES.map(function (m, i) { return '<option value="' + (i + 1) + '">' + m + "</option>"; }).join("");

      els.adwYear.value = years.indexOf(Number(prevYear)) !== -1 || prevYear === "all" ? prevYear : defaultYear;
      els.adwMonth.value = prevMonth;
    }

    function render() {
      var year = els.adwYear.value || "all";
      var month = els.adwMonth.value || "all";
      var filtered = internal.filterRows(allRows, year, month);
      var agg = internal.computeAggregates(filtered);

      els.tExpected.textContent = money(agg.totalExpected);
      els.tActual.textContent = money(agg.totalActual);
      els.tNet.textContent = money(agg.netDiff);
      els.tNet.className = "n mono " + (agg.netDiff > 0 ? "pos" : agg.netDiff < 0 ? "neg" : "zero");
      els.tOver.textContent = money(agg.overpaid);
      els.tUnder.textContent = money(agg.underpaid);
      els.tCount.textContent = String(agg.count);

      var noDateCount = allRows.filter(function (r) { return !r.dateParts; }).length;
      var notes = [];
      if (agg.noExpectedCount > 0) notes.push(agg.noExpectedCount + " job(s) in view have no Expected Tow Amount on file yet (excluded from Expected/Net totals).");
      if ((year !== "all" || month !== "all") && noDateCount > 0) notes.push(noDateCount + " record(s) across all time have no readable Pay Date and are excluded whenever a Year or Month filter is applied — switch both to “All” to include them.");
      els.adwNote.textContent = notes.join(" ");

      if (filtered.length === 0) {
        els.adwTableWrap.innerHTML = '<div class="adwEmpty">No reconciled AAA payments in this view.</div>';
      } else {
        var sorted = filtered.slice().sort(function (a, b) {
          var ap = a.dateParts, bp = b.dateParts;
          if (!ap && !bp) return 0;
          if (!ap) return 1;
          if (!bp) return -1;
          return (bp.year - ap.year) || (bp.month - ap.month);
        });
        var body = sorted.map(function (r) {
          var diffClass = r.diff > 0 ? "diffPos" : r.diff < 0 ? "diffNeg" : "";
          return "<tr><td>" + esc(r.wo || "—") + "</td><td>" + esc(r.paymentId || "—") + "</td>" +
            "<td>" + esc(r.payDate || "—") + "</td>" +
            "<td>" + money(r.expected) + "</td><td>" + money(r.gross) + "</td>" +
            '<td class="' + diffClass + '">' + money(r.diff) + "</td>" +
            "<td>" + esc(r.status || "—") + "</td></tr>";
        }).join("");
        els.adwTableWrap.innerHTML =
          '<div class="tableWrap"><table><thead><tr><th>Work Order</th><th>Payment ID</th><th>Pay Date</th><th>Expected</th><th>Actual Paid</th><th>Difference</th><th>Status</th></tr></thead><tbody>' +
          body + "</tbody></table></div>";
      }
    }

    function loadData() {
      els.adwRefresh.disabled = true;
      els.adwStatus.className = "adwStatus";
      els.adwStatus.textContent = "Loading reconciled AAA payments…";
      els.adwBody.hidden = true;
      if (!CONFIG.locationId || !CONFIG.privateToken) {
        els.adwStatus.className = "adwStatus err";
        els.adwStatus.textContent = "Missing locationId/privateToken in CJT_CONFIG for this widget.";
        els.adwRefresh.disabled = false;
        return;
      }
      internal.loadAllObjectRecords(CONFIG.objectKeys.aaa)
        .then(function (records) {
          allRows = records.map(internal.mapRecord);
          populateFilters();
          render();
          els.adwStatus.textContent = "";
          els.adwAsOf.textContent = "As of " + new Date().toLocaleTimeString();
          els.adwBody.hidden = false;
        })
        .catch(function (err) {
          els.adwStatus.className = "adwStatus err";
          els.adwStatus.textContent = "Couldn't load AAA payment data: " + err.message;
        })
        .finally(function () { els.adwRefresh.disabled = false; });
    }

    els.adwYear.addEventListener("change", render);
    els.adwMonth.addEventListener("change", render);
    els.adwRefresh.addEventListener("click", loadData);

    loadData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

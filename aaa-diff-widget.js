/*!
 * CJT AAA Payment Difference Widget — standalone, read-only.
 * Hosted on GitHub next to dashboard.js/setup.js, loaded the same way
 * (jsDelivr). Fixes the gap GHL's own native Dashboard widgets can't close:
 * they can only Count/Sum/Average a field's STORED value, never compute one
 * field minus another live — and the Opportunity's "AAA Payment Difference"
 * field is deliberately Text (not Number), to preserve the sign, which
 * means GHL's native widgets can't touch it at all (see setup.js's
 * writeOpportunityFields()/aaaPaymentDifference comments for why it's Text).
 *
 * This widget sidesteps both problems: it reads straight off each
 * dispatch-pipeline Opportunity's own custom fields (real Number-valued
 * "Expected Tow Amount" / "AAA Gross Paid Amount"), computes Actual −
 * Expected itself in the browser, and recomputes instantly on "Refresh
 * data" — no server round trip, just a re-pull + re-sum client-side.
 *
 * REMOVED (2026-10-13): this used to read a separate "aaa_payments" Custom
 * Object instead of the Opportunity directly — the client deleted that
 * object on purpose (AAA payment data belongs on the Opportunity, not
 * duplicated into a second object), so this file no longer touches it at
 * all. One real consequence: a statement row that had NO matching
 * Opportunity at all ("no match" in Setup's Preview) has nothing to read
 * here anymore — there's no Opportunity to look at — so it can't appear in
 * this table the way it briefly could when it was mirrored into the Custom
 * Object. It's still visible at import time in Setup's own Preview; it just
 * isn't persisted anywhere after that. See loadAaaOpportunities()/
 * mapOpportunity() below.
 *
 * Year/Month filtering (2026-10-08): REMOVED for now, not just hidden. It
 * depended entirely on each row's pay date, and setup.js's Apply step never
 * actually wrote "AAA Pay Date" onto the Opportunity until recently (see
 * its own 2026-10-08 comment) — so an older Opportunity can still have no
 * usable date, which made a date filter actively misleading (it would
 * silently exclude most or all of your real data instead of showing it).
 * The Pay Date column is gone from the table for the same reason. The
 * underlying pure functions (parsePayDateParts, distinctYears, filterRows)
 * are still here and still tested — re-enabling the Year/Month UI is a
 * small, contained change once Pay Date is reliably populated everywhere.
 *
 * ============================================================================
 * WHAT TO PASTE INTO GHL (Website/Funnel builder -> Custom HTML/CSS/JS
 * element) — anywhere you want this widget to show up, including right on
 * the Dashboard page next to (or instead of) the native widget:
 *
 *   <div id="cjt-aaa-diff-root"></div>
 *   <script>
 *     // Same CJT_CONFIG block already pasted on your dashboard/setup pages
 *     // — reuse it as-is. This reads locationId/privateToken plus
 *     // dispatchPipelineName (to find the Opportunities to scan) and
 *     // apiVersions.pipelines/opportunities if you've customized those. If
 *     // this element is on its own page with no CJT_CONFIG already on it,
 *     // paste the full block from your dashboard snippet.
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
 *       dispatchPipelineName: "Towing Dispatch"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@main/aaa-diff-widget.js"></script>
 *
 * IMPORTANT: use "@main" here, not "@latest" — see the same note at the top
 * of setup.js/dashboard.js for why "@latest" is a trap on this repo.
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
    dispatchPipelineName: "Towing Dispatch",
    apiVersions: { pipelines: "v3", opportunities: "2021-07-28" },
  };
  var CONFIG = Object.assign({}, DEFAULTS, window.CJT_CONFIG || {});
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
      Version: opts.version || CONFIG.apiVersions.opportunities,
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

  function qs(params) {
    return Object.keys(params)
      .filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ""; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
      .join("&");
  }
  function loadPipelines() {
    return ghlApi("/opportunities/pipelines?" + qs({ locationId: CONFIG.locationId }), { version: CONFIG.apiVersions.pipelines }).then(function (res) {
      return res.pipelines || [];
    });
  }
  // Paginates /opportunities/search for one pipeline — identical to
  // dashboard.js's copy of the same function.
  function loadAllOpportunities(pipelineId) {
    var limit = 100, page = 1, all = [];
    function next() {
      var url = "/opportunities/search?" + qs({ location_id: CONFIG.locationId, pipeline_id: pipelineId, status: "all", limit: limit, page: page });
      return ghlApi(url, { version: CONFIG.apiVersions.opportunities }).then(function (res) {
        var batch = res.opportunities || [];
        all = all.concat(batch);
        if (batch.length < limit || page > 20) return all;
        page += 1;
        return next();
      });
    }
    return next();
  }

  // ---------------------------------------------------------------------
  // Opportunity custom-field ID resolution — same trimmed copy of
  // setup.js's FIELD_ID_FALLBACKS/FIELD_NAME_CANDIDATES/resolveFieldIds()
  // pattern as dashboard.js/aaa-diff-stat-tile.js carry (see dashboard.js's
  // own comment for the full rationale). Added 2026-10-13 when this widget
  // moved off the aaa_payments Custom Object and onto the Opportunity
  // directly.
  // ---------------------------------------------------------------------
  var FIELD_ID_FALLBACKS = {
    workOrderNumber: ["gkJwODzLAFBtALkbUm54", "Oz3NeGwx2PxgrzaihYWl"],
    expectedTowAmount: ["G3NwXSgdfozNGLPpxnzx"],
    aaaPaymentId: ["PwhfIoJkhnhlcLlU855m"],
    aaaGrossPaid: ["x6BZnE668LiqEk76S1TW"],
    aaaPayDate: ["2ERL2vncdpLAjD027qXz"],
    // No fallback for this one on purpose — see setup.js's own comment on
    // this same constant for why (the field's been deleted/recreated under
    // a new ID more than once; only the by-name lookup below is durable).
    aaaPaymentDifference: [],
  };
  var FIELD_NAME_CANDIDATES = {
    workOrderNumber: ["work order number"],
    expectedTowAmount: ["expected tow amount"],
    aaaPaymentId: ["aaa payment id"],
    aaaGrossPaid: ["aaa gross paid amount"],
    aaaPayDate: ["aaa pay date"],
    aaaPaymentDifference: ["aaa payment difference"],
  };
  var resolvedFields = null;
  function fetchCustomFieldDefs(model) {
    var path = "/locations/" + CONFIG.locationId + "/customFields" + (model ? "?model=" + encodeURIComponent(model) : "");
    return ghlApi(path, { version: "v3" }).then(function (res) { return Array.isArray(res) ? res : res.customFields || []; });
  }
  function resolveFieldIds() {
    if (resolvedFields) return Promise.resolve(resolvedFields);
    return Promise.all([fetchCustomFieldDefs(), fetchCustomFieldDefs("opportunity")]).then(function (results) {
      var byId = {};
      results[0].concat(results[1]).forEach(function (f) { if (f && f.id) byId[f.id] = f; });
      var allFields = Object.keys(byId).map(function (id) { return byId[id]; });
      var ids = {};
      Object.keys(FIELD_NAME_CANDIDATES).forEach(function (key) {
        var match = allFields.filter(function (f) {
          return FIELD_NAME_CANDIDATES[key].indexOf(String(f.name || "").trim().toLowerCase()) !== -1;
        })[0];
        if (match) ids[key] = match.id;
        else if (FIELD_ID_FALLBACKS[key] && FIELD_ID_FALLBACKS[key][0]) ids[key] = FIELD_ID_FALLBACKS[key][0];
        else ids[key] = null;
      });
      resolvedFields = { ids: ids };
      return resolvedFields;
    });
  }
  function fieldIdsFor(key) {
    var out = [];
    var resolved = resolvedFields && resolvedFields.ids[key];
    if (resolved) out.push(resolved);
    (FIELD_ID_FALLBACKS[key] || []).forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
    return out;
  }
  function getCustomField(opp, fieldIds) {
    var fields = opp.customFields || [];
    for (var i = 0; i < fields.length; i++) {
      if (fieldIds.indexOf(fields[i].id) !== -1) return fields[i].fieldValue;
    }
    return null;
  }
  function parseMoney(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === "") return null;
    s = s.replace(/\$/g, "").replace(/,/g, "").trim();
    if (s[0] === "(" && s[s.length - 1] === ")") s = "-" + s.slice(1, -1);
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // Resolves fields, finds the dispatch pipeline, and pages every
  // Opportunity in it — this widget's one and only data source now.
  function loadAaaOpportunities() {
    return Promise.all([resolveFieldIds(), loadPipelines()]).then(function (results) {
      var pipelines = results[1];
      var pipeline = pipelines.filter(function (p) {
        return (p.name || "").toLowerCase() === CONFIG.dispatchPipelineName.toLowerCase();
      })[0];
      if (!pipeline) throw new Error('No pipeline named "' + CONFIG.dispatchPipelineName + '" found in this GHL location.');
      return loadAllOpportunities(pipeline.id);
    });
  }

  // ---------------------------------------------------------------------
  // Pure data functions — exposed below for testing, no DOM/network.
  // ---------------------------------------------------------------------

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

  // Maps one GHL Opportunity to the row shape this widget uses — same shape
  // mapRecord() used to produce off the now-removed aaa_payments Custom
  // Object. The difference is ALWAYS computed live here (gross - expected)
  // when both are present — never trusted from the Opportunity's own stored
  // "AAA Payment Difference" text — so this widget stays correct even if
  // that field ever drifts from the actual gross/expected fields. Falls
  // back to the stored value only when one side is missing (nothing to
  // compute from). Only Opportunities with a Payment ID or a Gross Paid
  // amount are AAA payments at all — callers filter on .hasPayment.
  function mapOpportunity(o) {
    var gross = parseMoney(getCustomField(o, fieldIdsFor("aaaGrossPaid")));
    var expected = parseMoney(getCustomField(o, fieldIdsFor("expectedTowAmount")));
    var paymentId = getCustomField(o, fieldIdsFor("aaaPaymentId"));
    var payDate = getCustomField(o, fieldIdsFor("aaaPayDate"));
    var storedDiff = parseMoney(getCustomField(o, fieldIdsFor("aaaPaymentDifference")));
    var diff = (gross != null && expected != null) ? (gross - expected) : storedDiff;
    var hasPayment = !!(paymentId || gross != null);
    return {
      recordId: o.id,
      paymentId: paymentId || null,
      wo: getCustomField(o, fieldIdsFor("workOrderNumber")) || null,
      payDate: payDate || null,
      dateParts: parsePayDateParts(payDate),
      status: !hasPayment ? null : (expected != null ? "matched" : "exception"),
      gross: gross,
      expected: expected,
      diff: diff,
      hasPayment: hasPayment,
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

  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

  // ---------------------------------------------------------------------
  // CSV export — "export current view": takes exactly the rows and totals
  // already on screen for whatever Year/Month is selected (the caller
  // passes in the same filtered rows + aggregates render() just computed),
  // so the file always matches what's visible, never a separate query.
  // ---------------------------------------------------------------------
  function csvEscapeField(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // Sorts by Work Order Number (ascending, numeric-aware so "9" sorts
  // before "10") rather than by date — pay_date isn't reliably populated
  // yet (see the 2026-10-08 note at the top of this file), so a date sort
  // would mostly just reflect fetch order, not anything real.
  function sortRowsForDisplay(rows) {
    return rows.slice().sort(function (a, b) {
      return String(a.wo || "").localeCompare(String(b.wo || ""), undefined, { numeric: true });
    });
  }

  function buildCsv(rows, agg) {
    var header = ["Work Order", "Payment ID", "Expected Tow Amount", "Actual Paid", "Difference", "Status"];
    var lines = [header.map(csvEscapeField).join(",")];
    sortRowsForDisplay(rows).forEach(function (r) {
      lines.push([
        r.wo || "",
        r.paymentId || "",
        r.expected != null ? r.expected.toFixed(2) : "",
        r.gross != null ? r.gross.toFixed(2) : "",
        r.diff != null ? r.diff.toFixed(2) : "",
        r.status || "",
      ].map(csvEscapeField).join(","));
    });
    lines.push("");
    lines.push(["Total Expected", "", agg.totalExpected.toFixed(2), "", "", ""].map(csvEscapeField).join(","));
    lines.push(["Total Actual Paid", "", "", agg.totalActual.toFixed(2), "", ""].map(csvEscapeField).join(","));
    lines.push(["Net Difference (Actual − Expected)", "", "", "", agg.netDiff.toFixed(2), ""].map(csvEscapeField).join(","));
    lines.push(["Total Overpaid", "", "", "", agg.overpaid.toFixed(2), ""].map(csvEscapeField).join(","));
    lines.push(["Total Underpaid", "", "", "", agg.underpaid.toFixed(2), ""].map(csvEscapeField).join(","));
    return lines.join("\r\n");
  }

  function csvFilenameFor() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return "aaa-payment-reconciliation_" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + ".csv";
  }

  window.__CJT_AAA_DIFF_INTERNAL__ = {
    CONFIG: CONFIG,
    parseMoney: parseMoney,
    getCustomField: getCustomField,
    parsePayDateParts: parsePayDateParts,
    mapOpportunity: mapOpportunity,
    distinctYears: distinctYears,
    filterRows: filterRows,
    computeAggregates: computeAggregates,
    sortRowsForDisplay: sortRowsForDisplay,
    buildCsv: buildCsv,
    csvFilenameFor: csvFilenameFor,
    loadAaaOpportunities: loadAaaOpportunities,
  };

  // ---------------------------------------------------------------------
  // UI layer
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--adw-bg:#f5f6f8;--adw-panel:#fff;--adw-border:#e4e4e9;--adw-text:#19191c;--adw-text-dim:#6b7280;--adw-accent:#19191c;--adw-accent-soft:#fff6de;--adw-good:#15803d;--adw-good-soft:#e1f4e8;--adw-crit:#dc2626;--adw-crit-soft:#fbe4e2;--adw-chip-bg:#eef1f5}',
    '#cjt-aaa-diff-root *{box-sizing:border-box}',
    '#cjt-aaa-diff-root{background:var(--adw-bg);color:var(--adw-text);font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px 16px;border-radius:14px}',
    '#cjt-aaa-diff-root .mono{font-family:"Roboto",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}',
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
    '#cjt-aaa-diff-root .tile .n{font-family:"Roboto",monospace;font-size:19px;font-weight:700}',
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
      '<button type="button" class="btn" id="adwRefresh">Refresh data</button>' +
      '<button type="button" class="btn" id="adwExport" disabled>Export current view (CSV)</button>' +
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
    ["adwRefresh", "adwExport", "adwStatus", "adwBody", "adwAsOf", "tExpected", "tActual", "tNet", "tOver", "tUnder", "tCount", "adwNote", "adwTableWrap"]
      .forEach(function (id) { els[id] = root.querySelector("#" + id); });

    var allRows = [];
    var internal = window.__CJT_AAA_DIFF_INTERNAL__;

    // Set by render() to exactly what's currently on screen, so "Export
    // current view" never has to re-derive the filter itself — it always
    // exports precisely what the person is looking at.
    var lastFiltered = [];
    var lastAgg = internal.computeAggregates([]);

    // Always "all" now — see the 2026-10-08 note at the top of this file
    // for why date filtering was pulled rather than left broken.
    function render() {
      var filtered = allRows.slice();
      var agg = internal.computeAggregates(filtered);
      lastFiltered = filtered;
      lastAgg = agg;

      els.tExpected.textContent = money(agg.totalExpected);
      els.tActual.textContent = money(agg.totalActual);
      els.tNet.textContent = money(agg.netDiff);
      els.tNet.className = "n mono " + (agg.netDiff > 0 ? "pos" : agg.netDiff < 0 ? "neg" : "zero");
      els.tOver.textContent = money(agg.overpaid);
      els.tUnder.textContent = money(agg.underpaid);
      els.tCount.textContent = String(agg.count);

      els.adwNote.textContent = agg.noExpectedCount > 0
        ? (agg.noExpectedCount + " job(s) in view have no Expected Tow Amount on file yet (excluded from Expected/Net totals).")
        : "";

      if (filtered.length === 0) {
        els.adwTableWrap.innerHTML = '<div class="adwEmpty">No reconciled AAA payments yet.</div>';
      } else {
        var sorted = internal.sortRowsForDisplay(filtered);
        var body = sorted.map(function (r) {
          var diffClass = r.diff > 0 ? "diffPos" : r.diff < 0 ? "diffNeg" : "";
          return "<tr><td>" + esc(r.wo || "—") + "</td><td>" + esc(r.paymentId || "—") + "</td>" +
            "<td>" + money(r.expected) + "</td><td>" + money(r.gross) + "</td>" +
            '<td class="' + diffClass + '">' + money(r.diff) + "</td>" +
            "<td>" + esc(r.status || "—") + "</td></tr>";
        }).join("");
        els.adwTableWrap.innerHTML =
          '<div class="tableWrap"><table><thead><tr><th>Work Order</th><th>Payment ID</th><th>Expected</th><th>Actual Paid</th><th>Difference</th><th>Status</th></tr></thead><tbody>' +
          body + "</tbody></table></div>";
      }
    }

    function loadData() {
      els.adwRefresh.disabled = true;
      els.adwExport.disabled = true;
      els.adwStatus.className = "adwStatus";
      els.adwStatus.textContent = "Loading reconciled AAA payments…";
      els.adwBody.hidden = true;
      if (!CONFIG.locationId || !CONFIG.privateToken) {
        els.adwStatus.className = "adwStatus err";
        els.adwStatus.textContent = "Missing locationId/privateToken in CJT_CONFIG for this widget.";
        els.adwRefresh.disabled = false;
        return;
      }
      internal.loadAaaOpportunities()
        .then(function (opps) {
          allRows = opps.map(internal.mapOpportunity).filter(function (r) { return r.hasPayment; });
          render();
          els.adwStatus.textContent = "";
          els.adwAsOf.textContent = "As of " + new Date().toLocaleTimeString();
          els.adwBody.hidden = false;
          els.adwExport.disabled = false;
        })
        .catch(function (err) {
          els.adwStatus.className = "adwStatus err";
          els.adwStatus.textContent = "Couldn't load AAA payment data: " + err.message;
        })
        .finally(function () { els.adwRefresh.disabled = false; });
    }

    // Downloads exactly what render() last put on screen — a client-side
    // Blob + temporary <a download>, no server round trip, so it works the
    // same way inside a GHL iframe as every other write-free action in
    // these tools.
    function downloadCsv(filename, text) {
      var blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    els.adwRefresh.addEventListener("click", loadData);
    els.adwExport.addEventListener("click", function () {
      downloadCsv(internal.csvFilenameFor(), internal.buildCsv(lastFiltered, lastAgg));
    });

    loadData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

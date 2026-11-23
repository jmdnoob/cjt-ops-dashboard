/*!
 * CJT AAA Reconciled Items -> Mark Paid tool.
 * Hosted on GitHub next to dashboard.js/setup.js/aaa-diff-widget.js, loaded
 * the same way (jsDelivr). Same pasted CJT_CONFIG block as those files.
 *
 * What this is for: setup.js's statement-import "Apply" step auto-flips an
 * Opportunity's "Payment Status" custom field from Unpaid -> Reconciled the
 * moment it writes AAA Pay Date (see setup.js's writeOpportunityFields()
 * comment, added 2026-11-23). "Reconciled" means the statement import
 * matched and wrote the payment fields -- it does NOT mean AAA's actual
 * bank deposit has been checked yet. This tool is the next, deliberate step:
 * pick a Pay Date range, see every Opportunity sitting at "Reconciled" in
 * that range, and -- only after confirming AAA's real payment matches --
 * select some or all of them and bulk-write Payment Status -> "Paid".
 *
 * Nothing here ever writes "Reconciled" -- only setup.js's import does
 * that. This tool's only write is Reconciled -> Paid, and only for rows you
 * explicitly check and confirm.
 *
 * ============================================================================
 * WHAT TO PASTE INTO GHL (Website/Funnel builder -> Custom HTML/CSS/JS
 * element) -- e.g. its own "AAA Reconciliation" page, or alongside the
 * Payment Difference widget on the Dashboard page:
 *
 *   <div id="cjt-aaa-paid-root"></div>
 *   <script>
 *     // Same CJT_CONFIG block already pasted on your dashboard/setup pages.
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
 *       dispatchPipelineName: "Towing Dispatch"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/jmdnoob/cjt-ops-dashboard@main/aaa-reconciled-paid-tool.js"></script>
 *
 * Use "@main", not "@latest" -- see the same note on setup.js/dashboard.js.
 * ============================================================================
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config -- same shape as setup.js/dashboard.js/aaa-diff-widget.js.
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
  // GHL API client -- identical rate-limit pacing + 429 retry/backoff as
  // setup.js/dashboard.js/aaa-diff-widget.js.
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
        return res.status === 204 ? {} : res.json();
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
  // Custom-field resolution -- same by-name idiom as setup.js, with
  // paymentStatus added (new 2026-11-23 field, no fallback ID -- resolved
  // purely by name, same reasoning as setup.js's own paymentStatus entry).
  // ---------------------------------------------------------------------
  var FIELD_ID_FALLBACKS = {
    workOrderNumber: ["gkJwODzLAFBtALkbUm54", "Oz3NeGwx2PxgrzaihYWl"],
    expectedTowAmount: ["G3NwXSgdfozNGLPpxnzx"],
    aaaPaymentId: ["PwhfIoJkhnhlcLlU855m"],
    aaaGrossPaid: ["x6BZnE668LiqEk76S1TW"],
    aaaPayDate: ["2ERL2vncdpLAjD027qXz"],
    aaaPaymentDifference: [],
    paymentStatus: [],
  };
  var FIELD_NAME_CANDIDATES = {
    workOrderNumber: ["work order number"],
    expectedTowAmount: ["expected tow amount"],
    aaaPaymentId: ["aaa payment id"],
    aaaGrossPaid: ["aaa gross paid amount"],
    aaaPayDate: ["aaa pay date"],
    aaaPaymentDifference: ["aaa payment difference"],
    paymentStatus: ["payment status"],
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
  function fieldId(key) {
    return (resolvedFields && resolvedFields.ids[key]) || null;
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
      if (fieldIds.indexOf(fields[i].id) !== -1) {
        var f = fields[i];
        if (f.fieldValue !== undefined) return f.fieldValue;
        if (f.fieldValueString !== undefined) return f.fieldValueString;
        if (f.fieldValueNumber !== undefined) return f.fieldValueNumber;
        if (f.fieldValueDate !== undefined) return f.fieldValueDate;
        if (f.fieldValueArray !== undefined) return f.fieldValueArray;
        return null;
      }
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

  // Same digit-parsing approach as aaa-diff-widget.js's parsePayDateParts,
  // but returns a sortable/comparable "YYYY-MM-DD" string (full date, not
  // just year/month) since this tool filters by an actual date RANGE, not
  // a year+month picker.
  function parsePayDateISO(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
    var mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (mdy) return mdy[3] + "-" + pad(Number(mdy[1])) + "-" + pad(Number(mdy[2]));
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return null;
  }

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

  function mapOpportunity(o) {
    var gross = parseMoney(getCustomField(o, fieldIdsFor("aaaGrossPaid")));
    var expected = parseMoney(getCustomField(o, fieldIdsFor("expectedTowAmount")));
    var paymentId = getCustomField(o, fieldIdsFor("aaaPaymentId"));
    var payDate = getCustomField(o, fieldIdsFor("aaaPayDate"));
    var storedDiff = parseMoney(getCustomField(o, fieldIdsFor("aaaPaymentDifference")));
    var diff = (gross != null && expected != null) ? (gross - expected) : storedDiff;
    var paymentStatus = getCustomField(o, fieldIdsFor("paymentStatus"));
    return {
      recordId: o.id,
      paymentId: paymentId || null,
      wo: getCustomField(o, fieldIdsFor("workOrderNumber")) || null,
      payDate: payDate || null,
      payDateIso: parsePayDateISO(payDate),
      paymentStatus: paymentStatus || null,
      gross: gross,
      expected: expected,
      diff: diff,
    };
  }

  // Only rows sitting at "Reconciled" are this tool's business -- Unpaid
  // rows have nothing to act on yet, and Paid rows are already done.
  function reconciledRows(rows) {
    return rows.filter(function (r) { return String(r.paymentStatus || "").trim().toLowerCase() === "reconciled"; });
  }

  // from/to are "YYYY-MM-DD" strings or "" (no bound on that side). A row
  // with no parseable Pay Date never matches a real range (nothing to
  // compare), but still shows up when no range is set at all.
  function filterByDateRange(rows, from, to) {
    if (!from && !to) return rows.slice();
    return rows.filter(function (r) {
      if (!r.payDateIso) return false;
      if (from && r.payDateIso < from) return false;
      if (to && r.payDateIso > to) return false;
      return true;
    });
  }

  function sortRowsForDisplay(rows) {
    return rows.slice().sort(function (a, b) {
      var ad = a.payDateIso || "", bd = b.payDateIso || "";
      if (ad !== bd) return ad.localeCompare(bd);
      return String(a.wo || "").localeCompare(String(b.wo || ""), undefined, { numeric: true });
    });
  }

  // ---------------------------------------------------------------------
  // Bulk write -- Reconciled -> Paid, sequential with progress (same
  // rate-limit-respecting queue shape as setup.js's applyReconciliation()).
  // ---------------------------------------------------------------------
  function markPaid(recordIds, onProgress) {
    var results = [];
    var i = 0;
    function next() {
      if (i >= recordIds.length) return Promise.resolve(results);
      var id = recordIds[i];
      i += 1;
      return ghlApi("/opportunities/" + id, {
        method: "PUT",
        version: CONFIG.apiVersions.opportunities,
        body: { customFields: [{ id: fieldId("paymentStatus"), fieldValue: "Paid" }] },
      }).then(function (r) {
        results.push({ id: id, ok: true });
        if (onProgress) onProgress(results.length, recordIds.length);
        return next();
      }).catch(function (err) {
        results.push({ id: id, ok: false, error: String((err && err.message) || err) });
        if (onProgress) onProgress(results.length, recordIds.length);
        return next();
      });
    }
    return next();
  }

  window.__CJT_AAA_PAID_INTERNAL__ = {
    CONFIG: CONFIG, parseMoney: parseMoney, parsePayDateISO: parsePayDateISO,
    mapOpportunity: mapOpportunity, reconciledRows: reconciledRows,
    filterByDateRange: filterByDateRange, sortRowsForDisplay: sortRowsForDisplay,
    loadAaaOpportunities: loadAaaOpportunities, markPaid: markPaid,
  };

  // ---------------------------------------------------------------------
  // UI layer
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--apt-bg:#f5f6f8;--apt-panel:#fff;--apt-border:#e4e4e9;--apt-text:#19191c;--apt-text-dim:#6b7280;--apt-accent:#19191c;--apt-good:#15803d;--apt-good-soft:#e1f4e8;--apt-crit:#dc2626}',
    '#cjt-aaa-paid-root *{box-sizing:border-box}',
    '#cjt-aaa-paid-root{background:var(--apt-bg);color:var(--apt-text);font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px 16px;border-radius:14px}',
    '#cjt-aaa-paid-root .mono{font-family:"Roboto",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}',
    '#cjt-aaa-paid-root .aptTop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}',
    '#cjt-aaa-paid-root h2{font-size:16px;margin:0;font-weight:700}',
    '#cjt-aaa-paid-root .aptAsOf{font-size:11.5px;color:var(--apt-text-dim)}',
    '#cjt-aaa-paid-root .aptFilters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}',
    '#cjt-aaa-paid-root label.aptLbl{font-size:11.5px;color:var(--apt-text-dim);display:flex;flex-direction:column;gap:3px}',
    '#cjt-aaa-paid-root input[type=date]{border:1px solid var(--apt-border);border-radius:8px;padding:6px 9px;font-size:13px;font-family:inherit;background:var(--apt-panel);color:var(--apt-text)}',
    '#cjt-aaa-paid-root .btn{appearance:none;border:1px solid var(--apt-border);background:var(--apt-panel);color:var(--apt-text);font-family:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px;cursor:pointer}',
    '#cjt-aaa-paid-root .btn:hover{border-color:var(--apt-accent);color:var(--apt-accent)}',
    '#cjt-aaa-paid-root .btn:disabled{opacity:.5;cursor:not-allowed}',
    '#cjt-aaa-paid-root .btn.primary{background:var(--apt-good);border-color:var(--apt-good);color:#fff}',
    '#cjt-aaa-paid-root .btn.primary:hover{opacity:.9;border-color:var(--apt-good);color:#fff}',
    '#cjt-aaa-paid-root .aptStatus{font-size:12.5px;color:var(--apt-text-dim);margin-bottom:12px}',
    '#cjt-aaa-paid-root .aptStatus.err{color:var(--apt-crit)}',
    '#cjt-aaa-paid-root .aptStatus.ok{color:var(--apt-good)}',
    '#cjt-aaa-paid-root .aptBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--apt-panel);border:1px solid var(--apt-border);border-radius:10px;padding:10px 14px;margin-bottom:12px}',
    '#cjt-aaa-paid-root .aptBar .aptCount{font-size:13px;font-weight:600}',
    '#cjt-aaa-paid-root .tableWrap{background:var(--apt-panel);border:1px solid var(--apt-border);border-radius:10px;overflow-x:auto}',
    '#cjt-aaa-paid-root table{border-collapse:collapse;width:100%;font-size:12.5px;min-width:680px}',
    '#cjt-aaa-paid-root thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--apt-text-dim);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--apt-border);white-space:nowrap}',
    '#cjt-aaa-paid-root tbody td{padding:8px 12px;border-bottom:1px solid var(--apt-border);white-space:nowrap}',
    '#cjt-aaa-paid-root tbody tr:last-child td{border-bottom:none}',
    '#cjt-aaa-paid-root tbody tr.aptChecked{background:var(--apt-good-soft)}',
    '#cjt-aaa-paid-root .diffPos{color:var(--apt-crit);font-weight:600}',
    '#cjt-aaa-paid-root .diffNeg{color:var(--apt-good);font-weight:600}',
    '#cjt-aaa-paid-root .aptEmpty{padding:18px;text-align:center;color:var(--apt-text-dim);font-size:13px}'
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
    var root = document.getElementById("cjt-aaa-paid-root");
    if (!root) {
      console.error("[CJT AAA Reconciled->Paid tool] #cjt-aaa-paid-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);

    root.innerHTML =
      '<div class="aptTop"><h2>AAA Reconciled Items — Mark Paid</h2><span class="aptAsOf" id="aptAsOf"></span></div>' +
      '<div class="aptFilters">' +
      '<label class="aptLbl">Pay date from<input type="date" id="aptFrom"></label>' +
      '<label class="aptLbl">Pay date to<input type="date" id="aptTo"></label>' +
      '<button type="button" class="btn" id="aptRefresh" style="align-self:flex-end;">Refresh data</button>' +
      '</div>' +
      '<div class="aptStatus" id="aptStatus">Loading…</div>' +
      '<div id="aptBody" hidden>' +
      '<div class="aptBar">' +
      '<span class="aptCount" id="aptCount">0 selected</span>' +
      '<button type="button" class="btn primary" id="aptMarkPaid" disabled>Mark selected Paid</button>' +
      '</div>' +
      '<div id="aptTableWrap"></div>' +
      '</div>';

    var els = {};
    ["aptFrom", "aptTo", "aptRefresh", "aptStatus", "aptBody", "aptAsOf", "aptCount", "aptMarkPaid", "aptTableWrap"]
      .forEach(function (id) { els[id] = root.querySelector("#" + id); });

    var internal = window.__CJT_AAA_PAID_INTERNAL__;
    var allRows = [];
    var lastFiltered = [];
    var checked = {}; // recordId -> true

    function selectedIds() {
      return Object.keys(checked).filter(function (id) { return checked[id]; });
    }

    function renderBar() {
      var n = selectedIds().length;
      els.aptCount.textContent = n + " selected";
      els.aptMarkPaid.disabled = n === 0;
    }

    function render() {
      var filtered = internal.filterByDateRange(internal.reconciledRows(allRows), els.aptFrom.value, els.aptTo.value);
      lastFiltered = filtered;
      checked = {};
      renderBar();

      if (filtered.length === 0) {
        els.aptTableWrap.innerHTML = '<div class="aptEmpty">No Reconciled AAA jobs in this range — nothing waiting on a bulk Paid update right now.</div>';
        return;
      }
      var sorted = internal.sortRowsForDisplay(filtered);
      var body = sorted.map(function (r) {
        var diffClass = r.diff > 0 ? "diffPos" : r.diff < 0 ? "diffNeg" : "";
        return '<tr data-id="' + esc(r.recordId) + '">' +
          '<td><input type="checkbox" class="aptRowCheck" data-id="' + esc(r.recordId) + '"></td>' +
          "<td>" + esc(r.wo || "—") + "</td>" +
          "<td>" + esc(r.paymentId || "—") + "</td>" +
          "<td>" + esc(r.payDate || "—") + "</td>" +
          "<td>" + money(r.expected) + "</td>" +
          "<td>" + money(r.gross) + "</td>" +
          '<td class="' + diffClass + '">' + money(r.diff) + "</td>" +
          "</tr>";
      }).join("");
      els.aptTableWrap.innerHTML =
        '<div class="tableWrap"><table><thead><tr>' +
        '<th><input type="checkbox" id="aptSelectAll"></th>' +
        "<th>Work Order</th><th>Payment ID</th><th>Pay Date</th><th>Expected</th><th>Actual Paid</th><th>Difference</th>" +
        "</tr></thead><tbody>" + body + "</tbody></table></div>";

      var selectAll = els.aptTableWrap.querySelector("#aptSelectAll");
      selectAll.addEventListener("change", function () {
        els.aptTableWrap.querySelectorAll(".aptRowCheck").forEach(function (cb) {
          cb.checked = selectAll.checked;
          checked[cb.dataset.id] = selectAll.checked;
          cb.closest("tr").classList.toggle("aptChecked", selectAll.checked);
        });
        renderBar();
      });
      els.aptTableWrap.querySelectorAll(".aptRowCheck").forEach(function (cb) {
        cb.addEventListener("change", function () {
          checked[cb.dataset.id] = cb.checked;
          cb.closest("tr").classList.toggle("aptChecked", cb.checked);
          renderBar();
        });
      });
    }

    function loadData() {
      els.aptRefresh.disabled = true;
      els.aptMarkPaid.disabled = true;
      els.aptStatus.className = "aptStatus";
      els.aptStatus.textContent = "Loading reconciled AAA jobs…";
      els.aptBody.hidden = true;
      if (!CONFIG.locationId || !CONFIG.privateToken) {
        els.aptStatus.className = "aptStatus err";
        els.aptStatus.textContent = "Missing locationId/privateToken in CJT_CONFIG for this tool.";
        els.aptRefresh.disabled = false;
        return;
      }
      internal.loadAaaOpportunities()
        .then(function (opps) {
          allRows = opps.map(internal.mapOpportunity);
          render();
          els.aptStatus.textContent = "";
          els.aptAsOf.textContent = "As of " + new Date().toLocaleTimeString();
          els.aptBody.hidden = false;
        })
        .catch(function (err) {
          els.aptStatus.className = "aptStatus err";
          els.aptStatus.textContent = "Couldn't load AAA payment data: " + err.message;
        })
        .finally(function () { els.aptRefresh.disabled = false; });
    }

    els.aptRefresh.addEventListener("click", loadData);
    els.aptFrom.addEventListener("change", render);
    els.aptTo.addEventListener("change", render);

    els.aptMarkPaid.addEventListener("click", function () {
      var ids = selectedIds();
      if (ids.length === 0) return;
      var ok = window.confirm(
        "Mark " + ids.length + " reconciled job(s) as Paid?\n\n" +
        "Only do this after checking AAA's actual deposit matches these jobs' statement amounts — this cannot be undone from here."
      );
      if (!ok) return;
      els.aptMarkPaid.disabled = true;
      els.aptRefresh.disabled = true;
      els.aptStatus.className = "aptStatus";
      els.aptStatus.textContent = "Marking 0 / " + ids.length + " Paid…";
      internal.markPaid(ids, function (done, total) {
        els.aptStatus.textContent = "Marking " + done + " / " + total + " Paid…";
      }).then(function (results) {
        var failed = results.filter(function (r) { return !r.ok; });
        if (failed.length === 0) {
          els.aptStatus.className = "aptStatus ok";
          els.aptStatus.textContent = "Marked " + results.length + " job(s) Paid.";
        } else {
          els.aptStatus.className = "aptStatus err";
          els.aptStatus.textContent = failed.length + " of " + results.length + " failed: " + failed[0].error +
            (failed.length > 1 ? " (+" + (failed.length - 1) + " more)" : "");
        }
        return loadDataQuiet();
      });
    });

    // Re-pulls fresh data after a Mark Paid run without stomping the status
    // line loadData() would otherwise reset to "Loading…".
    function loadDataQuiet() {
      return internal.loadAaaOpportunities().then(function (opps) {
        allRows = opps.map(internal.mapOpportunity);
        render();
        els.aptAsOf.textContent = "As of " + new Date().toLocaleTimeString();
      }).finally(function () { els.aptRefresh.disabled = false; });
    }

    loadData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

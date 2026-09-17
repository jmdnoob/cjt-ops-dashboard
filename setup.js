/*!
 * CJT Ops Setup — admin-only config generator + AAA payment-statement import.
 * Hosted on GitHub next to dashboard.js, loaded the same way (jsDelivr).
 *
 * ============================================================================
 * WHAT TO PASTE INTO THE "Setup" GHL PAGE (Website/Funnel builder -> Custom
 * HTML/CSS/JS element). Use a Custom Menu Link to this page's own GHL URL,
 * set to "Embedded iframe", and set Role-Based Visibility to Admins only —
 * this page can read/write live GHL data with the same token as the
 * dashboard, so it should never be reachable by non-admin staff.
 *
 *   <div id="cjt-setup-root"></div>
 *   <script>
 *     // Same CJT_CONFIG block as the dashboard page — paste the dashboard's
 *     // current config here too so Setup starts pre-filled with real values
 *     // instead of blank fields. If this is the very first setup for a new
 *     // client, leave it as {} and fill in the form instead.
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
 *       ghlBase: "https://app.THEIRDOMAIN.com",
 *       dispatchPipelineName: "Towing Dispatch",
 *       baseTowRate: 85,
 *       mileageRate: 3,
 *       setupUrl: "https://THEIRDOMAIN.com/setup"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@latest/setup.js"></script>
 *
 * Optional: extensionRepo/extensionMacAsset/extensionWindowsAsset in
 * CJT_CONFIG control the "6. AAA Work Order Extractor" download button
 * (section 6 below) — defaults to this same GitHub repo's Releases if
 * omitted, so most clients never need to set these.
 *
 * After changing anything here, use "Generate dashboard snippet" at the
 * bottom of the Connection section and paste the updated block onto BOTH
 * the dashboard page and this Setup page — there is no shared backend, the
 * GHL page source *is* the config, on both pages independently.
 *
 * UNVERIFIED — confirm against a real token before relying on this in front
 * of a client (see README.md "What still needs testing"):
 *   - The exact write shape for POST /objects/aaa_payments/records — this
 *     file writes currency-shaped properties (gross_paid_amount,
 *     expected_tow_amount, payment_difference_value) as plain numbers,
 *     matching how they read back via propVal() elsewhere in this project,
 *     but that has not been confirmed against a real write yet. Run one
 *     import in preview-only mode, then Apply on a SMALL statement first,
 *     and check the created record in GHL before trusting this at scale.
 *   - Custom field IDs below (work order / expected tow amount / AAA payment
 *     fields on the Opportunity) are copied from CJ Taylor Towing's real,
 *     already-live AAA-GHL-Extractor tool (import_aaa_payments.py /
 *     native-host main.go) — confirmed for THIS client, but a different
 *     client's GHL location will have different field IDs for the
 *     equivalent custom fields on their Opportunities, if they even have
 *     them. Re-derive these per client (LIST-GHL-FIELDS-style lookup) rather
 *     than reusing CJ Taylor Towing's IDs.
 * ============================================================================
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config (same shape/merge pattern as dashboard.js)
  // ---------------------------------------------------------------------
  var DEFAULTS = {
    apiBase: "https://services.leadconnectorhq.com",
    ghlBase: "",
    locationId: "",
    privateToken: "",
    dispatchPipelineName: "Towing Dispatch",
    baseTowRate: 85,
    mileageRate: 3,
    setupUrl: "",
    passcodeHash: "",
    idleLockMinutes: 10,
    // Where the AAA Work Order Extractor browser-extension installer zips
    // are published as GitHub Releases assets — same repo this file is
    // hosted in by default, but overridable per deployment (e.g. a
    // reseller's own fork/org). See "6. Extension download" below and
    // README.md "Distributing the extension" for the release/asset naming
    // convention this points at.
    extensionRepo: "jmdnoob/cjt-ops-dashboard",
    extensionMacAsset: "AAA-GHL-Extractor-Mac.zip",
    extensionWindowsAsset: "",
    objectKeys: {
      drivers: "driver_profiles",
      fleet: "trucks",
      maintenance: "maintenance_records",
      training: "training_records",
      quarters: "driver_quarters",
      aaa: "aaa_payments",
    },
    apiVersions: {
      pipelines: "v3",
      opportunities: "2021-07-28",
      objects: "v3",
    },
  };

  var CONFIG = Object.assign({}, DEFAULTS, window.CJT_CONFIG || {});
  CONFIG.objectKeys = Object.assign({}, DEFAULTS.objectKeys, (window.CJT_CONFIG || {}).objectKeys || {});
  CONFIG.apiVersions = Object.assign({}, DEFAULTS.apiVersions, (window.CJT_CONFIG || {}).apiVersions || {});

  // Opportunity custom-field IDs the existing (already-live) AAA-GHL-Extractor
  // reconciliation tool writes to — copied verbatim from
  // import_aaa_payments.py / native-host/src/main.go. These are FALLBACKS
  // ONLY now: GHL regenerates a new internal ID for every custom field when
  // a snapshot is cloned into a new sub-account, even though the field
  // *name* stays identical — so a hardcoded ID here would only ever work
  // for CJ Taylor Towing's own location. resolveFieldIds() below looks these
  // same fields up BY NAME through GHL's own customFields API instead, which
  // works for any sub-account cloned from the same snapshot with zero
  // per-client configuration. These constants are what resolveFieldIds()
  // falls back to if a name lookup comes up empty (e.g. the token lacks the
  // Custom Fields scope, or a field was renamed) — for CJ Taylor Towing's
  // own location specifically, so today's live setup keeps working even
  // before the dynamic path has been verified.
  var FIELD_ID_FALLBACKS = {
    workOrderNumber: ["gkJwODzLAFBtALkbUm54", "Oz3NeGwx2PxgrzaihYWl"],
    expectedTowAmount: ["G3NwXSgdfozNGLPpxnzx"],
    aaaPaymentId: ["PwhfIoJkhnhlcLlU855m"],
    aaaGrossPaid: ["x6BZnE668LiqEk76S1TW"],
    aaaPayDate: ["2ERL2vncdpLAjD027qXz"],
    aaaPaidTowMiles: ["B3fIEak2zCjLV5Gjcy6U"],
    aaaPaymentDifference: ["lgDu30kVqm1wJGaCp8o3"],
  };

  // Candidate GHL field *names* to match, case/whitespace-insensitive, per
  // logical field. These are inferred from the labels the existing Python
  // tool already prints for these same fields (import_aaa_payments.py's
  // DIRECT_FIELD_MAP), not independently re-confirmed against a live
  // customFields dump in this session — see the UNVERIFIED note at the top
  // of this file. Re-run "Test connection" on a real sub-account and check
  // the field-mapping result before trusting this on a new client; add a
  // name variant here if a client's actual field is named slightly
  // differently.
  var FIELD_NAME_CANDIDATES = {
    workOrderNumber: ["work order number"],
    expectedTowAmount: ["expected tow amount"],
    aaaPaymentId: ["aaa payment id"],
    aaaGrossPaid: ["aaa gross paid amount"],
    aaaPayDate: ["aaa pay date"],
    aaaPaidTowMiles: ["aaa paid tow miles"],
    aaaPaymentDifference: ["aaa payment difference"],
  };

  // Filled in by resolveFieldIds() (called from "Test connection" and again
  // before any import run, so it's never stale). null until first resolved.
  var resolvedFields = null; // { ids: {key: id|null}, source: {key: "name"|"fallback"|"missing"}, allFields: [...] }

  // Looks up this location's actual custom field definitions and matches
  // each logical AAA field by name. Confirmed real endpoint/shape — see
  // AAA-GHL-Extractor's own LIST-GHL-FIELDS.command, which calls this same
  // GET .../customFields (with and without ?model=opportunity) and reads
  // {id, name, fieldKey, dataType} off each entry.
  function fetchCustomFieldDefs(model) {
    var path = "/locations/" + CONFIG.locationId + "/customFields" + (model ? "?model=" + encodeURIComponent(model) : "");
    return ghlApi(path, { version: "v3" }).then(function (res) {
      return Array.isArray(res) ? res : res.customFields || [];
    });
  }

  function resolveFieldIds() {
    return Promise.all([fetchCustomFieldDefs(), fetchCustomFieldDefs("opportunity")]).then(function (results) {
      var byId = {};
      results[0].concat(results[1]).forEach(function (f) {
        if (f && f.id) byId[f.id] = f;
      });
      var allFields = Object.keys(byId).map(function (id) { return byId[id]; });
      var ids = {};
      var source = {};
      Object.keys(FIELD_NAME_CANDIDATES).forEach(function (key) {
        var candidates = FIELD_NAME_CANDIDATES[key];
        var match = allFields.filter(function (f) {
          return candidates.indexOf(String(f.name || "").trim().toLowerCase()) !== -1;
        })[0];
        if (match) {
          ids[key] = match.id;
          source[key] = "name";
        } else if (FIELD_ID_FALLBACKS[key] && FIELD_ID_FALLBACKS[key][0]) {
          ids[key] = FIELD_ID_FALLBACKS[key][0];
          source[key] = "fallback";
        } else {
          ids[key] = null;
          source[key] = "missing";
        }
      });
      resolvedFields = { ids: ids, source: source, allFields: allFields };
      return resolvedFields;
    });
  }

  // Single-field-id accessor used everywhere below. Falls back to the
  // hardcoded CJ-Taylor-Towing id if resolveFieldIds() hasn't run yet in
  // this page load (shouldn't normally happen — callers run it first).
  function fieldId(key) {
    if (resolvedFields && resolvedFields.ids[key]) return resolvedFields.ids[key];
    return (FIELD_ID_FALLBACKS[key] && FIELD_ID_FALLBACKS[key][0]) || null;
  }
  function fieldIdsFor(key) {
    // getCustomField() below matches against a *list* of ids (to also catch
    // older records written under a previous/renamed field) — resolved id
    // first, then any fallback ids as extra candidates.
    var out = [];
    var resolved = resolvedFields && resolvedFields.ids[key];
    if (resolved) out.push(resolved);
    (FIELD_ID_FALLBACKS[key] || []).forEach(function (id) {
      if (out.indexOf(id) === -1) out.push(id);
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // GHL API client (identical to dashboard.js)
  // ---------------------------------------------------------------------
  function ghlApi(path, opts) {
    opts = opts || {};
    var headers = {
      Authorization: "Bearer " + CONFIG.privateToken,
      Version: opts.version || CONFIG.apiVersions.objects,
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(CONFIG.apiBase + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("GHL API " + res.status + " " + path + ": " + t.slice(0, 300));
        });
      }
      return res.json();
    });
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
    var limit = 100;
    var page = 1;
    var all = [];
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

  function getOpportunity(id) {
    return ghlApi("/opportunities/" + id, { version: CONFIG.apiVersions.opportunities }).then(function (res) {
      return res.opportunity || res;
    });
  }

  function getCustomField(opp, fieldIds) {
    var fields = opp.customFields || [];
    for (var i = 0; i < fields.length; i++) {
      if (fieldIds.indexOf(fields[i].id) !== -1) return fields[i].fieldValue;
    }
    return null;
  }

  // Runs `fn` over `items` with at most `limit` in flight at once, calling
  // `onProgress(done, total)` after each one finishes. Used for the
  // per-opportunity GET calls below (a full pipeline can be a few hundred
  // opportunities, and this project's own confirmed lesson — see
  // import_aaa_payments.py's docstring — is that /opportunities/search's
  // customFields payload is not reliably complete, so a per-opportunity GET
  // is the only trustworthy way to read Work Order Number).
  function mapWithConcurrency(items, limit, fn, onProgress) {
    var results = new Array(items.length);
    var next = 0;
    var done = 0;
    return new Promise(function (resolve, reject) {
      var failed = false;
      function pump() {
        if (failed) return;
        if (done === items.length) return resolve(results);
        while (next < items.length && next - done < limit) {
          (function (i) {
            next += 1;
            fn(items[i], i)
              .then(function (r) {
                results[i] = r;
                done += 1;
                if (onProgress) onProgress(done, items.length);
                pump();
              })
              .catch(function (err) {
                failed = true;
                reject(err);
              });
          })(next);
        }
      }
      if (items.length === 0) resolve(results);
      else pump();
    });
  }

  // ---------------------------------------------------------------------
  // Reconciliation engine — ports import_aaa_payments.py's matching logic
  // to run client-side against a live GHL token, instead of a local script.
  // ---------------------------------------------------------------------
  function parseMoney(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === "") return null;
    s = s.replace(/\$/g, "").replace(/,/g, "").trim();
    if (s[0] === "(" && s[s.length - 1] === ")") s = "-" + s.slice(1, -1);
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // Case/whitespace-insensitive header lookup with a list of accepted
  // aliases per field, since AAA's export column names can vary a little
  // between statements (confirmed with the client: statements arrive as
  // both CSV/Excel and, sometimes, PDF — this handles CSV/Excel; see the
  // "paste table text" fallback in the UI layer for PDF).
  var COLUMN_ALIASES = {
    wo: ["work order: work order number", "work order number", "wo number", "work order"],
    paymentId: ["payment id"],
    grossAmount: ["gross amount", "gross paid amount", "amount paid"],
    payDate: ["pay date", "payment date"],
    towMileage: ["tow mileage", "miles", "tow miles"],
  };

  function normalizeHeader(h) {
    return String(h || "").trim().toLowerCase();
  }

  function pickCol(row, aliasKey) {
    var aliases = COLUMN_ALIASES[aliasKey];
    var keys = Object.keys(row);
    for (var a = 0; a < aliases.length; a++) {
      for (var k = 0; k < keys.length; k++) {
        if (normalizeHeader(keys[k]) === aliases[a]) {
          var v = row[keys[k]];
          return v === undefined || v === null ? "" : String(v).trim();
        }
      }
    }
    return "";
  }

  // Builds { workOrderNumber -> { id, name, existingPaymentId, expectedTowAmount } }
  // for every Opportunity in the dispatch pipeline that has a Work Order
  // Number on file. onProgress(done, total) reports per-opportunity fetch
  // progress for a UI progress bar.
  function buildWoMap(onProgress) {
    // Re-resolve every run (cheap — one or two GET calls) rather than trust
    // a stale cache, since the config (and therefore the location) can
    // change between runs in the same page load.
    return resolveFieldIds().then(function () {
      return loadPipelines();
    }).then(function (pipelines) {
      var pipeline = pipelines.filter(function (p) {
        return (p.name || "").toLowerCase() === CONFIG.dispatchPipelineName.toLowerCase();
      })[0];
      if (!pipeline) throw new Error('No pipeline named "' + CONFIG.dispatchPipelineName + '" found in this GHL location.');
      var woFieldIds = fieldIdsFor("workOrderNumber");
      var paymentIdFieldIds = fieldIdsFor("aaaPaymentId");
      var expectedFieldIds = fieldIdsFor("expectedTowAmount");
      return loadAllOpportunities(pipeline.id).then(function (opps) {
        return mapWithConcurrency(
          opps,
          6,
          function (o) { return getOpportunity(o.id); },
          onProgress
        ).then(function (fullOpps) {
          var woMap = {};
          fullOpps.forEach(function (full) {
            if (!full) return;
            var wo = getCustomField(full, woFieldIds);
            if (!wo) return;
            wo = String(wo).trim();
            if (!wo) return;
            woMap[wo] = {
              id: full.id,
              name: full.name,
              existingPaymentId: getCustomField(full, paymentIdFieldIds),
              expectedTowAmount: parseMoney(getCustomField(full, expectedFieldIds)),
            };
          });
          return { woMap: woMap, pipelineName: pipeline.name, opportunityCount: opps.length };
        });
      });
    });
  }

  // Reconciles parsed statement rows against a pre-built woMap. Pure
  // function, no network — this is what the preview UI runs, and it's also
  // exactly what the "Apply" step re-derives right before writing, so a
  // preview never goes stale silently.
  function reconcile(rows, woMap) {
    var result = { noWo: [], noMatch: [], alreadyReconciled: [], toWrite: [] };
    rows.forEach(function (row) {
      var wo = pickCol(row, "wo");
      if (!wo) {
        result.noWo.push(row);
        return;
      }
      var opp = woMap[wo];
      if (!opp) {
        result.noMatch.push({ wo: wo, row: row });
        return;
      }
      var paymentId = pickCol(row, "paymentId");
      if (opp.existingPaymentId && String(opp.existingPaymentId).trim() === paymentId) {
        result.alreadyReconciled.push({ wo: wo, row: row, opp: opp });
        return;
      }
      var grossAmount = parseMoney(pickCol(row, "grossAmount"));
      var payDate = pickCol(row, "payDate");
      var towMileage = pickCol(row, "towMileage");
      var expected = opp.expectedTowAmount;
      var hasExpected = expected !== null && expected !== undefined;
      var diff = hasExpected && grossAmount !== null ? grossAmount - expected : null;
      var status = hasExpected ? "matched" : "exception";
      var exceptionReason = hasExpected ? "" : "Matched Opportunity has no Expected Tow Amount on file yet.";
      result.toWrite.push({
        wo: wo,
        paymentId: paymentId,
        grossAmount: grossAmount,
        payDate: payDate,
        towMileage: towMileage,
        opp: opp,
        expectedTowAmount: expected,
        diff: diff,
        status: status,
        exceptionReason: exceptionReason,
      });
    });
    return result;
  }

  // ---------------------------------------------------------------------
  // Write step — mirrors import_aaa_payments.py's --apply path (PUT onto
  // the matched Opportunity) and additionally creates/updates a record in
  // the aaa_payments custom object, which is what the CJT Ops Dashboard's
  // "AAA Payments" section actually reads (see the UNVERIFIED note above —
  // that second part's exact write shape hasn't been confirmed live yet).
  // ---------------------------------------------------------------------
  function writeOpportunityFields(item) {
    var customFields = [];
    if (item.paymentId && fieldId("aaaPaymentId")) customFields.push({ id: fieldId("aaaPaymentId"), fieldValue: item.paymentId });
    if (item.grossAmount !== null && fieldId("aaaGrossPaid")) customFields.push({ id: fieldId("aaaGrossPaid"), fieldValue: String(item.grossAmount) });
    if (item.payDate && fieldId("aaaPayDate")) customFields.push({ id: fieldId("aaaPayDate"), fieldValue: item.payDate });
    if (item.towMileage && fieldId("aaaPaidTowMiles")) customFields.push({ id: fieldId("aaaPaidTowMiles"), fieldValue: item.towMileage });
    if (item.diff !== null && fieldId("aaaPaymentDifference")) customFields.push({ id: fieldId("aaaPaymentDifference"), fieldValue: item.diff.toFixed(2) });
    if (customFields.length === 0) return Promise.resolve({ skipped: true });
    return ghlApi("/opportunities/" + item.opp.id, {
      method: "PUT",
      version: CONFIG.apiVersions.opportunities,
      body: { customFields: customFields },
    });
  }

  function writeAaaRecord(item) {
    var properties = {
      aaa_payment_id: item.paymentId || null,
      work_order_number: item.wo,
      gross_paid_amount: item.grossAmount,
      expected_tow_amount: item.expectedTowAmount,
      payment_difference_value: item.diff,
      reconciliation_status: item.status,
      exception_reason: item.exceptionReason || null,
    };
    return ghlApi("/objects/" + CONFIG.objectKeys.aaa + "/records", {
      method: "POST",
      version: CONFIG.apiVersions.objects,
      body: { locationId: CONFIG.locationId, properties: properties },
    });
  }

  function writeUnmatchedAaaRecord(wo, row) {
    var properties = {
      aaa_payment_id: pickCol(row, "paymentId") || null,
      work_order_number: wo,
      gross_paid_amount: parseMoney(pickCol(row, "grossAmount")),
      expected_tow_amount: null,
      payment_difference_value: null,
      reconciliation_status: "unmatched",
      exception_reason: "No matching Tow Opportunity for Work Order Number.",
    };
    return ghlApi("/objects/" + CONFIG.objectKeys.aaa + "/records", {
      method: "POST",
      version: CONFIG.apiVersions.objects,
      body: { locationId: CONFIG.locationId, properties: properties },
    });
  }

  // Applies a reconcile() result to GHL. Writes matched/exception rows to
  // both the Opportunity and the aaa_payments object; writes no-match rows
  // only to the aaa_payments object (there's no Opportunity to update);
  // skips noWo and alreadyReconciled entirely, same as the Python tool.
  function applyReconciliation(reconciled, onProgress) {
    var tasks = [];
    reconciled.toWrite.forEach(function (item) {
      tasks.push(function () {
        return writeOpportunityFields(item).then(function () { return writeAaaRecord(item); });
      });
    });
    reconciled.noMatch.forEach(function (m) {
      tasks.push(function () { return writeUnmatchedAaaRecord(m.wo, m.row); });
    });

    var results = [];
    var i = 0;
    function next() {
      if (i >= tasks.length) return Promise.resolve(results);
      var idx = i;
      i += 1;
      return tasks[idx]()
        .then(function (r) {
          results.push({ ok: true, result: r });
          if (onProgress) onProgress(results.length, tasks.length);
          return next();
        })
        .catch(function (err) {
          results.push({ ok: false, error: String((err && err.message) || err) });
          if (onProgress) onProgress(results.length, tasks.length);
          return next();
        });
    }
    return next();
  }

  // ---------------------------------------------------------------------
  // File parsing: CSV (built-in, no dependency) and XLSX (lazy-loaded
  // SheetJS from jsDelivr — only fetched if a client actually picks an
  // .xlsx file, since most won't need it).
  // ---------------------------------------------------------------------
  function parseCsvText(text) {
    // Minimal RFC4180 parser: handles quoted fields, embedded commas,
    // escaped quotes (""), and \r\n or \n line endings.
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var len = text.length;
    function pushField() { row.push(field); field = ""; }
    function pushRow() { pushField(); rows.push(row); row = []; }
    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        field += c; i += 1; continue;
      }
      if (c === '"') { inQuotes = true; i += 1; continue; }
      if (c === ",") { pushField(); i += 1; continue; }
      if (c === "\r") { i += 1; continue; }
      if (c === "\n") { pushRow(); i += 1; continue; }
      field += c; i += 1;
    }
    if (field.length > 0 || row.length > 0) pushRow();
    rows = rows.filter(function (r) { return !(r.length === 1 && r[0] === ""); });
    if (rows.length === 0) return [];
    var headers = rows[0];
    return rows.slice(1).map(function (r) {
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
      return obj;
    });
  }

  var xlsxLoadPromise = null;
  function ensureXlsxLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error("Could not load the Excel-parsing library. Check your connection and try again, or export the statement as CSV instead.")); };
      document.head.appendChild(s);
    });
    return xlsxLoadPromise;
  }

  function parseXlsxArrayBuffer(buf) {
    return ensureXlsxLib().then(function (XLSX) {
      var wb = XLSX.read(buf, { type: "array" });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(sheet, { defval: "" });
    });
  }

  // Fallback for a PDF statement: the admin copies the table out of their
  // PDF viewer and pastes it here as plain text. Handles tab-separated
  // (most PDF-viewer copy/paste) or comma-separated paste alike.
  function parsePastedTable(text) {
    var sample = text.split("\n")[0] || "";
    var delim = sample.indexOf("\t") !== -1 ? "\t" : ",";
    if (delim === ",") return parseCsvText(text);
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
    if (lines.length === 0) return [];
    var headers = lines[0].split(delim).map(function (h) { return h.trim(); });
    return lines.slice(1).map(function (line) {
      var cells = line.split(delim);
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = cells[idx] !== undefined ? cells[idx].trim() : ""; });
      return obj;
    });
  }

  function sha256Hex(str) {
    var enc = new TextEncoder().encode(str);
    return crypto.subtle.digest("SHA-256", enc).then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); })
        .join("");
    });
  }

  // Exposed for testing (see repo_test/) — the UI layer below only reads
  // from CONFIG and calls these same functions, nothing is duplicated.
  window.__CJT_SETUP_INTERNAL__ = {
    CONFIG: CONFIG,
    parseMoney: parseMoney,
    parseCsvText: parseCsvText,
    parsePastedTable: parsePastedTable,
    parseXlsxArrayBuffer: parseXlsxArrayBuffer,
    pickCol: pickCol,
    buildWoMap: buildWoMap,
    reconcile: reconcile,
    applyReconciliation: applyReconciliation,
    sha256Hex: sha256Hex,
    loadPipelines: loadPipelines,
    resolveFieldIds: resolveFieldIds,
    FIELD_NAME_CANDIDATES: FIELD_NAME_CANDIDATES,
  };

  // ---------------------------------------------------------------------
  // UI layer — CSS + markup ship inline in this one file, same reasoning
  // as dashboard.js: one file on GitHub, one script tag in GHL.
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--bg:#f3f5f8;--panel:#fff;--border:#e1e5eb;--text:#1a2130;--text-dim:#626b7a;--accent:#1d4ed8;--accent-soft:#e7edfc;--accent-strong:#1739ab;--good:#15803d;--good-soft:#e1f4e8;--warn:#b45309;--warn-soft:#fbeed9;--crit:#b91c1c;--crit-soft:#fbe4e2;--info:#0e7490;--info-soft:#dff2f4;--chip-bg:#eef1f5;--shadow:0 1px 2px rgba(20,25,40,.05),0 2px 10px rgba(20,25,40,.06)}',
    '#cjt-setup-root *{box-sizing:border-box}',
    '#cjt-setup-root{background:var(--bg);color:var(--text);font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px 16px 60px;position:relative}',
    '#cjt-setup-root .mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}',
    '#cjt-setup-root .wrap{max-width:760px;margin:0 auto}',
    '#cjt-setup-root header.top{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}',
    '#cjt-setup-root header.top h1{font-size:21px;margin:0;font-weight:700;letter-spacing:-.01em}',
    '#cjt-setup-root .tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);background:var(--accent-soft);padding:3px 8px;border-radius:5px}',
    '#cjt-setup-root .sub{color:var(--text-dim);font-size:13px;margin-top:6px;margin-bottom:26px;max-width:66ch;line-height:1.55}',
    '#cjt-setup-root .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);margin-bottom:18px}',
    '#cjt-setup-root .card h2{font-size:15px;margin:0 0 4px;font-weight:700}',
    '#cjt-setup-root .card .cardDesc{font-size:12.5px;color:var(--text-dim);line-height:1.5;margin-bottom:16px;max-width:60ch}',
    '#cjt-setup-root .field{margin-bottom:14px}',
    '#cjt-setup-root .field:last-child{margin-bottom:0}',
    '#cjt-setup-root .field label{display:block;font-size:12.5px;font-weight:600;margin-bottom:5px;color:var(--text)}',
    '#cjt-setup-root .field .hint{font-size:11.5px;color:var(--text-dim);margin-top:4px;line-height:1.45}',
    '#cjt-setup-root .fieldRow{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '@media (max-width:520px){#cjt-setup-root .fieldRow{grid-template-columns:1fr}}',
    '#cjt-setup-root input[type=text],#cjt-setup-root input[type=password],#cjt-setup-root input[type=number],#cjt-setup-root textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-size:13.5px;font-family:inherit;background:var(--panel);color:var(--text)}',
    '#cjt-setup-root input:focus,#cjt-setup-root textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}',
    '#cjt-setup-root textarea{resize:vertical;font-family:"IBM Plex Mono",monospace;font-size:12px}',
    '#cjt-setup-root .tokenRow{display:flex;gap:8px}',
    '#cjt-setup-root .tokenRow input{flex:1}',
    '#cjt-setup-root .btn{appearance:none;border:1px solid var(--border);background:var(--panel);color:var(--text);font-family:inherit;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
    '#cjt-setup-root .btn:hover{border-color:var(--accent);color:var(--accent)}',
    '#cjt-setup-root .btn:disabled{opacity:.5;cursor:not-allowed}',
    '#cjt-setup-root .btn:disabled:hover{border-color:var(--border);color:var(--text)}',
    '#cjt-setup-root .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}',
    '#cjt-setup-root .btn.primary:hover{background:var(--accent-strong);color:#fff}',
    '#cjt-setup-root .btn.danger{background:var(--crit);border-color:var(--crit);color:#fff}',
    '#cjt-setup-root .btn.danger:hover{filter:brightness(.92)}',
    '#cjt-setup-root .btnRow{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}',
    '#cjt-setup-root .statusMsg{font-size:12.5px;margin-top:12px;padding:10px 12px;border-radius:8px;line-height:1.5;display:none}',
    '#cjt-setup-root .statusMsg.show{display:block}',
    '#cjt-setup-root .statusMsg.ok{background:var(--good-soft);color:var(--good)}',
    '#cjt-setup-root .statusMsg.err{background:var(--crit-soft);color:var(--crit)}',
    '#cjt-setup-root .statusMsg.info{background:var(--info-soft);color:var(--info)}',
    '#cjt-setup-root .snippetOut{width:100%;min-height:150px;margin-top:12px}',
    '#cjt-setup-root .copyRow{display:flex;justify-content:flex-end;margin-top:8px}',
    '#cjt-setup-root .summaryGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}',
    '#cjt-setup-root .summaryTile{background:var(--chip-bg);border-radius:10px;padding:12px 14px;text-align:center}',
    '#cjt-setup-root .summaryTile .n{font-family:"IBM Plex Mono",monospace;font-size:20px;font-weight:700}',
    '#cjt-setup-root .summaryTile .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin-top:2px}',
    '#cjt-setup-root .summaryTile.matched .n{color:var(--good)}#cjt-setup-root .summaryTile.exception .n{color:var(--warn)}#cjt-setup-root .summaryTile.unmatched .n{color:var(--crit)}',
    '#cjt-setup-root .progressWrap{margin:14px 0;display:none}',
    '#cjt-setup-root .progressWrap.show{display:block}',
    '#cjt-setup-root .progressBar{height:6px;border-radius:999px;background:var(--chip-bg);overflow:hidden}',
    '#cjt-setup-root .progressBar > div{height:100%;background:var(--accent);width:0%;transition:width .2s ease}',
    '#cjt-setup-root .progressLabel{font-size:11.5px;color:var(--text-dim);margin-top:6px}',
    '#cjt-setup-root .tableWrap{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow-x:auto;margin-top:12px}',
    '#cjt-setup-root table{border-collapse:collapse;width:100%;font-size:12.5px;min-width:520px}',
    '#cjt-setup-root thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}',
    '#cjt-setup-root tbody td{padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}',
    '#cjt-setup-root tbody tr:last-child td{border-bottom:none}',
    '#cjt-setup-root .status-pill{font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--chip-bg);white-space:nowrap}',
    '#cjt-setup-root .status-matched{background:var(--good-soft);color:var(--good)}',
    '#cjt-setup-root .status-exception{background:var(--warn-soft);color:var(--warn)}',
    '#cjt-setup-root .status-unmatched{background:var(--crit-soft);color:var(--crit)}',
    '#cjt-setup-root .fileDrop{border:1.5px dashed var(--border);border-radius:10px;padding:20px;text-align:center;font-size:12.5px;color:var(--text-dim)}',
    '#cjt-setup-root .toggleLink{font-size:12px;color:var(--accent);cursor:pointer;text-decoration:underline;background:none;border:none;font-family:inherit;padding:0}',
    '#cjt-setup-root .applyConfirm{display:flex;align-items:center;gap:8px;margin-top:12px}',
    '#cjt-setup-root .applyConfirm input{max-width:140px}',
    '#cjt-setup-root .foot-note{margin-top:22px;font-size:11.5px;color:var(--text-dim);line-height:1.6}',
    '#cjt-setup-root.cjtLocked .wrap{filter:blur(8px);pointer-events:none;user-select:none}',
    '#cjt-setup-root .cjtLockOverlay{position:fixed;inset:0;background:rgba(20,25,40,.6);display:none;align-items:center;justify-content:center;z-index:999999;padding:16px}',
    '#cjt-setup-root.cjtLocked .cjtLockOverlay{display:flex}',
    '#cjt-setup-root .cjtLockCard{background:var(--panel);border-radius:14px;padding:28px 26px;max-width:340px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.28);text-align:center}',
    '#cjt-setup-root .cjtLockTitle{font-size:17px;font-weight:700;margin-bottom:8px}',
    '#cjt-setup-root .cjtLockWarn{font-size:12.5px;color:var(--text-dim);line-height:1.5;margin-bottom:16px}',
    '#cjt-setup-root .cjtLockInput{width:100%;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:10px;font-family:inherit;text-align:center;box-sizing:border-box}',
    '#cjt-setup-root .cjtLockBtn{width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px;font-weight:600;font-size:13.5px;cursor:pointer;font-family:inherit}',
    '#cjt-setup-root .cjtLockBtn:hover{background:var(--accent-strong)}',
    '#cjt-setup-root .cjtLockError{color:var(--crit);font-size:12px;margin-top:8px;min-height:14px}',
    '@media (prefers-reduced-motion:reduce){#cjt-setup-root *{animation-duration:.001s!important;transition-duration:.001s!important}}',
    // extInstall* rules are unscoped (not under #cjt-setup-root) because the
    // checklist overlay is appended straight to <body> — see
    // openInstallSteps() — so it always covers the full viewport
    // regardless of where #cjt-setup-root sits on the page. Class names are
    // deliberately distinctive to keep collisions with the host GHL page's
    // own CSS unlikely.
    '.extInstallOverlay{position:fixed;inset:0;background:rgba(20,25,40,.6);display:flex;align-items:center;justify-content:center;z-index:999999;padding:16px;font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.extInstallCard{position:relative;background:#fff;color:#1a2130;border-radius:14px;padding:26px 26px 22px;max-width:420px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.28);max-height:82vh;overflow-y:auto}',
    '.extInstallClose{position:absolute;top:14px;right:14px;border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:#626b7a;padding:4px}',
    '.extInstallClose:hover{color:#1a2130}',
    '.extInstallTitle{font-size:17px;font-weight:700;margin-bottom:4px;padding-right:20px}',
    '.extInstallSub{font-size:12.5px;color:#626b7a;line-height:1.5;margin-bottom:16px}',
    '.extInstallSteps{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:12px}',
    '.extInstallSteps li{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5}',
    '.extInstallSteps .stepNum{flex:0 0 auto;width:20px;height:20px;border-radius:999px;background:#e7edfc;color:#1d4ed8;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}',
    '.extInstallSteps .stepText b{font-weight:700}',
    '.extInstallSteps .mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef1f5;padding:1px 5px;border-radius:4px;font-size:12px}'
  ].join("\n");

  var PAGE_HTML =
    '<div class="wrap">' +
    '<header class="top"><h1>CJT Ops — Setup</h1><span class="tag">Admins only</span></header>' +
    '<div class="sub">Configure the connection to GoHighLevel, pricing, dashboard security, and import AAA payment statements — all from here. Nothing is stored on a server; this page reads and writes GHL directly with the token below, and the "Generate snippet" button gives you the config block to paste onto this page and the dashboard page.</div>' +

    '<div class="card" id="cardConnection"><h2>1. Connection</h2>' +
    '<div class="cardDesc">The GHL Private Integration Token this dashboard uses to read and write data. Create one in GHL under Settings → Private Integrations with read/write access to Opportunities, Contacts, and Objects.</div>' +
    '<div class="field"><label for="fLocationId">Location ID</label><input type="text" id="fLocationId" placeholder="e.g. QYDIuca9tl2cGtxMSwXm"></div>' +
    '<div class="field"><label for="fToken">Private Integration Token</label><div class="tokenRow"><input type="password" id="fToken" placeholder="pit-..."><button type="button" class="btn" id="fTokenToggle">Show</button></div></div>' +
    '<div class="field"><label for="fGhlBase">GHL login domain</label><input type="text" id="fGhlBase" placeholder="https://app.yourdomain.com"><div class="hint">Used only to build "open in GHL" links on the dashboard — not for API calls.</div></div>' +
    '<div class="field"><label for="fPipeline">Dispatch pipeline name</label><input type="text" id="fPipeline" placeholder="Towing Dispatch"><div class="hint">Must match a real pipeline name in this GHL location, exactly.</div></div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnTestConn">Test connection</button></div>' +
    '<div class="statusMsg" id="connStatus"></div>' +
    '<div id="fieldMapWrap"></div>' +
    '</div>' +

    '<div class="card" id="cardPricing"><h2>2. Pricing</h2>' +
    '<div class="cardDesc">Your contract rates with AAA — used to compute Expected Tow Amount on new jobs and AAA Payment Difference during reconciliation.</div>' +
    '<div class="fieldRow"><div class="field"><label for="fBaseRate">Base tow rate ($)</label><input type="number" id="fBaseRate" step="0.01"></div><div class="field"><label for="fMileRate">Mileage rate ($/mi)</label><input type="number" id="fMileRate" step="0.01"></div></div>' +
    '</div>' +

    '<div class="card" id="cardSecurity"><h2>3. Dashboard security &amp; this Setup page</h2>' +
    '<div class="cardDesc">Both the dashboard and this Setup page can show a passcode lock that blurs the screen after a period of inactivity — a deterrent against a screen left open at the shop, not real cryptographic security (see the README). Leave the passcode blank to skip the lock.</div>' +
    '<div class="field"><label for="fSetupUrl">This Setup page\'s own GHL URL</label><input type="text" id="fSetupUrl" placeholder="https://yourdomain.com/setup"><div class="hint">Goes in the dashboard\'s footer "Setup" link.</div></div>' +
    '<div class="fieldRow"><div class="field"><label for="fPasscode">Company passcode</label><input type="password" id="fPasscode" placeholder="Leave blank to keep current / disable"></div><div class="field"><label for="fPasscode2">Confirm passcode</label><input type="password" id="fPasscode2"></div></div>' +
    '<div class="field"><label for="fIdleMin">Auto-lock after (minutes idle)</label><input type="number" id="fIdleMin" min="1" step="1"></div>' +
    '<div class="statusMsg" id="secStatus"></div>' +
    '</div>' +

    '<div class="card" id="cardSnippet"><h2>4. Generate dashboard snippet</h2>' +
    '<div class="cardDesc">Builds the exact block to paste into the GHL Custom HTML element on both the dashboard page and this Setup page. Paste the same block in both places so they stay in sync.</div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnGenerate">Generate snippet</button></div>' +
    '<textarea class="snippetOut mono" id="snippetOut" readonly spellcheck="false" placeholder="Click Generate to build your config block..."></textarea>' +
    '<div class="copyRow"><button type="button" class="btn" id="btnCopySnippet">Copy to clipboard</button></div>' +
    '<div class="statusMsg" id="snippetStatus"></div>' +
    '</div>' +

    '<div class="card" id="cardImport"><h2>5. Import AAA payment statements</h2>' +
    '<div class="cardDesc">Matches each row to its job by Work Order Number, same logic as the existing reconciliation tool. Nothing is written to GHL until you review the preview below and confirm Apply.</div>' +
    '<div class="field"><label for="fFile">Statement file (CSV or Excel)</label><input type="file" id="fFile" accept=".csv,.xlsx,.xls"></div>' +
    '<div class="field"><button type="button" class="toggleLink" id="togglePaste">...or paste a table (e.g. copied from a PDF) instead</button></div>' +
    '<div class="field" id="pasteWrap" hidden><label for="fPaste">Pasted statement text</label><textarea id="fPaste" rows="6" placeholder="Paste tab- or comma-separated rows, including the header row"></textarea></div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnPreview">Preview</button></div>' +
    '<div class="progressWrap" id="importProgress"><div class="progressBar"><div id="importProgressBar"></div></div><div class="progressLabel" id="importProgressLabel"></div></div>' +
    '<div class="statusMsg" id="importStatus"></div>' +
    '<div id="importSummary"></div>' +
    '<div id="importTableWrap"></div>' +
    '<div id="applyWrap"></div>' +
    '</div>' +

    '<div class="card" id="cardExtension"><h2>6. AAA Work Order Extractor (browser extension)</h2>' +
    '<div class="cardDesc">The dispatcher-side companion tool: it reads an AAA work order page and can sync it straight into this pipeline. It runs entirely on the dispatcher\'s own computer — no GHL token is ever stored in the extension itself. Download it, unzip it, and run the installer once per computer that needs it.</div>' +
    '<div id="extDownloadWrap"></div>' +
    '</div>' +

    '<div class="foot-note" id="footNote">Field IDs for AAA reconciliation on the Opportunity are specific to this GHL location — see the note at the top of setup.js before reusing this for a different client.</div>' +
    "</div>";

  function sha256HexUi(str) { return sha256Hex(str); }

  function initSecurity(root, onFirstUnlock) {
    if (!CONFIG.passcodeHash) {
      onFirstUnlock();
      return;
    }
    var SESSION_KEY = "cjt_setup_unlocked";
    var idleMs = CONFIG.idleLockMinutes * 60 * 1000;

    var overlay = document.createElement("div");
    overlay.className = "cjtLockOverlay";
    overlay.innerHTML =
      '<div class="cjtLockCard"><div class="cjtLockTitle">Locked</div>' +
      '<div class="cjtLockWarn">This is the admin Setup page — it can read and write live GHL data. Don’t leave it open and unattended.</div>' +
      '<input type="password" class="cjtLockInput" id="cjtLockInput" placeholder="Company passcode" autocomplete="off">' +
      '<button type="button" class="cjtLockBtn" id="cjtLockBtn">Unlock</button>' +
      '<div class="cjtLockError" id="cjtLockError" aria-live="polite"></div></div>';
    root.appendChild(overlay);

    var input = overlay.querySelector("#cjtLockInput");
    var btn = overlay.querySelector("#cjtLockBtn");
    var errEl = overlay.querySelector("#cjtLockError");
    var firstRun = true;
    var lastActivity = Date.now();

    function lock() {
      root.classList.add("cjtLocked");
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
      input.value = "";
      errEl.textContent = "";
      setTimeout(function () { input.focus(); }, 50);
    }

    function unlock() {
      root.classList.remove("cjtLocked");
      errEl.textContent = "";
      input.value = "";
      try { sessionStorage.setItem(SESSION_KEY, "1"); } catch (e) {}
      lastActivity = Date.now();
      if (firstRun) {
        firstRun = false;
        onFirstUnlock();
      }
    }

    function attempt() {
      var val = input.value;
      btn.disabled = true;
      sha256HexUi(val)
        .then(function (h) {
          btn.disabled = false;
          if (h === CONFIG.passcodeHash) unlock();
          else {
            errEl.textContent = "Incorrect passcode.";
            input.value = "";
            input.focus();
          }
        })
        .catch(function () { btn.disabled = false; });
    }

    btn.addEventListener("click", attempt);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") attempt(); });

    var alreadyUnlocked = false;
    try { alreadyUnlocked = sessionStorage.getItem(SESSION_KEY) === "1"; } catch (e) {}
    if (alreadyUnlocked) {
      firstRun = false;
      onFirstUnlock();
    } else {
      root.classList.add("cjtLocked");
      setTimeout(function () { input.focus(); }, 50);
    }

    ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(function (evt) {
      document.addEventListener(evt, function () { lastActivity = Date.now(); }, { passive: true });
    });
    function checkIdle() {
      if (!root.classList.contains("cjtLocked") && Date.now() - lastActivity > idleMs) lock();
    }
    setInterval(checkIdle, 15000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) checkIdle(); });
  }

  function mount() {
    var root = document.getElementById("cjt-setup-root");
    if (!root) {
      console.error("[CJT Setup] #cjt-setup-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);
    var fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(fontLink);
    root.innerHTML = PAGE_HTML;
    initSecurity(root, function () { runApp(root); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

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

  function runApp(root) {
    var els = {};
    ["fLocationId", "fToken", "fTokenToggle", "fGhlBase", "fPipeline", "btnTestConn", "connStatus", "fieldMapWrap",
     "fBaseRate", "fMileRate",
     "fSetupUrl", "fPasscode", "fPasscode2", "fIdleMin", "secStatus",
     "btnGenerate", "snippetOut", "btnCopySnippet", "snippetStatus",
     "fFile", "togglePaste", "pasteWrap", "fPaste", "btnPreview",
     "importProgress", "importProgressBar", "importProgressLabel", "importStatus", "importSummary", "importTableWrap", "applyWrap",
     "extDownloadWrap"
    ].forEach(function (id) { els[id] = root.querySelector("#" + id); });

    // ---- Prefill from CONFIG (whatever was pasted in window.CJT_CONFIG) ----
    els.fLocationId.value = CONFIG.locationId || "";
    els.fToken.value = CONFIG.privateToken || "";
    els.fGhlBase.value = CONFIG.ghlBase || "";
    els.fPipeline.value = CONFIG.dispatchPipelineName || "Towing Dispatch";
    els.fBaseRate.value = CONFIG.baseTowRate != null ? CONFIG.baseTowRate : 85;
    els.fMileRate.value = CONFIG.mileageRate != null ? CONFIG.mileageRate : 3;
    els.fSetupUrl.value = CONFIG.setupUrl || "";
    els.fIdleMin.value = CONFIG.idleLockMinutes != null ? CONFIG.idleLockMinutes : 10;
    // Passcode fields intentionally stay blank — the plaintext is never
    // known after hashing, so there's nothing to prefill.

    els.fTokenToggle.addEventListener("click", function () {
      var showing = els.fToken.type === "text";
      els.fToken.type = showing ? "password" : "text";
      els.fTokenToggle.textContent = showing ? "Show" : "Hide";
    });

    function showStatus(el, kind, msg) {
      el.className = "statusMsg show " + kind;
      el.textContent = msg;
    }
    function hideStatus(el) {
      el.className = "statusMsg";
      el.textContent = "";
    }

    function liveConfigFromForm() {
      return Object.assign({}, CONFIG, {
        locationId: els.fLocationId.value.trim(),
        privateToken: els.fToken.value.trim(),
        ghlBase: els.fGhlBase.value.trim(),
        dispatchPipelineName: els.fPipeline.value.trim() || "Towing Dispatch",
      });
    }

    // ---- 1. Test connection ----
    var FIELD_LABELS = {
      workOrderNumber: "Work Order Number",
      expectedTowAmount: "Expected Tow Amount",
      aaaPaymentId: "AAA Payment ID",
      aaaGrossPaid: "AAA Gross Paid Amount",
      aaaPayDate: "AAA Pay Date",
      aaaPaidTowMiles: "AAA Paid Tow Miles",
      aaaPaymentDifference: "AAA Payment Difference",
    };
    function renderFieldMap(resolved) {
      var rows = Object.keys(FIELD_LABELS).map(function (key) {
        var src = resolved.source[key];
        var pillClass = src === "name" ? "status-matched" : src === "fallback" ? "status-exception" : "status-unmatched";
        var pillText = src === "name" ? "found by name" : src === "fallback" ? "using fallback ID" : "not found";
        return "<tr><td>" + esc(FIELD_LABELS[key]) + '</td><td><span class="status-pill ' + pillClass + '">' + pillText + "</span></td></tr>";
      }).join("");
      var anyFallbackOrMissing = Object.keys(resolved.source).some(function (k) { return resolved.source[k] !== "name"; });
      els.fieldMapWrap.innerHTML =
        '<div class="hint" style="margin-top:12px;margin-bottom:4px;">AAA reconciliation field mapping (looked up by name in this GHL location):</div>' +
        '<div class="tableWrap"><table><thead><tr><th>Field</th><th>Status</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        (anyFallbackOrMissing
          ? '<div class="hint" style="margin-top:8px;">Anything not "found by name" means this location\'s custom field is either missing or named differently than expected — AAA import will be unreliable until that\'s fixed. If this is a client whose sub-account came from your snapshot, the field names should match exactly; double check spelling/capitalization in GHL if not.</div>'
          : '<div class="hint" style="margin-top:8px;">All AAA fields matched by name — the import should work on this location without any hardcoded IDs.</div>');
    }

    els.btnTestConn.addEventListener("click", function () {
      var live = liveConfigFromForm();
      if (!live.locationId || !live.privateToken) {
        showStatus(els.connStatus, "err", "Location ID and Private Integration Token are both required.");
        return;
      }
      Object.assign(CONFIG, live);
      els.btnTestConn.disabled = true;
      showStatus(els.connStatus, "info", "Testing…");
      els.fieldMapWrap.innerHTML = "";
      loadPipelines()
        .then(function (pipelines) {
          var names = pipelines.map(function (p) { return p.name; });
          var hasDispatch = names.some(function (n) { return (n || "").toLowerCase() === CONFIG.dispatchPipelineName.toLowerCase(); });
          if (hasDispatch) {
            showStatus(els.connStatus, "ok", "Connected. Found " + pipelines.length + " pipeline(s), including “" + CONFIG.dispatchPipelineName + "”.");
          } else {
            showStatus(els.connStatus, "err", "Connected, but no pipeline named “" + CONFIG.dispatchPipelineName + "” was found. Pipelines here: " + names.join(", "));
          }
          return resolveFieldIds().then(renderFieldMap);
        })
        .catch(function (err) {
          showStatus(els.connStatus, "err", "Connection failed: " + err.message);
        })
        .finally(function () { els.btnTestConn.disabled = false; });
    });

    // ---- 2/3. Pricing & security live in CONFIG once Generate is clicked ----

    // ---- 4. Generate snippet ----
    els.btnGenerate.addEventListener("click", function () {
      Object.assign(CONFIG, liveConfigFromForm());
      CONFIG.baseTowRate = parseFloat(els.fBaseRate.value) || 0;
      CONFIG.mileageRate = parseFloat(els.fMileRate.value) || 0;
      CONFIG.setupUrl = els.fSetupUrl.value.trim();
      CONFIG.idleLockMinutes = parseFloat(els.fIdleMin.value) || 10;

      var p1 = els.fPasscode.value;
      var p2 = els.fPasscode2.value;
      if (p1 || p2) {
        if (p1 !== p2) {
          showStatus(els.secStatus, "err", "Passcodes don’t match.");
          return;
        }
      }
      hideStatus(els.secStatus);

      var hashPromise = p1 ? sha256HexUi(p1) : Promise.resolve(CONFIG.passcodeHash || "");
      els.btnGenerate.disabled = true;
      hashPromise
        .then(function (hash) {
          CONFIG.passcodeHash = hash;
          var cfgForSnippet = {
            locationId: CONFIG.locationId,
            privateToken: CONFIG.privateToken,
            ghlBase: CONFIG.ghlBase,
            dispatchPipelineName: CONFIG.dispatchPipelineName,
            baseTowRate: CONFIG.baseTowRate,
            mileageRate: CONFIG.mileageRate,
            setupUrl: CONFIG.setupUrl,
            passcodeHash: CONFIG.passcodeHash,
            idleLockMinutes: CONFIG.idleLockMinutes,
          };
          var snippet =
            '<div id="cjt-dashboard-root"></div>\n' +
            '<script>\n' +
            "  window.CJT_CONFIG = " + JSON.stringify(cfgForSnippet, null, 2) + ";\n" +
            "<\/script>\n" +
            '<script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@latest/dashboard.js"><\/script>\n\n' +
            "<!-- Paste this SAME block onto this Setup page too, swapping the last\n" +
            '     script src for setup.js and the div id for "cjt-setup-root". -->';
          els.snippetOut.value = snippet;
          showStatus(els.snippetStatus, "ok", "Snippet generated. Paste it into the dashboard page’s Custom HTML element (and this page’s, with the swaps noted in the comment).");
        })
        .finally(function () { els.btnGenerate.disabled = false; });
    });

    els.btnCopySnippet.addEventListener("click", function () {
      if (!els.snippetOut.value) return;
      navigator.clipboard.writeText(els.snippetOut.value).then(
        function () { showStatus(els.snippetStatus, "ok", "Copied to clipboard."); },
        function () { showStatus(els.snippetStatus, "err", "Couldn’t copy automatically — select the text and copy manually."); }
      );
    });

    // ---- 5. AAA import ----
    els.togglePaste.addEventListener("click", function () {
      els.pasteWrap.hidden = !els.pasteWrap.hidden;
      els.togglePaste.textContent = els.pasteWrap.hidden ? "...or paste a table (e.g. copied from a PDF) instead" : "Hide paste box";
    });

    var lastReconciled = null;
    var lastWoMapInfo = null;

    function setImportProgress(shown, done, total, label) {
      els.importProgress.className = "progressWrap" + (shown ? " show" : "");
      if (total) els.importProgressBar.style.width = Math.round((done / total) * 100) + "%";
      els.importProgressLabel.textContent = label || (total ? done + " / " + total : "");
    }

    function getRowsFromInput() {
      var file = els.fFile.files && els.fFile.files[0];
      if (file) {
        var isXlsx = /\.xlsx?$/i.test(file.name);
        return file.arrayBuffer().then(function (buf) {
          if (isXlsx) return parseXlsxArrayBuffer(buf);
          return parseCsvText(new TextDecoder("utf-8").decode(buf));
        });
      }
      var pasted = els.fPaste.value.trim();
      if (pasted) return Promise.resolve(parsePastedTable(pasted));
      return Promise.reject(new Error("Choose a file or paste statement text first."));
    }

    function renderSummary(reconciled) {
      var counts = {
        matched: reconciled.toWrite.filter(function (r) { return r.status === "matched"; }).length,
        exception: reconciled.toWrite.filter(function (r) { return r.status === "exception"; }).length,
        unmatched: reconciled.noMatch.length,
        alreadyDone: reconciled.alreadyReconciled.length,
        noWo: reconciled.noWo.length,
      };
      els.importSummary.innerHTML =
        '<div class="summaryGrid">' +
        '<div class="summaryTile matched"><div class="n">' + counts.matched + '</div><div class="l">Matched</div></div>' +
        '<div class="summaryTile exception"><div class="n">' + counts.exception + '</div><div class="l">Exceptions</div></div>' +
        '<div class="summaryTile unmatched"><div class="n">' + counts.unmatched + '</div><div class="l">No match</div></div>' +
        '<div class="summaryTile"><div class="n">' + counts.alreadyDone + '</div><div class="l">Already done</div></div>' +
        '<div class="summaryTile"><div class="n">' + counts.noWo + '</div><div class="l">No WO #</div></div>' +
        "</div>";

      var rows = reconciled.toWrite.concat(reconciled.noMatch.map(function (m) {
        return { wo: m.wo, paymentId: pickCol(m.row, "paymentId"), grossAmount: parseMoney(pickCol(m.row, "grossAmount")), status: "unmatched", diff: null, opp: null };
      }));

      if (rows.length === 0) {
        els.importTableWrap.innerHTML = '<div class="hint">Nothing to preview — check the file has a Work Order Number column.</div>';
      } else {
        var body = rows.slice(0, 200).map(function (r) {
          return "<tr><td>" + esc(r.wo) + "</td><td>" + esc(r.paymentId || "—") + "</td><td>" + money(r.grossAmount) + "</td>" +
            "<td>" + (r.opp ? esc(r.opp.name) : "—") + "</td><td>" + money(r.diff) + "</td>" +
            '<td><span class="status-pill status-' + r.status + '">' + esc(r.status) + "</span></td></tr>";
        }).join("");
        els.importTableWrap.innerHTML =
          '<div class="tableWrap"><table><thead><tr><th>Work Order</th><th>Payment ID</th><th>Gross</th><th>Matched Job</th><th>Diff</th><th>Status</th></tr></thead><tbody>' +
          body + "</tbody></table></div>" +
          (rows.length > 200 ? '<div class="hint">Showing first 200 of ' + rows.length + " rows.</div>" : "");
      }

      var writable = reconciled.toWrite.length + reconciled.noMatch.length;
      if (writable > 0) {
        els.applyWrap.innerHTML =
          '<div class="applyConfirm"><label for="applyConfirmInput" style="margin:0;font-size:12.5px;">Type APPLY to confirm writing ' + writable + " row(s) to GHL:</label>" +
          '<input type="text" id="applyConfirmInput"></div>' +
          '<div class="btnRow"><button type="button" class="btn danger" id="btnApply" disabled>Apply to GHL</button></div>';
        var confirmInput = els.applyWrap.querySelector("#applyConfirmInput");
        var applyBtn = els.applyWrap.querySelector("#btnApply");
        confirmInput.addEventListener("input", function () {
          applyBtn.disabled = confirmInput.value.trim().toUpperCase() !== "APPLY";
        });
        applyBtn.addEventListener("click", function () {
          applyBtn.disabled = true;
          confirmInput.disabled = true;
          setImportProgress(true, 0, writable, "Writing to GHL…");
          applyReconciliation(lastReconciled, function (done, total) {
            setImportProgress(true, done, total, "Writing to GHL… " + done + " / " + total);
          })
            .then(function (results) {
              var okCount = results.filter(function (r) { return r.ok; }).length;
              var failCount = results.length - okCount;
              setImportProgress(false, 0, 0, "");
              if (failCount === 0) {
                showStatus(els.importStatus, "ok", "Done. " + okCount + " row(s) written to GHL.");
              } else {
                showStatus(els.importStatus, "err", okCount + " row(s) written, " + failCount + " failed — see console for details.");
                results.forEach(function (r, i) { if (!r.ok) console.error("[CJT Setup] row " + i + " failed:", r.error); });
              }
              els.applyWrap.innerHTML = "";
            })
            .catch(function (err) {
              setImportProgress(false, 0, 0, "");
              showStatus(els.importStatus, "err", "Apply failed: " + err.message);
              applyBtn.disabled = false;
              confirmInput.disabled = false;
            });
        });
      } else {
        els.applyWrap.innerHTML = '<div class="hint">Nothing to apply — every row is already reconciled or has no Work Order Number.</div>';
      }
    }

    els.btnPreview.addEventListener("click", function () {
      Object.assign(CONFIG, liveConfigFromForm());
      if (!CONFIG.locationId || !CONFIG.privateToken) {
        showStatus(els.importStatus, "err", "Set up the connection (section 1) and test it before importing.");
        return;
      }
      hideStatus(els.importStatus);
      els.importSummary.innerHTML = "";
      els.importTableWrap.innerHTML = "";
      els.applyWrap.innerHTML = "";
      els.btnPreview.disabled = true;

      getRowsFromInput()
        .then(function (rows) {
          if (!rows || rows.length === 0) throw new Error("No rows found in the file/pasted text.");
          setImportProgress(true, 0, 1, "Reading opportunities from GHL…");
          return buildWoMap(function (done, total) {
            setImportProgress(true, done, total, "Reading opportunities from GHL… " + done + " / " + total);
          }).then(function (info) {
            lastWoMapInfo = info;
            var reconciled = reconcile(rows, info.woMap);
            lastReconciled = reconciled;
            setImportProgress(false, 0, 0, "");
            showStatus(els.importStatus, "info", "Checked " + rows.length + " row(s) against " + info.opportunityCount + " opportunit" + (info.opportunityCount === 1 ? "y" : "ies") + " in “" + info.pipelineName + "”. Nothing written yet — review below.");
            renderSummary(reconciled);
          });
        })
        .catch(function (err) {
          setImportProgress(false, 0, 0, "");
          showStatus(els.importStatus, "err", err.message);
        })
        .finally(function () { els.btnPreview.disabled = false; });
    });

    // ---- 6. Extension download (GitHub Releases, OS-detected) ----
    // A webpage can never install or run software on a visitor's computer
    // by itself — this only gets them the right zip with one click. The
    // actual install (unzip + run the .command/.exe installer) still
    // happens locally, once, on each computer that needs the extension.
    // The URL below is GitHub's stable "always the newest Release" link,
    // same pattern as the dashboard's own jsDelivr @latest — publishing a
    // new GitHub Release with the same asset filename is the only thing
    // that has to happen to ship an update; this link never changes.
    function detectOS() {
      var ua = (navigator.userAgent || "") + " " + (navigator.platform || "");
      if (/Win/i.test(ua)) return "windows";
      if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "mac";
      return "other";
    }
    function releaseAssetUrl(repo, asset) {
      return "https://github.com/" + repo + "/releases/latest/download/" + encodeURIComponent(asset);
    }

    // installSteps/openInstallSteps: the on-page checklist that pops up the
    // instant someone clicks a download button, so the guidance reads as
    // part of that click even though the file-save itself is the browser's
    // own UI (see the comment above detectOS — no page can skin or
    // automate that part, on any site). The overlay is appended to <body>,
    // not #cjt-setup-root, so it always covers the full viewport.
    function installSteps(kind) {
      if (kind === "mac") {
        return [
          "Your download has started in the browser (its own download bar/notification, not this page) — wait for it to finish.",
          'Open your Downloads folder and double-click <span class="mono">AAA-GHL-Extractor-Mac.zip</span> to unzip it (Safari/Chrome often do this automatically).',
          'Open the unzipped <span class="mono">AAA-GHL-Extractor-Mac</span> folder.',
          '<b>Right-click</b> <span class="mono">INSTALL-MAC.command</span> and choose <b>Open</b> — do not double-click it. macOS blocks it the first time as "from an unidentified developer"; right-click → Open tells macOS to trust it, once.',
          "Click <b>Open</b> again in the confirmation dialog. A Terminal window runs the installer — follow its prompts (same GHL token/location ID it's always asked for).",
          'When it finishes, open an AAA Work Order page — the extension icon should show "Connected." If it doesn\'t, double-click <span class="mono">CHECK-SETUP.command</span> in that same folder for a diagnostic.'
        ];
      }
      if (kind === "windows") {
        return ["A Windows build isn't published yet — this checklist will be filled in once it ships."];
      }
      return [];
    }
    function openInstallSteps(kind) {
      var overlay = document.createElement("div");
      overlay.className = "extInstallOverlay";
      var stepsHtml = installSteps(kind)
        .map(function (s, i) {
          return '<li><span class="stepNum">' + (i + 1) + '</span><span class="stepText">' + s + "</span></li>";
        })
        .join("");
      overlay.innerHTML =
        '<div class="extInstallCard">' +
        '<button type="button" class="extInstallClose" aria-label="Close">&times;</button>' +
        '<div class="extInstallTitle">' + (kind === "mac" ? "Installing on Mac" : "Installing on Windows") + "</div>" +
        '<div class="extInstallSub">Follow these steps once the download above finishes.</div>' +
        '<ol class="extInstallSteps">' + stepsHtml + "</ol>" +
        '<div class="btnRow"><button type="button" class="btn primary extInstallDone">Got it</button></div>' +
        "</div>";
      document.body.appendChild(overlay);
      function close() {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
      }
      function onKey(e) { if (e.key === "Escape") close(); }
      overlay.querySelector(".extInstallClose").addEventListener("click", close);
      overlay.querySelector(".extInstallDone").addEventListener("click", close);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
      document.addEventListener("keydown", onKey);
    }

    function renderExtensionDownload() {
      var repo = (CONFIG.extensionRepo || "").trim();
      var macAsset = (CONFIG.extensionMacAsset || "").trim();
      var winAsset = (CONFIG.extensionWindowsAsset || "").trim();
      if (!repo) {
        els.extDownloadWrap.innerHTML = '<div class="hint">Set <span class="mono">extensionRepo</span> in CJT_CONFIG (e.g. "your-org/cjt-ops-dashboard") to show download buttons here.</div>';
        return;
      }
      var os = detectOS();
      var macBtn = macAsset
        ? '<a class="btn primary" data-os="mac" href="' + esc(releaseAssetUrl(repo, macAsset)) + '" download>Download for Mac</a>'
        : '<button type="button" class="btn" disabled>Download for Mac (not published yet)</button>';
      var winBtn = winAsset
        ? '<a class="btn primary" data-os="windows" href="' + esc(releaseAssetUrl(repo, winAsset)) + '" download>Download for Windows</a>'
        : '<button type="button" class="btn" disabled title="A Windows build is planned but not built yet">Download for Windows (coming soon)</button>';
      var buttons = os === "windows" ? [winBtn, macBtn] : [macBtn, winBtn];
      var osNote =
        os === "mac" ? "Looks like you're on a Mac — that's the one to use. "
        : os === "windows" ? "Looks like you're on Windows — a Windows build isn't ready yet; check back soon, or use a Mac in the meantime. "
        : "";
      els.extDownloadWrap.innerHTML =
        '<div class="btnRow">' + buttons.join("") + "</div>" +
        '<div class="hint" style="margin-top:10px;">' + osNote +
        "Click a button to start the download — a step-by-step install checklist pops up here right away to walk you through the rest. This button only starts the download; the actual install still happens on that computer, same as any other desktop software." +
        "</div>";
      // Don't preventDefault on click — the browser's own download must
      // still fire normally. This only opens the on-page checklist for
      // what to do once that download lands.
      Array.prototype.forEach.call(els.extDownloadWrap.querySelectorAll("a.btn[data-os]"), function (a) {
        a.addEventListener("click", function () { openInstallSteps(a.getAttribute("data-os")); });
      });
    }
    renderExtensionDownload();
  }
})();

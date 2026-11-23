/*!
 * CJT Pay Statements — its own standalone page (split out of setup.js
 * 2026-11-23 so dispatcher-level staff can be granted this page without
 * ever touching Setup's billing/connection/security config). Auto-computes
 * a driver's commission from their own won Opportunities — job value x
 * their Commission % (set on the driver's profile in Drivers) — over a
 * date range, then writes one Pay Statement record once reviewed and
 * confirmed. Used to be setup.js's own "9. Driver Pay Statements" card;
 * folded into this file now so Pay Statements is fully self-contained.
 * Hosted on GitHub next to dashboard.js/setup.js/driver-onboarding.js,
 * loaded the same way (jsDelivr).
 *
 * Needs every won Opportunity tagged with the "Assigned Driver" field —
 * type the driver's name onto the job exactly as it appears on their
 * Drivers profile; nothing in this repo writes that automatically. The
 * driver picker here only ever shows names already on file in Drivers, so
 * a generated statement can't be typo'd onto the wrong driver from this
 * side — but a typo on the Opportunity's own Assigned Driver field is a
 * real failure mode this file can't catch; it just shows up as "0 jobs
 * matched" in the preview, which is why that empty-state message says to
 * check the spelling.
 *
 * Nothing is written to GHL until the preview is reviewed and APPLY is
 * typed to confirm, and a job already paid on an earlier statement for
 * that driver is excluded automatically (checked against every existing
 * Pay Statement record's own Line Items, regardless of that statement's
 * period) so overlapping or re-run date ranges can never double-pay a job.
 *
 * BEFORE THIS WORKS: load this page once and click "Set up Pay Statements"
 * (idempotent — safe to click again later; it only creates what's
 * missing). It provisions the pay_statements Custom Object + its 13
 * fields, plus one new Opportunity field ("Assigned Driver").
 *
 * ============================================================================
 * WHAT TO PASTE INTO THE "Pay Statements" GHL PAGE (Website/Funnel builder
 * -> Custom HTML/CSS/JS element). Use a Custom Menu Link to this page's own
 * GHL URL, set to "Embedded iframe". This page is meant to be given to
 * dispatcher/office-level staff — set its Role-Based Visibility to
 * whichever roles should run pay statements, not Admins-only (it never
 * touches billing/connection config).
 *
 *   <div id="cjt-pay-statements-root"></div>
 *   <script>
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
 *       dispatchPipelineName: "Towing Dispatch"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/jmdnoob/cjt-ops-dashboard@main/pay-statements.js"></script>
 *
 * Use "@main", not "@latest" — see the same note on setup.js/dashboard.js/
 * driver-onboarding.js.
 *
 * ============================================================================
 * CONFIRMED live 2026-11-23 against CJ Taylor Towing's real account:
 *   - The pay_statements Custom Object (custom_objects.pay_statements) and
 *     its "Pay Statement Info" field folder already exist on this account
 *     from earlier setup work — ensureObjectField below will find that
 *     folder by name and add any missing fields into it rather than
 *     creating a duplicate folder.
 *   - The corrected field-creation endpoints (GET/POST /custom-fields/...
 *     with an explicit parentId) and the ensureObjectSchema locationId fix
 *     — see getOrCreateFieldFolder/ensureObjectField/ensureObjectSchema
 *     below, same fix as setup.js's "Rates & Services" and
 *     driver-onboarding.js's own field setup.
 *   - Opportunity creation elsewhere in this repo confirmed no contactId is
 *     required; this file never creates Opportunities itself (read-only
 *     against the dispatch pipeline), only writes new pay_statements
 *     records and (once, on setup) the new Assigned Driver Opportunity
 *     field.
 * ============================================================================
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  var DEFAULTS = {
    apiBase: "https://services.leadconnectorhq.com",
    ghlBase: "",
    locationId: "",
    privateToken: "",
    dispatchPipelineName: "Towing Dispatch",
    objectKeys: { drivers: "driver_profiles", payStatements: "pay_statements" },
    apiVersions: { pipelines: "v3", opportunities: "2021-07-28", objects: "v3" },
  };
  var CONFIG = Object.assign({}, DEFAULTS, window.CJT_CONFIG || {});
  CONFIG.objectKeys = Object.assign({}, DEFAULTS.objectKeys, (window.CJT_CONFIG || {}).objectKeys || {});
  CONFIG.apiVersions = Object.assign({}, DEFAULTS.apiVersions, (window.CJT_CONFIG || {}).apiVersions || {});

  // ---------------------------------------------------------------------
  // GHL API client — identical rate-limit pacing + 429 retry/backoff as
  // every other file in this repo (see dashboard.js's copy for the full
  // rationale). Duplicated rather than shared — no module system between
  // these pasted-as-one-script-tag files, by design (see README).
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
          waitMs += Math.floor(Math.random() * 300); // jitter so parallel callers don't retry in lockstep
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

  // Same "custom_objects.<key>" qualification every other file in this
  // repo needs for record-level Objects API URLs — see dashboard.js's own
  // note.
  function objectSchemaKey(shortKey) {
    return "custom_objects." + shortKey;
  }

  // Paginates POST /objects/:schemaKey/records/search using searchAfter —
  // identical shape to dashboard.js's loadAllObjectRecords(), copied
  // rather than imported for the same no-shared-module reason as
  // objectSchemaKey above.
  function listObjectRecords(shortKey) {
    var pageLimit = 100;
    var all = [];
    function next(searchAfter) {
      var body = { locationId: CONFIG.locationId, page: 1, pageLimit: pageLimit, query: "" };
      if (searchAfter) body.searchAfter = searchAfter;
      return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/records/search", { method: "POST", version: CONFIG.apiVersions.objects, body: body }).then(function (res) {
        var batch = res.records || [];
        all = all.concat(batch);
        if (batch.length < pageLimit || all.length > 5000) return all;
        var last = batch[batch.length - 1];
        return next(last && last.searchAfter);
      });
    }
    return next(null);
  }

  function createObjectRecord(shortKey, properties) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/records", {
      method: "POST",
      version: CONFIG.apiVersions.objects,
      body: { locationId: CONFIG.locationId, properties: properties },
    });
  }

  // ---------------------------------------------------------------------
  // Custom-object schema/field creation — the corrected endpoints
  // (CONFIRMED live 2026-11-23, same fix as setup.js's "Rates & Services"
  // and driver-onboarding.js's own field setup):
  //   - GET /objects/:schemaKey needs ?locationId= or it 401s "LocationId
  //     is not specified" instead of 404ing, which would otherwise be
  //     mistaken for "doesn't exist yet" and rethrown as a real failure.
  //   - Field creation is GET/POST /custom-fields/... (NOT
  //     /objects/:schemaKey/fields, which 404s — not a real endpoint), and
  //     needs an explicit parentId (folder), fetched/created once per
  //     object key and cached.
  // ---------------------------------------------------------------------
  function ensureObjectSchema(shortKey, labels) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "?locationId=" + CONFIG.locationId, { version: CONFIG.apiVersions.objects })
      .then(function () { return { created: false }; })
      .catch(function (err) {
        if (!/ 404 /.test(" " + String((err && err.message) || "") + " ")) throw err;
        return ghlApi("/objects/", {
          method: "POST",
          version: CONFIG.apiVersions.objects,
          body: {
            locationId: CONFIG.locationId,
            key: shortKey,
            labels: labels, // { singular, plural }
            primaryDisplayPropertyDetails: { key: "name", name: "Name", dataType: "TEXT" },
          },
        }).then(function () { return { created: true }; });
      });
  }

  var fieldFolderCache = {};
  function getOrCreateFieldFolder(objectKey, folderName) {
    var cacheKey = objectKey + "::" + folderName;
    if (fieldFolderCache[cacheKey]) return fieldFolderCache[cacheKey];
    var p = ghlApi("/custom-fields/object-key/" + objectKey + "?locationId=" + CONFIG.locationId, { version: CONFIG.apiVersions.objects })
      .then(function (res) {
        var folders = (res && res.folders) || [];
        var existing = folders.filter(function (f) { return String(f.name || "").trim().toLowerCase() === folderName.trim().toLowerCase(); })[0];
        if (existing) return existing.id;
        return ghlApi("/custom-fields/folder", {
          method: "POST",
          version: CONFIG.apiVersions.objects,
          body: { locationId: CONFIG.locationId, name: folderName, objectKey: objectKey },
        }).then(function (res2) { return res2.folder.id; });
      });
    fieldFolderCache[cacheKey] = p;
    return p;
  }
  function keyToLabel(key) {
    return String(key).split("_").map(function (w) {
      return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    }).join(" ");
  }
  // Adds one field to a Custom Object schema if a field with this name
  // doesn't already exist on it. dataType is one of GHL's custom-object
  // field types: TEXT | LARGE_TEXT | NUMERICAL | MONETORY | CHECKBOX |
  // SINGLE_OPTIONS | DATE.
  function ensureObjectField(shortKey, fieldDef, folderName) {
    var objectKey = objectSchemaKey(shortKey);
    return ghlApi("/custom-fields/object-key/" + objectKey + "?locationId=" + CONFIG.locationId, { version: CONFIG.apiVersions.objects })
      .then(function (res) {
        var existing = (res && res.fields) || [];
        var already = existing.some(function (f) { return String(f.name || "").trim().toLowerCase() === fieldDef.name.trim().toLowerCase(); });
        if (already) return { created: false };
        return getOrCreateFieldFolder(objectKey, folderName || "Pay Statement Info").then(function (parentId) {
          var snakeKey = fieldDef.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
          var body = {
            locationId: CONFIG.locationId,
            name: fieldDef.name,
            showInForms: true,
            dataType: fieldDef.dataType,
            fieldKey: objectKey + "." + snakeKey,
            objectKey: objectKey,
            parentId: parentId,
          };
          if (fieldDef.picklistOptions && fieldDef.picklistOptions.length) {
            body.options = fieldDef.picklistOptions.map(function (key) {
              return { key: key, label: (fieldDef.optionLabels && fieldDef.optionLabels[key]) || keyToLabel(key) };
            });
          }
          return ghlApi("/custom-fields/", { method: "POST", version: CONFIG.apiVersions.objects, body: body })
            .then(function () { return { created: true }; });
        });
      });
  }

  // Adds one field to the Opportunity model itself (a different endpoint
  // than custom-object fields above — /locations/:id/customFields, the
  // same one fetchCustomFieldDefs() below reads from, just with
  // method: POST).
  function ensureOpportunityField(fieldDef) {
    return fetchCustomFieldDefs("opportunity").then(function (existing) {
      var already = existing.some(function (f) { return String(f.name || "").trim().toLowerCase() === fieldDef.name.trim().toLowerCase(); });
      if (already) return { created: false };
      return ghlApi("/locations/" + CONFIG.locationId + "/customFields", {
        method: "POST",
        version: "v3",
        body: Object.assign({ model: "opportunity" }, fieldDef),
      }).then(function () { return { created: true }; });
    });
  }

  // Idempotent — safe to click more than once (each ensure* call checks
  // before creating). Builds the pay_statements Custom Object + its 13
  // fields, then the one new Opportunity field ("Assigned Driver").
  function ensurePayStatementsSetup(onStep) {
    function step(label, fn) {
      if (onStep) onStep(label);
      return fn();
    }
    return step("Pay Statements object", function () {
      return ensureObjectSchema(CONFIG.objectKeys.payStatements, { singular: "Pay Statement", plural: "Pay Statements" });
    })
      .then(function () {
        return step("Pay Statements fields", function () {
          return Promise.all([
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Driver Name", dataType: "TEXT" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Period Start", dataType: "DATE" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Period End", dataType: "DATE" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Status", dataType: "TEXT" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Job Count", dataType: "NUMERICAL" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Gross Job Value", dataType: "MONETORY" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Commission Pct Used", dataType: "NUMERICAL" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Commission Total", dataType: "MONETORY" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Adjustment Amount", dataType: "MONETORY" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Adjustment Note", dataType: "TEXT" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Total", dataType: "MONETORY" }),
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Generated At", dataType: "DATE" }),
            // One job per line, serialized rather than a second linked
            // Custom Object — there's no real parent/child relation
            // exposed by this REST API (every "relation" in this repo is
            // just a text field matched by name), and a second object
            // only to hold a handful of rows per statement would add real
            // surface for no benefit at this scale.
            ensureObjectField(CONFIG.objectKeys.payStatements, { name: "Line Items JSON", dataType: "LARGE_TEXT" }),
          ]);
        });
      })
      .then(function () {
        return step("Opportunity field (Assigned Driver)", function () {
          return ensureOpportunityField({ name: "Assigned Driver", dataType: "TEXT" });
        });
      });
  }

  // ---------------------------------------------------------------------
  // Assigned Driver field resolution — by NAME, same idiom as every other
  // file in this repo (resolveFieldIds/resolveDriverFields).
  // ---------------------------------------------------------------------
  var FIELD_NAME_CANDIDATES = { assignedDriver: ["assigned driver"] };
  var FIELD_ID_FALLBACKS = { assignedDriver: [] };
  var resolvedFields = null;

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
      Object.keys(FIELD_NAME_CANDIDATES).forEach(function (key) {
        var candidates = FIELD_NAME_CANDIDATES[key];
        var match = allFields.filter(function (f) {
          return candidates.indexOf(String(f.name || "").trim().toLowerCase()) !== -1;
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
    (FIELD_ID_FALLBACKS[key] || []).forEach(function (id) {
      if (out.indexOf(id) === -1) out.push(id);
    });
    return out;
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
  // GET /opportunities/:id normally uses a single `fieldValue` key, but
  // GHL is inconsistent about this across endpoints — check every key
  // defensively.
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
  // Runs `fn` over `items` with at most `limit` in flight at once, calling
  // `onProgress(done, total)` after each one finishes.
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
  // Pay statement logic
  // ---------------------------------------------------------------------

  // Driver roster for the picker below, plus each driver's Commission %
  // and Pay Type — the same driver_profiles object dashboard.js's Drivers
  // tab already reads, just read here directly via listObjectRecords.
  function loadDriverRosterForPayStatements() {
    return listObjectRecords(CONFIG.objectKeys.drivers).then(function (recs) {
      return recs
        .map(function (r) {
          var p = r.properties || {};
          return {
            recordId: r.id,
            name: p.driver_name || "",
            payType: p.pay_type || "commission",
            commissionPct: parseFloat(p.commission_pct),
          };
        })
        .filter(function (d) { return d.name; });
    });
  }

  // Every Opportunity ID already included in ANY existing Pay Statement
  // for this driver, regardless of that statement's own period — so
  // generating a second statement whose date range overlaps (or even just
  // re-running the same range by mistake) can never double-pay a job a
  // previous statement already covered.
  function alreadyPaidOpportunityIds(driverName) {
    return listObjectRecords(CONFIG.objectKeys.payStatements).then(function (recs) {
      var ids = {};
      recs.forEach(function (r) {
        var p = r.properties || {};
        if (String(p.driver_name || "").trim().toLowerCase() !== driverName.trim().toLowerCase()) return;
        var items = [];
        try { items = JSON.parse(p.line_items_json || "[]"); } catch (e) { items = []; }
        items.forEach(function (it) { if (it && it.opportunityId) ids[it.opportunityId] = true; });
      });
      return ids;
    });
  }

  // Scans the dispatch pipeline for this driver's won jobs in the given
  // period. Filters cheaply first — status and updatedAt are already on
  // the lightweight /opportunities/search rows — and only does a
  // per-Opportunity GET (via mapWithConcurrency) on the subset that
  // survives that filter, since Assigned Driver needs the full/reliable
  // read.
  function scanOpportunitiesForDriverPay(driverName, periodStart, periodEnd, onProgress) {
    var startMs = new Date(periodStart + "T00:00:00").getTime();
    var endMs = new Date(periodEnd + "T23:59:59.999").getTime();
    return resolveFieldIds()
      .then(function () { return loadPipelines(); })
      .then(function (pipelines) {
        var pipeline = pipelines.filter(function (p) {
          return (p.name || "").toLowerCase() === CONFIG.dispatchPipelineName.toLowerCase();
        })[0];
        if (!pipeline) throw new Error('No pipeline named "' + CONFIG.dispatchPipelineName + '" found in this GHL location.');
        return loadAllOpportunities(pipeline.id).then(function (list) {
          var candidates = list.filter(function (o) {
            if (o.status !== "won") return false;
            var ts = new Date(o.updatedAt || o.dateUpdated || "").getTime();
            return !isNaN(ts) && ts >= startMs && ts <= endMs;
          });
          var assignedFieldIds = fieldIdsFor("assignedDriver");
          return mapWithConcurrency(candidates, 4, function (o) { return getOpportunity(o.id); }, onProgress).then(function (fullOpps) {
            var matched = [];
            fullOpps.forEach(function (full) {
              if (!full) return;
              var assigned = getCustomField(full, assignedFieldIds);
              if (String(assigned || "").trim().toLowerCase() !== driverName.trim().toLowerCase()) return;
              matched.push({
                opportunityId: full.id,
                name: full.name,
                updatedAt: full.updatedAt || full.dateUpdated || null,
                jobValue: full.monetaryValue != null ? full.monetaryValue : 0,
              });
            });
            return { pipelineName: pipeline.name, scanned: candidates.length, matched: matched };
          });
        });
      });
  }

  // Combines the scan above with the driver's Commission % and the
  // already-paid exclusion into the exact shape the preview/apply UI
  // needs.
  function buildPayStatementPreview(driver, periodStart, periodEnd, onProgress) {
    return Promise.all([
      scanOpportunitiesForDriverPay(driver.name, periodStart, periodEnd, onProgress),
      alreadyPaidOpportunityIds(driver.name),
    ]).then(function (results) {
      var scan = results[0];
      var paidIds = results[1];
      var pct = isNaN(driver.commissionPct) ? 0 : driver.commissionPct;
      var included = [];
      var excludedAlreadyPaid = 0;
      scan.matched.forEach(function (job) {
        if (paidIds[job.opportunityId]) {
          excludedAlreadyPaid += 1;
          return;
        }
        var commission = Math.round(job.jobValue * (pct / 100) * 100) / 100;
        included.push({
          opportunityId: job.opportunityId,
          name: job.name,
          updatedAt: job.updatedAt,
          jobValue: job.jobValue,
          commission: commission,
        });
      });
      var grossJobValue = included.reduce(function (s, j) { return s + j.jobValue; }, 0);
      var commissionTotal = included.reduce(function (s, j) { return s + j.commission; }, 0);
      return {
        driver: driver,
        periodStart: periodStart,
        periodEnd: periodEnd,
        pipelineName: scan.pipelineName,
        scanned: scan.scanned,
        excludedAlreadyPaid: excludedAlreadyPaid,
        jobs: included,
        grossJobValue: Math.round(grossJobValue * 100) / 100,
        commissionTotal: Math.round(commissionTotal * 100) / 100,
      };
    });
  }

  // Writes the statement — the only write this feature performs, gated
  // behind "type APPLY to confirm". commission_pct_used snapshots the rate
  // actually applied (not a live pointer to the driver's current
  // Commission %), so a later change to that driver's profile can never
  // retroactively change what this statement says they were paid for this
  // period.
  function applyPayStatement(preview, adjustmentAmount, adjustmentNote) {
    var adj = adjustmentAmount || 0;
    var total = Math.round((preview.commissionTotal + adj) * 100) / 100;
    var today = new Date().toISOString().slice(0, 10);
    return createObjectRecord(CONFIG.objectKeys.payStatements, {
      name: preview.driver.name + " — " + preview.periodStart + " to " + preview.periodEnd,
      driver_name: preview.driver.name,
      period_start: preview.periodStart,
      period_end: preview.periodEnd,
      status: "final",
      job_count: preview.jobs.length,
      gross_job_value: preview.grossJobValue,
      commission_pct_used: preview.driver.commissionPct,
      commission_total: preview.commissionTotal,
      adjustment_amount: adj,
      adjustment_note: adjustmentNote || "",
      total: total,
      generated_at: today,
      line_items_json: JSON.stringify(preview.jobs),
    });
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--pst-bg:#f5f6f8;--pst-panel:#fff;--pst-border:#e4e4e9;--pst-text:#19191c;--pst-text-dim:#6b7280;--pst-accent:#19191c;--pst-good:#15803d;--pst-good-soft:#e1f4e8;--pst-crit:#dc2626;--pst-crit-soft:#fbe4e2;--pst-warn:#b45309}',
    '#cjt-pay-statements-root *{box-sizing:border-box}',
    '#cjt-pay-statements-root{background:var(--pst-bg);color:var(--pst-text);font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px 16px 48px;max-width:720px;margin:0 auto}',
    '#cjt-pay-statements-root h1{font-size:19px;margin:0 0 4px;font-weight:700}',
    '#cjt-pay-statements-root h2{font-size:15.5px;margin:0 0 4px;font-weight:700}',
    '#cjt-pay-statements-root .pstSub{font-size:12.5px;color:var(--pst-text-dim);margin-bottom:18px;line-height:1.55}',
    '#cjt-pay-statements-root .pstSection{background:var(--pst-panel);border:1px solid var(--pst-border);border-radius:12px;padding:16px 18px;margin-bottom:14px}',
    '#cjt-pay-statements-root .pstDesc{font-size:12.5px;color:var(--pst-text-dim);line-height:1.55;margin-bottom:12px}',
    '#cjt-pay-statements-root .pstRow{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}',
    '#cjt-pay-statements-root .pstRow:last-child{margin-bottom:0}',
    '#cjt-pay-statements-root .pstField{flex:1 1 220px;display:flex;flex-direction:column;gap:5px}',
    '#cjt-pay-statements-root .pstField label{font-size:12px;font-weight:600;color:var(--pst-text)}',
    '#cjt-pay-statements-root input[type=text],#cjt-pay-statements-root input[type=number],#cjt-pay-statements-root input[type=date],#cjt-pay-statements-root select{border:1px solid var(--pst-border);border-radius:8px;padding:9px 11px;font-size:13.5px;font-family:inherit;background:var(--pst-panel);color:var(--pst-text);width:100%}',
    '#cjt-pay-statements-root input:focus,#cjt-pay-statements-root select:focus{outline:2px solid var(--pst-accent);outline-offset:1px;border-color:var(--pst-accent)}',
    '#cjt-pay-statements-root .btnRow{display:flex;gap:10px;flex-wrap:wrap}',
    '#cjt-pay-statements-root .btn{appearance:none;border:1px solid var(--pst-border);background:var(--pst-panel);color:var(--pst-text);font-family:inherit;font-size:13.5px;font-weight:600;padding:10px 18px;border-radius:9px;cursor:pointer}',
    '#cjt-pay-statements-root .btn.primary{background:var(--pst-accent);border-color:var(--pst-accent);color:#fff}',
    '#cjt-pay-statements-root .btn.primary:hover{opacity:.92}',
    '#cjt-pay-statements-root .btn.danger{background:var(--pst-crit);border-color:var(--pst-crit);color:#fff}',
    '#cjt-pay-statements-root .btn.danger:hover{opacity:.92}',
    '#cjt-pay-statements-root .btn:disabled{opacity:.5;cursor:not-allowed}',
    '#cjt-pay-statements-root .pstStatus{font-size:12.5px;color:var(--pst-text-dim);margin-top:12px;line-height:1.5}',
    '#cjt-pay-statements-root .pstStatus.ok{color:var(--pst-good)}',
    '#cjt-pay-statements-root .pstStatus.err{color:var(--pst-crit)}',
    '#cjt-pay-statements-root .pstStatus.warn{color:var(--pst-warn)}',
    '#cjt-pay-statements-root .pstHint{font-size:11.5px;color:var(--pst-text-dim);margin-top:8px;line-height:1.5}',
    '#cjt-pay-statements-root .pstSetupBox{background:var(--pst-panel);border:1px dashed var(--pst-border);border-radius:12px;padding:12px 16px;margin-bottom:18px}',
    '#cjt-pay-statements-root .pstSetupBox summary{font-size:12.5px;font-weight:700;cursor:pointer;color:var(--pst-text-dim)}',
    '#cjt-pay-statements-root .pstSetupDesc{font-size:11.5px;color:var(--pst-text-dim);line-height:1.5;margin:8px 0}',
    '#cjt-pay-statements-root .pstProgress{display:none;margin-top:12px}',
    '#cjt-pay-statements-root .pstProgress.show{display:block}',
    '#cjt-pay-statements-root .pstProgressBar{background:#eceef1;border-radius:999px;height:7px;overflow:hidden}',
    '#cjt-pay-statements-root .pstProgressBar > div{background:var(--pst-accent);height:100%;width:0%;transition:width .2s ease}',
    '#cjt-pay-statements-root .pstProgressLabel{font-size:11.5px;color:var(--pst-text-dim);margin-top:5px}',
    '#cjt-pay-statements-root .pstSummaryGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}',
    '#cjt-pay-statements-root .pstTile{background:var(--pst-bg);border:1px solid var(--pst-border);border-radius:10px;padding:12px 10px;text-align:center}',
    '#cjt-pay-statements-root .pstTile .n{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}',
    '#cjt-pay-statements-root .pstTile .l{font-size:11px;color:var(--pst-text-dim);margin-top:2px}',
    '#cjt-pay-statements-root .pstTile.matched .n{color:var(--pst-good)}',
    '#cjt-pay-statements-root .pstTableWrap{overflow-x:auto;margin-top:14px}',
    '#cjt-pay-statements-root table{width:100%;border-collapse:collapse;font-size:12.5px}',
    '#cjt-pay-statements-root th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--pst-text-dim);border-bottom:1px solid var(--pst-border);padding:6px 8px}',
    '#cjt-pay-statements-root td{border-bottom:1px solid var(--pst-border);padding:7px 8px;font-variant-numeric:tabular-nums}',
    '#cjt-pay-statements-root .pstApplyConfirm{margin-top:12px;display:flex;flex-direction:column;gap:6px;max-width:280px}',
    '#cjt-pay-statements-root .pstApplyConfirm input{text-transform:uppercase}'
  ].join("\n");

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    var v = parseFloat(n);
    if (isNaN(v)) v = 0;
    return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function mount() {
    var root = document.getElementById("cjt-pay-statements-root");
    if (!root) {
      console.error("[CJT Pay Statements] #cjt-pay-statements-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);

    root.innerHTML =
      '<details class="pstSetupBox"><summary>Admin: Pay Statements setup</summary>' +
      '<div class="pstSetupDesc">One-time, idempotent — creates the Pay Statements Custom Object + fields, and the “Assigned Driver” Opportunity field, if they don’t already exist. Safe to click again later; it skips anything already created.</div>' +
      '<div class="btnRow"><button type="button" class="btn" id="pstSetupBtn">Set up Pay Statements</button></div>' +
      '<div class="pstStatus" id="pstSetupStatus"></div>' +
      '</details>' +

      '<h1>Pay Statements</h1>' +
      '<div class="pstSub">Auto-computes a driver’s commission from their own won jobs — job value &times; their Commission % (set on their Drivers profile) — over a date range. <b>Needs every won job tagged with “Assigned Driver” first</b> — type the driver’s name onto the job exactly as it appears in Drivers; nothing here writes that automatically. Nothing is written to GHL until you review the preview and type APPLY, and a job already paid on an earlier statement for this driver is excluded automatically.</div>' +

      '<div class="pstSection">' +
      '<div class="pstRow">' +
      '<div class="pstField"><label for="pstDriver">Driver</label><select id="pstDriver"><option value="">Click “Load drivers” →</option></select></div>' +
      '<div class="pstField"><label>&nbsp;</label><button type="button" class="btn" id="pstLoadDrivers" style="width:100%;">Load drivers</button></div>' +
      '</div>' +
      '<div class="pstRow">' +
      '<div class="pstField"><label for="pstStart">Period start</label><input type="date" id="pstStart"></div>' +
      '<div class="pstField"><label for="pstEnd">Period end</label><input type="date" id="pstEnd"></div>' +
      '</div>' +
      '<div class="btnRow"><button type="button" class="btn primary" id="pstPreview">Preview</button></div>' +
      '<div class="pstProgress" id="pstProgress"><div class="pstProgressBar"><div id="pstProgressBar"></div></div><div class="pstProgressLabel" id="pstProgressLabel"></div></div>' +
      '<div class="pstStatus" id="pstStatus"></div>' +
      '<div id="pstSummary"></div>' +
      '<div id="pstTableWrap"></div>' +
      '<div id="pstAdjustWrap"></div>' +
      '<div id="pstApplyWrap"></div>' +
      '</div>';

    var els = {};
    ["pstSetupBtn", "pstSetupStatus", "pstDriver", "pstLoadDrivers", "pstStart", "pstEnd", "pstPreview",
     "pstProgress", "pstProgressBar", "pstProgressLabel", "pstStatus", "pstSummary", "pstTableWrap",
     "pstAdjustWrap", "pstApplyWrap"]
      .forEach(function (id) { els[id] = root.querySelector("#" + id); });

    function showStatus(el, kind, msg) {
      el.className = "pstStatus" + (kind ? " " + kind : "");
      el.textContent = msg;
    }
    function hideStatus(el) {
      el.className = "pstStatus";
      el.textContent = "";
    }

    if (!CONFIG.locationId || !CONFIG.privateToken) {
      showStatus(els.pstStatus, "err", "Missing locationId/privateToken in CJT_CONFIG for this page.");
      els.pstSetupBtn.disabled = true;
      els.pstLoadDrivers.disabled = true;
      els.pstPreview.disabled = true;
      return;
    }

    els.pstSetupBtn.addEventListener("click", function () {
      els.pstSetupBtn.disabled = true;
      showStatus(els.pstSetupStatus, "info", "Starting…");
      ensurePayStatementsSetup(function (label) { showStatus(els.pstSetupStatus, "info", label + "…"); })
        .then(function () {
          showStatus(els.pstSetupStatus, "ok", "Pay Statements is set up. Load drivers below and generate a statement.");
          resolvedFields = null; // force a fresh resolve now that the Assigned Driver field may exist
        })
        .catch(function (err) {
          showStatus(els.pstSetupStatus, "err", "Setup failed: " + err.message + " — safe to click “Set up Pay Statements” again, it skips anything already created.");
        })
        .finally(function () { els.pstSetupBtn.disabled = false; });
    });

    var payDrivers = [];

    els.pstLoadDrivers.addEventListener("click", function () {
      els.pstLoadDrivers.disabled = true;
      loadDriverRosterForPayStatements()
        .then(function (drivers) {
          payDrivers = drivers;
          els.pstDriver.innerHTML = drivers.length
            ? drivers.map(function (d) {
                var tag = d.payType !== "commission" ? " (" + esc(d.payType) + ")" : (isNaN(d.commissionPct) ? " (no %)" : " (" + d.commissionPct + "%)");
                return '<option value="' + esc(d.name) + '">' + esc(d.name) + tag + "</option>";
              }).join("")
            : '<option value="">No drivers found — add one in Drivers first</option>';
          showStatus(els.pstStatus, "ok", "Loaded " + drivers.length + " driver(s).");
        })
        .catch(function (err) { showStatus(els.pstStatus, "err", "Couldn’t load drivers: " + err.message); })
        .finally(function () { els.pstLoadDrivers.disabled = false; });
    });

    function setPayProgress(shown, done, total, label) {
      els.pstProgress.className = "pstProgress" + (shown ? " show" : "");
      if (total) els.pstProgressBar.style.width = Math.round((done / total) * 100) + "%";
      els.pstProgressLabel.textContent = label || (total ? done + " / " + total : "");
    }

    function renderPayPreview(preview) {
      els.pstSummary.innerHTML =
        '<div class="pstSummaryGrid">' +
        '<div class="pstTile matched"><div class="n">' + preview.jobs.length + '</div><div class="l">Jobs</div></div>' +
        '<div class="pstTile"><div class="n">' + money(preview.grossJobValue) + '</div><div class="l">Job value</div></div>' +
        '<div class="pstTile"><div class="n">' + money(preview.commissionTotal) + '</div><div class="l">Commission</div></div>' +
        '<div class="pstTile"><div class="n">' + preview.excludedAlreadyPaid + '</div><div class="l">Already paid</div></div>' +
        "</div>";

      if (preview.jobs.length === 0) {
        els.pstTableWrap.innerHTML = '<div class="pstHint">No won jobs found for ' + esc(preview.driver.name) + ' in this period with “Assigned Driver” set to this name — check the spelling on the job, and that “Assigned Driver” has actually been filled in.</div>';
      } else {
        els.pstTableWrap.innerHTML =
          '<div class="pstTableWrap"><table><thead><tr><th>Job</th><th>Closed</th><th>Job value</th><th>Commission</th></tr></thead><tbody>' +
          preview.jobs.map(function (j) {
            return "<tr><td>" + esc(j.name) + "</td><td>" + esc((j.updatedAt || "").slice(0, 10)) + "</td><td>" + money(j.jobValue) + "</td><td>" + money(j.commission) + "</td></tr>";
          }).join("") + "</tbody></table></div>";
      }

      els.pstAdjustWrap.innerHTML = preview.jobs.length === 0 ? "" :
        '<div class="pstRow" style="margin-top:12px;">' +
        '<div class="pstField"><label for="pstAdjustAmt">Adjustment ($, +/-)</label><input type="number" step="0.01" id="pstAdjustAmt" value="0"></div>' +
        '<div class="pstField"><label for="pstAdjustNote">Adjustment note</label><input type="text" id="pstAdjustNote" placeholder="e.g. fuel reimbursement"></div>' +
        "</div>";

      function currentTotal() {
        var amtEl = els.pstAdjustWrap.querySelector("#pstAdjustAmt");
        var adjAmt = amtEl ? parseFloat(amtEl.value) || 0 : 0;
        return Math.round((preview.commissionTotal + adjAmt) * 100) / 100;
      }

      if (preview.jobs.length === 0) {
        els.pstApplyWrap.innerHTML = '<div class="pstHint">Nothing to apply — no jobs matched.</div>';
        return;
      }

      els.pstApplyWrap.innerHTML =
        '<div class="pstStatus info" id="pstTotalMsg" style="display:block;">Total to pay: ' + money(currentTotal()) + "</div>" +
        '<div class="pstApplyConfirm"><label for="pstApplyConfirmInput" style="margin:0;font-size:12px;font-weight:600;">Type APPLY to confirm writing this statement to GHL:</label>' +
        '<input type="text" id="pstApplyConfirmInput"></div>' +
        '<div class="btnRow" style="margin-top:10px;"><button type="button" class="btn danger" id="pstApplyBtn" disabled>Apply to GHL</button></div>';

      var confirmInput = els.pstApplyWrap.querySelector("#pstApplyConfirmInput");
      var applyBtn = els.pstApplyWrap.querySelector("#pstApplyBtn");
      confirmInput.addEventListener("input", function () {
        applyBtn.disabled = confirmInput.value.trim().toUpperCase() !== "APPLY";
      });
      var amtEl = els.pstAdjustWrap.querySelector("#pstAdjustAmt");
      if (amtEl) {
        amtEl.addEventListener("input", function () {
          var totalMsg = els.pstApplyWrap.querySelector("#pstTotalMsg");
          if (totalMsg) totalMsg.textContent = "Total to pay: " + money(currentTotal());
        });
      }
      applyBtn.addEventListener("click", function () {
        applyBtn.disabled = true;
        confirmInput.disabled = true;
        var adjAmt = amtEl ? parseFloat(amtEl.value) || 0 : 0;
        var noteEl = els.pstAdjustWrap.querySelector("#pstAdjustNote");
        var adjNote = noteEl ? noteEl.value.trim() : "";
        applyPayStatement(preview, adjAmt, adjNote)
          .then(function () {
            showStatus(els.pstStatus, "ok", "Done. Pay statement for " + preview.driver.name + " written to GHL.");
            els.pstApplyWrap.innerHTML = "";
          })
          .catch(function (err) {
            showStatus(els.pstStatus, "err", "Apply failed: " + err.message);
            applyBtn.disabled = false;
            confirmInput.disabled = false;
          });
      });
    }

    els.pstPreview.addEventListener("click", function () {
      var driverName = els.pstDriver.value;
      var driver = payDrivers.filter(function (d) { return d.name === driverName; })[0];
      var start = els.pstStart.value;
      var end = els.pstEnd.value;
      hideStatus(els.pstStatus);
      els.pstSummary.innerHTML = "";
      els.pstTableWrap.innerHTML = "";
      els.pstAdjustWrap.innerHTML = "";
      els.pstApplyWrap.innerHTML = "";
      if (!driver) { showStatus(els.pstStatus, "err", "Click “Load drivers” and pick a driver first."); return; }
      if (!start || !end) { showStatus(els.pstStatus, "err", "Pick a period start and end date."); return; }
      if (isNaN(driver.commissionPct)) { showStatus(els.pstStatus, "err", driver.name + " has no Commission % set on their driver profile — set it there first."); return; }
      els.pstPreview.disabled = true;
      setPayProgress(true, 0, 1, "Scanning jobs…");
      buildPayStatementPreview(driver, start, end, function (done, total) {
        setPayProgress(true, done, total, "Scanning jobs… " + done + " / " + total);
      })
        .then(function (preview) {
          setPayProgress(false, 0, 0, "");
          showStatus(els.pstStatus, "info", "Scanned " + preview.scanned + " won job(s) in “" + preview.pipelineName + "” closed in this period — " + preview.jobs.length + " assigned to " + driver.name + ". Nothing written yet — review below.");
          renderPayPreview(preview);
        })
        .catch(function (err) {
          setPayProgress(false, 0, 0, "");
          showStatus(els.pstStatus, "err", err.message);
        })
        .finally(function () { els.pstPreview.disabled = false; });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

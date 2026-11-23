/*!
 * CJT Driver Onboarding — its own standalone page (split out of setup.js
 * 2026-11-23 so dispatcher-level staff can be granted this page without
 * ever touching Setup's billing/connection/security config). Add/edit a
 * driver profile (custom_objects.driver_profiles) and, for a brand-new
 * driver, automatically drop a new Opportunity into the Onboarding
 * Pipeline. Also provisions the driver-profile fields this page's own
 * form needs (see "Set up driver fields" at the top of the page) — that
 * used to be setup.js's own "10. Driver Onboarding Setup" card; it's
 * folded into this file now so Drivers is fully self-contained. Hosted on
 * GitHub next to dashboard.js/setup.js, loaded the same way (jsDelivr).
 *
 * BEFORE THIS WORKS:
 *   1. Load this page once and click "Set up driver fields" (idempotent —
 *      safe to click again later; it only creates what's missing).
 *   2. Create the "Onboarding" Pipeline by hand in Settings -> Pipelines
 *      (this file can't create a Pipeline or its stages itself — only
 *      Custom Object/field endpoints are reachable through the API this
 *      repo otherwise uses). The exact stage names don't matter beyond
 *      the first one: whatever CONFIG.onboardingFirstStageName names
 *      (default "Applied") is where a new driver's Opportunity lands —
 *      CJ Taylor Towing's own Pipeline is Applied / Document Submitted /
 *      Background Check / Approved / Rejected.
 *
 * ============================================================================
 * WHAT TO PASTE INTO THE "Drivers" GHL PAGE (Website/Funnel builder ->
 * Custom HTML/CSS/JS element). Use a Custom Menu Link to this page's own
 * GHL URL, set to "Embedded iframe". Unlike Setup, this page is meant to
 * be given to dispatcher-level staff — set its Role-Based Visibility to
 * whichever roles should manage drivers, not Admins-only.
 *
 *   <div id="cjt-driver-onboarding-root"></div>
 *   <script>
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
 *       onboardingPipelineName: "Onboarding",
 *       onboardingFirstStageName: "Applied"
 *     };
 *   </script>
 *   <script src="https://cdn.jsdelivr.net/gh/jmdnoob/cjt-ops-dashboard@main/driver-onboarding.js"></script>
 *
 * Use "@main", not "@latest" — see the same note on setup.js/dashboard.js.
 *
 * dashboard.js's Drivers table already links here with ?driverId=<recordId>
 * (see its onboardingUrl()/CONFIG.onboardingUrl) so clicking a driver row
 * opens straight into that driver's own form instead of a blank one.
 *
 * ============================================================================
 * CONFIRMED live 2026-11-23 against CJ Taylor Towing's real account, via
 * a throwaway test driver + test Opportunity (both created, verified, and
 * deleted in the same session):
 *   - Field-key resolution for the driver's own name field (resolves to
 *     the real existing "Driver Name" field by name; the "driver_name"
 *     fallback was never actually needed on this account but stays as a
 *     safety net).
 *   - The 12 new driver-profile fields this form reads/writes (Email,
 *     Phone, Onboarding Status, Employment Type, Pay Type, Commission %,
 *     Hourly Rate, License/Insurance/MVR/Certification/Training Status) —
 *     created for real on this account's Drivers object.
 *   - Opportunity creation (createOnboardingOpportunity below) — POST
 *     /opportunities/ with no contactId at all succeeds fine
 *     ("contactId": null in the response); no linked Contact is required.
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
    onboardingPipelineName: "Onboarding",
    onboardingFirstStageName: "Applied",
    objectKeys: { drivers: "driver_profiles" },
    apiVersions: { pipelines: "v3", objects: "v3" },
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

  // Same "custom_objects.<key>" qualification every other file in this repo
  // needs for record-level Objects API URLs — see dashboard.js's own note.
  function objectSchemaKey(shortKey) {
    return "custom_objects." + shortKey;
  }
  function getObjectRecord(shortKey, recordId) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/records/" + recordId, { version: CONFIG.apiVersions.objects });
  }
  function createObjectRecord(shortKey, properties) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/records", {
      method: "POST",
      version: CONFIG.apiVersions.objects,
      body: { locationId: CONFIG.locationId, properties: properties },
    });
  }
  function updateObjectRecord(shortKey, recordId, properties) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/records/" + recordId, {
      method: "PUT",
      version: CONFIG.apiVersions.objects,
      body: { properties: properties },
    });
  }
  function fetchObjectFieldDefs(shortKey) {
    var objectKey = objectSchemaKey(shortKey);
    return ghlApi("/custom-fields/object-key/" + objectKey + "?locationId=" + CONFIG.locationId, { version: CONFIG.apiVersions.objects })
      .then(function (res) { return (res && res.fields) || []; });
  }

  // Field folders are required by the real create-field endpoint
  // (parentId) -- fetched/created once per object key and cached. Same
  // fix/shape as setup.js's own getOrCreateFieldFolder/ensureObjectField
  // (CONFIRMED live 2026-11-23 against this location's real
  // driver_profiles object) -- duplicated here rather than shared, same
  // no-shared-module reason as everything else in this file.
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
  function ensureObjectField(shortKey, fieldDef, folderName) {
    var objectKey = objectSchemaKey(shortKey);
    return ghlApi("/custom-fields/object-key/" + objectKey + "?locationId=" + CONFIG.locationId, { version: CONFIG.apiVersions.objects })
      .then(function (res) {
        var existing = (res && res.fields) || [];
        var already = existing.some(function (f) { return String(f.name || "").trim().toLowerCase() === fieldDef.name.trim().toLowerCase(); });
        if (already) return { created: false };
        return getOrCreateFieldFolder(objectKey, folderName || "Driver Info").then(function (parentId) {
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

  // Provisions every field this page's own form reads/writes on the
  // Drivers object (everything except the driver's own name field, which
  // already exists -- see resolveDriverFields()'s own comment on why this
  // never tries to create that one under a guessed name). Idempotent --
  // safe to click more than once; each ensureObjectField call checks
  // before creating. CONFIRMED live 2026-11-23 -- this exact set of 12
  // fields was created this way against CJ Taylor Towing's real account.
  function ensureDriverFieldsSetup(onStep) {
    function step(label, fn) {
      if (onStep) onStep(label);
      return fn();
    }
    return step("Driver profile fields", function () {
      return Promise.all([
        ensureObjectField(CONFIG.objectKeys.drivers, { name: "Email", dataType: "TEXT" }),
        ensureObjectField(CONFIG.objectKeys.drivers, { name: "Phone", dataType: "TEXT" }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "Onboarding Status", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["onboarding", "active", "suspended"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "Employment Type", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["full_time", "part_time", "weekend"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "Pay Type", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["commission", "hourly"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, { name: "Commission Pct", dataType: "NUMERICAL" }),
        ensureObjectField(CONFIG.objectKeys.drivers, { name: "Hourly Rate", dataType: "MONETORY" }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "License Status", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["on_file", "missing", "expired"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "Insurance Status", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["on_file", "missing", "expired"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "MVR Status", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["on_file", "missing", "expired"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "Certification Status", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["on_file", "missing", "expired"],
        }),
        ensureObjectField(CONFIG.objectKeys.drivers, {
          name: "Training Status", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["not_started", "in_progress", "complete"],
        }),
      ]);
    });
  }

  function loadPipelines() {
    return ghlApi("/opportunities/pipelines?" + qs({ locationId: CONFIG.locationId }), { version: CONFIG.apiVersions.pipelines }).then(function (res) {
      return res.pipelines || [];
    });
  }

  // ---------------------------------------------------------------------
  // Driver field resolution — by NAME, not a hardcoded id, same idiom as
  // resolveFieldIds() elsewhere in this repo, with a hardcoded fallback
  // ONLY for the driver's own name field (see this file's top comment for
  // why: nothing here can know for certain whether that field is named
  // "Driver Name" or "Driver's Name" without reading it live).
  // ---------------------------------------------------------------------
  var FIELD_NAME_CANDIDATES = {
    fullName: ["driver name", "drivers name", "driver's name", "full name", "name"],
    email: ["email"],
    phone: ["phone", "phone number"],
    onboardingStatus: ["onboarding status"],
    employmentType: ["employment type"],
    payType: ["pay type"],
    commissionPct: ["commission pct", "commission %", "commission percent", "commission"],
    hourlyRate: ["hourly rate"],
    licenseStatus: ["license status"],
    insuranceStatus: ["insurance status"],
    mvrStatus: ["mvr status"],
    certificationStatus: ["certification status"],
    trainingStatus: ["training status"],
  };
  var FIELD_KEY_FALLBACKS = {
    fullName: "driver_name", // matches dashboard.js's/setup.js's own assumption everywhere else
  };
  function normalizeFieldName(s) {
    return String(s || "").toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
  }
  // GHL's object-fields response shape for the actual writable property key
  // isn't confirmed in this session (see top-of-file UNVERIFIED note) — try
  // the few shapes its other endpoints use elsewhere in this repo, falling
  // back to slugifying the display name the same way GHL itself does.
  function fieldWriteKey(f) {
    if (f.fieldKey) return String(f.fieldKey).split(".").pop();
    if (f.key) return f.key;
    return String(f.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  var resolvedDriverFields = null;
  function resolveDriverFields() {
    if (resolvedDriverFields) return Promise.resolve(resolvedDriverFields);
    return fetchObjectFieldDefs(CONFIG.objectKeys.drivers).then(function (fields) {
      var byNormalizedName = {};
      fields.forEach(function (f) { byNormalizedName[normalizeFieldName(f.name)] = f; });
      var keys = {};
      Object.keys(FIELD_NAME_CANDIDATES).forEach(function (fieldKey) {
        var match = null;
        FIELD_NAME_CANDIDATES[fieldKey].some(function (candidate) {
          if (byNormalizedName[candidate]) { match = byNormalizedName[candidate]; return true; }
          return false;
        });
        if (match) keys[fieldKey] = fieldWriteKey(match);
        else if (FIELD_KEY_FALLBACKS[fieldKey]) keys[fieldKey] = FIELD_KEY_FALLBACKS[fieldKey];
        else keys[fieldKey] = null; // not created yet — click "Set up driver fields" above
      });
      resolvedDriverFields = keys;
      return keys;
    });
  }

  function driverIdFromQuery() {
    try {
      return new URLSearchParams(window.location.search).get("driverId") || "";
    } catch (e) {
      return "";
    }
  }

  // Best-effort — failures here are reported separately from the driver
  // save itself (see submit handler), since the driver record is the part
  // that actually must not get lost.
  function createOnboardingOpportunity(driverName) {
    return loadPipelines().then(function (pipelines) {
      var pipeline = pipelines.filter(function (p) {
        return (p.name || "").toLowerCase() === CONFIG.onboardingPipelineName.toLowerCase();
      })[0];
      if (!pipeline) throw new Error('No pipeline named "' + CONFIG.onboardingPipelineName + '" found — create it in Settings → Pipelines first (see this file’s top comment for the exact stage names).');
      var stages = pipeline.stages || [];
      var stage = stages.filter(function (s) {
        return (s.name || "").toLowerCase() === CONFIG.onboardingFirstStageName.toLowerCase();
      })[0];
      if (!stage) throw new Error('Pipeline "' + CONFIG.onboardingPipelineName + '" has no stage named "' + CONFIG.onboardingFirstStageName + '" — check the stage name matches exactly.');
      return ghlApi("/opportunities/", {
        method: "POST",
        version: "2021-07-28",
        body: {
          locationId: CONFIG.locationId,
          pipelineId: pipeline.id,
          pipelineStageId: stage.id,
          name: driverName + " — Onboarding",
          status: "open",
        },
      });
    });
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--don-bg:#f5f6f8;--don-panel:#fff;--don-border:#e4e4e9;--don-text:#19191c;--don-text-dim:#6b7280;--don-accent:#19191c;--don-good:#15803d;--don-good-soft:#e1f4e8;--don-crit:#dc2626;--don-crit-soft:#fbe4e2}',
    '#cjt-driver-onboarding-root *{box-sizing:border-box}',
    '#cjt-driver-onboarding-root{background:var(--don-bg);color:var(--don-text);font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px 16px 48px;max-width:640px;margin:0 auto}',
    '#cjt-driver-onboarding-root h2{font-size:17px;margin:0 0 4px;font-weight:700}',
    '#cjt-driver-onboarding-root .donSub{font-size:12.5px;color:var(--don-text-dim);margin-bottom:18px;line-height:1.5}',
    '#cjt-driver-onboarding-root .donSection{background:var(--don-panel);border:1px solid var(--don-border);border-radius:12px;padding:16px 18px;margin-bottom:14px}',
    '#cjt-driver-onboarding-root .donSectionTitle{font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--don-text-dim);margin-bottom:12px}',
    '#cjt-driver-onboarding-root .donRow{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}',
    '#cjt-driver-onboarding-root .donRow:last-child{margin-bottom:0}',
    '#cjt-driver-onboarding-root .donField{flex:1 1 220px;display:flex;flex-direction:column;gap:5px}',
    '#cjt-driver-onboarding-root .donField label{font-size:12px;font-weight:600;color:var(--don-text)}',
    '#cjt-driver-onboarding-root input[type=text],#cjt-driver-onboarding-root input[type=email],#cjt-driver-onboarding-root input[type=tel],#cjt-driver-onboarding-root input[type=number],#cjt-driver-onboarding-root select{border:1px solid var(--don-border);border-radius:8px;padding:9px 11px;font-size:13.5px;font-family:inherit;background:var(--don-panel);color:var(--don-text);width:100%}',
    '#cjt-driver-onboarding-root input:focus,#cjt-driver-onboarding-root select:focus{outline:2px solid var(--don-accent);outline-offset:1px;border-color:var(--don-accent)}',
    '#cjt-driver-onboarding-root .btn{appearance:none;border:1px solid var(--don-border);background:var(--don-panel);color:var(--don-text);font-family:inherit;font-size:13.5px;font-weight:600;padding:10px 18px;border-radius:9px;cursor:pointer}',
    '#cjt-driver-onboarding-root .btn.primary{background:var(--don-accent);border-color:var(--don-accent);color:#fff}',
    '#cjt-driver-onboarding-root .btn.primary:hover{opacity:.92}',
    '#cjt-driver-onboarding-root .btn:disabled{opacity:.5;cursor:not-allowed}',
    '#cjt-driver-onboarding-root .donStatus{font-size:12.5px;color:var(--don-text-dim);margin-top:12px;line-height:1.5}',
    '#cjt-driver-onboarding-root .donStatus.ok{color:var(--don-good)}',
    '#cjt-driver-onboarding-root .donStatus.err{color:var(--don-crit)}',
    '#cjt-driver-onboarding-root .donStatus.warn{color:#b45309}',
    '#cjt-driver-onboarding-root .donHint{font-size:11.5px;color:var(--don-text-dim);margin-top:3px;line-height:1.4}',
    '#cjt-driver-onboarding-root .donSetupBox{background:var(--don-panel);border:1px dashed var(--don-border);border-radius:12px;padding:12px 16px;margin-bottom:18px}',
    '#cjt-driver-onboarding-root .donSetupBox summary{font-size:12.5px;font-weight:700;cursor:pointer;color:var(--don-text-dim)}',
    '#cjt-driver-onboarding-root .donSetupDesc{font-size:11.5px;color:var(--don-text-dim);line-height:1.5;margin:8px 0}'
  ].join("\n");

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function optionsHtml(selectedKey, pairs) {
    return pairs.map(function (p) {
      return '<option value="' + esc(p[0]) + '"' + (p[0] === selectedKey ? " selected" : "") + ">" + esc(p[1]) + "</option>";
    }).join("");
  }

  var DOC_STATUS_OPTIONS = [["missing", "Missing"], ["on_file", "On File"], ["expired", "Expired"]];

  function mount() {
    var root = document.getElementById("cjt-driver-onboarding-root");
    if (!root) {
      console.error("[CJT Driver Onboarding] #cjt-driver-onboarding-root not found on the page.");
      return;
    }
    var styleEl = document.createElement("style");
    styleEl.textContent = CSS_TEXT;
    document.head.appendChild(styleEl);

    var driverId = driverIdFromQuery();
    var isEdit = !!driverId;

    root.innerHTML =
      '<details class="donSetupBox"><summary>Admin: driver field setup</summary>' +
      '<div class="donSetupDesc">One-time, idempotent — creates whichever of the driver-profile fields this form needs don\'t already exist on the Drivers object yet. Safe to click again later; it skips anything already created.</div>' +
      '<div class="btnRow"><button type="button" class="btn" id="donSetupBtn">Set up driver fields</button></div>' +
      '<div class="donStatus" id="donSetupStatus"></div>' +
      '</details>' +
      '<h2 id="donHeading"></h2>' +
      '<div class="donSub" id="donSub"></div>' +
      '<form id="donForm">' +
      '<div class="donSection"><div class="donSectionTitle">Driver Info</div>' +
      '<div class="donRow"><div class="donField"><label for="donName">Full Name *</label><input type="text" id="donName" required></div></div>' +
      '<div class="donRow">' +
      '<div class="donField"><label for="donEmail">Email</label><input type="email" id="donEmail"></div>' +
      '<div class="donField"><label for="donPhone">Phone</label><input type="tel" id="donPhone"></div>' +
      '</div>' +
      '<div class="donRow">' +
      '<div class="donField"><label for="donEmploymentType">Employment Type</label><select id="donEmploymentType">' + optionsHtml("full_time", [["full_time", "Full-Time"], ["part_time", "Part-Time"], ["weekend", "Weekend"]]) + '</select></div>' +
      '<div class="donField"><label for="donOnboardingStatus">Onboarding Status</label><select id="donOnboardingStatus">' + optionsHtml("onboarding", [["onboarding", "Onboarding"], ["active", "Active"], ["suspended", "Suspended"]]) + '</select></div>' +
      '</div>' +
      '</div>' +

      '<div class="donSection"><div class="donSectionTitle">Pay</div>' +
      '<div class="donRow">' +
      '<div class="donField"><label for="donPayType">Pay Type</label><select id="donPayType"><option value="commission">Commission</option><option value="hourly">Hourly</option></select></div>' +
      '<div class="donField" id="donCommissionWrap"><label for="donCommissionPct">Commission %</label><input type="number" step="0.1" id="donCommissionPct" placeholder="e.g. 60"></div>' +
      '<div class="donField" id="donHourlyWrap" style="display:none;"><label for="donHourlyRate">Hourly Rate ($)</label><input type="number" step="0.01" id="donHourlyRate" placeholder="e.g. 20"></div>' +
      '</div>' +
      '<div class="donHint" id="donPayHint"></div>' +
      '</div>' +

      '<div class="donSection"><div class="donSectionTitle">Documents on File</div>' +
      '<div class="donRow">' +
      '<div class="donField"><label for="donLicenseStatus">Driver’s License</label><select id="donLicenseStatus">' + optionsHtml("missing", DOC_STATUS_OPTIONS) + '</select></div>' +
      '<div class="donField"><label for="donInsuranceStatus">Insurance</label><select id="donInsuranceStatus">' + optionsHtml("missing", DOC_STATUS_OPTIONS) + '</select></div>' +
      '</div>' +
      '<div class="donRow">' +
      '<div class="donField"><label for="donMvrStatus">MVR (Driving Record)</label><select id="donMvrStatus">' + optionsHtml("missing", DOC_STATUS_OPTIONS) + '</select></div>' +
      '<div class="donField"><label for="donCertificationStatus">Certification</label><select id="donCertificationStatus">' + optionsHtml("missing", DOC_STATUS_OPTIONS) + '</select></div>' +
      '</div>' +
      '</div>' +

      '<button type="submit" class="btn primary" id="donSubmit"></button>' +
      '<div class="donStatus" id="donStatus"></div>' +
      '</form>';

    var els = {};
    ["donSetupBtn", "donSetupStatus",
     "donHeading", "donSub", "donForm", "donName", "donEmail", "donPhone", "donEmploymentType", "donOnboardingStatus",
     "donPayType", "donCommissionWrap", "donCommissionPct", "donHourlyWrap", "donHourlyRate", "donPayHint",
     "donLicenseStatus", "donInsuranceStatus", "donMvrStatus", "donCertificationStatus", "donSubmit", "donStatus"]
      .forEach(function (id) { els[id] = root.querySelector("#" + id); });

    els.donHeading.textContent = isEdit ? "Edit Driver" : "New Driver — Onboarding";
    els.donSub.textContent = isEdit
      ? "Updating this driver's own profile. This does not create another onboarding Opportunity."
      : "Saving this creates the driver's profile, then drops a new Opportunity into the “" + CONFIG.onboardingPipelineName + "” Pipeline (" + CONFIG.onboardingFirstStageName + " stage) so you can track them through onboarding.";
    els.donSubmit.textContent = isEdit ? "Save changes" : "Add Driver";

    function syncPayTypeUI() {
      var hourly = els.donPayType.value === "hourly";
      els.donCommissionWrap.style.display = hourly ? "none" : "";
      els.donHourlyWrap.style.display = hourly ? "" : "none";
      els.donPayHint.textContent = hourly
        ? "Note: the Pay Statements generator (its own page, pay-statements.js) only computes commission-based pay today — an hourly driver's rate is stored here for now, not yet paid out automatically."
        : "Used by the Pay Statements generator (its own page, pay-statements.js): job value × this %, across that driver's own won Opportunities tagged with their name.";
    }
    els.donPayType.addEventListener("change", syncPayTypeUI);
    syncPayTypeUI();

    function showStatus(kind, msg) {
      els.donStatus.className = "donStatus" + (kind ? " " + kind : "");
      els.donStatus.textContent = msg;
    }

    if (!CONFIG.locationId || !CONFIG.privateToken) {
      showStatus("err", "Missing locationId/privateToken in CJT_CONFIG for this page.");
      els.donSubmit.disabled = true;
      els.donSetupBtn.disabled = true;
      return;
    }

    els.donSetupBtn.addEventListener("click", function () {
      els.donSetupBtn.disabled = true;
      els.donSetupStatus.className = "donStatus info";
      els.donSetupStatus.textContent = "Starting…";
      ensureDriverFieldsSetup(function (label) {
        els.donSetupStatus.className = "donStatus info";
        els.donSetupStatus.textContent = label + "…";
      })
        .then(function () {
          els.donSetupStatus.className = "donStatus ok";
          els.donSetupStatus.textContent = "Driver profile fields are set up.";
          resolvedDriverFields = null; // force a fresh resolve now that new fields may exist
        })
        .catch(function (err) {
          els.donSetupStatus.className = "donStatus err";
          els.donSetupStatus.textContent = "Setup failed: " + err.message + " — safe to click again, it skips anything already created.";
        })
        .finally(function () { els.donSetupBtn.disabled = false; });
    });

    var fieldKeys = null;
    var existingRecord = null;

    resolveDriverFields()
      .then(function (keys) {
        fieldKeys = keys;
        if (!isEdit) return null;
        showStatus("", "Loading driver…");
        return getObjectRecord(CONFIG.objectKeys.drivers, driverId);
      })
      .then(function (rec) {
        if (rec) {
          existingRecord = rec;
          var p = rec.properties || rec.record || {};
          if (fieldKeys.fullName) els.donName.value = p[fieldKeys.fullName] || "";
          if (fieldKeys.email) els.donEmail.value = p[fieldKeys.email] || "";
          if (fieldKeys.phone) els.donPhone.value = p[fieldKeys.phone] || "";
          if (fieldKeys.employmentType && p[fieldKeys.employmentType]) els.donEmploymentType.value = p[fieldKeys.employmentType];
          if (fieldKeys.onboardingStatus && p[fieldKeys.onboardingStatus]) els.donOnboardingStatus.value = p[fieldKeys.onboardingStatus];
          if (fieldKeys.payType && p[fieldKeys.payType]) els.donPayType.value = p[fieldKeys.payType];
          if (fieldKeys.commissionPct != null) els.donCommissionPct.value = p[fieldKeys.commissionPct] != null ? p[fieldKeys.commissionPct] : "";
          if (fieldKeys.hourlyRate != null) els.donHourlyRate.value = p[fieldKeys.hourlyRate] != null ? p[fieldKeys.hourlyRate] : "";
          if (fieldKeys.licenseStatus && p[fieldKeys.licenseStatus]) els.donLicenseStatus.value = p[fieldKeys.licenseStatus];
          if (fieldKeys.insuranceStatus && p[fieldKeys.insuranceStatus]) els.donInsuranceStatus.value = p[fieldKeys.insuranceStatus];
          if (fieldKeys.mvrStatus && p[fieldKeys.mvrStatus]) els.donMvrStatus.value = p[fieldKeys.mvrStatus];
          if (fieldKeys.certificationStatus && p[fieldKeys.certificationStatus]) els.donCertificationStatus.value = p[fieldKeys.certificationStatus];
          syncPayTypeUI();
        }
        showStatus("", "");
      })
      .catch(function (err) {
        showStatus("err", "Couldn't load: " + err.message);
      });

    els.donForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!fieldKeys) return;
      var name = els.donName.value.trim();
      if (!name) { showStatus("err", "Full Name is required."); return; }

      var properties = {};
      function set(key, value) { if (fieldKeys[key]) properties[fieldKeys[key]] = value; }
      set("fullName", name);
      set("email", els.donEmail.value.trim());
      set("phone", els.donPhone.value.trim());
      set("employmentType", els.donEmploymentType.value);
      set("onboardingStatus", els.donOnboardingStatus.value);
      set("payType", els.donPayType.value);
      if (els.donPayType.value === "commission") {
        set("commissionPct", els.donCommissionPct.value ? parseFloat(els.donCommissionPct.value) : null);
      } else {
        set("hourlyRate", els.donHourlyRate.value ? parseFloat(els.donHourlyRate.value) : null);
      }
      set("licenseStatus", els.donLicenseStatus.value);
      set("insuranceStatus", els.donInsuranceStatus.value);
      set("mvrStatus", els.donMvrStatus.value);
      set("certificationStatus", els.donCertificationStatus.value);
      if (!isEdit) set("trainingStatus", "not_started");

      els.donSubmit.disabled = true;
      showStatus("", isEdit ? "Saving…" : "Creating driver…");

      var savePromise = isEdit
        ? updateObjectRecord(CONFIG.objectKeys.drivers, driverId, properties)
        : createObjectRecord(CONFIG.objectKeys.drivers, properties);

      savePromise
        .then(function (res) {
          if (isEdit) {
            showStatus("ok", "Saved.");
            els.donSubmit.disabled = false;
            return;
          }
          var newRecordId = (res && (res.id || (res.record && res.record.id))) || null;
          showStatus("ok", "Driver created. Creating onboarding Opportunity…");
          return createOnboardingOpportunity(name)
            .then(function () {
              showStatus("ok", "Driver created, and added to “" + CONFIG.onboardingPipelineName + "” (" + CONFIG.onboardingFirstStageName + "). Reload this page to add another driver.");
            })
            .catch(function (err) {
              showStatus("warn", "Driver was created, but the onboarding Opportunity couldn't be — " + err.message);
            });
        })
        .catch(function (err) {
          showStatus("err", (isEdit ? "Save failed: " : "Couldn't create driver: ") + err.message);
        })
        .finally(function () { els.donSubmit.disabled = false; });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

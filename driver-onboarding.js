/*!
 * CJT Driver Onboarding — add/edit a driver profile (custom_objects.driver_profiles)
 * and, for a brand-new driver, automatically drop a new Opportunity into the
 * "Driver Onboarding" Pipeline. Hosted on GitHub next to dashboard.js/setup.js,
 * loaded the same way (jsDelivr).
 *
 * BEFORE THIS WORKS:
 *   1. On the Setup page, run "10. Driver Onboarding Setup" once (adds the
 *      rest of the fields below to the Drivers object — everything except
 *      the driver's own name field, which already exists).
 *   2. Create the "Driver Onboarding" Pipeline by hand in Settings ->
 *      Pipelines, with these exact stages, in order: Applied, Documents
 *      Submitted, Background Check, Approved, Active (plus a separate
 *      Rejected stage). This file can't create a Pipeline itself — only
 *      Custom Object schemas/fields are reachable through the API setup.js
 *      otherwise uses.
 *
 * ============================================================================
 * WHAT TO PASTE INTO THE "Driver Onboarding" GHL PAGE (Website/Funnel
 * builder -> Custom HTML/CSS/JS element). Use a Custom Menu Link to this
 * page's own GHL URL, set to "Embedded iframe" — same idea as the Setup
 * page, since this reads/writes live GHL data with the same token.
 *
 *   <div id="cjt-driver-onboarding-root"></div>
 *   <script>
 *     window.CJT_CONFIG = {
 *       locationId: "THEIR_GHL_LOCATION_ID",
 *       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
 *       onboardingPipelineName: "Driver Onboarding",
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
 * UNVERIFIED — same caveat as setup.js's own object/field *creation* calls:
 * nothing in this file has been run against a real token in this session.
 * Specifically unverified:
 *   - Field-key resolution for the driver's own name field. This file reads
 *     the live field list and matches it by name ("Driver Name"/"Driver's
 *     Name"/"Drivers Name"/bare "Name"), the same by-name idiom
 *     resolveFieldIds() uses for Opportunity fields elsewhere in this repo
 *     — but if that lookup finds nothing, it falls back to the literal key
 *     "driver_name", since that's the key dashboard.js/setup.js already
 *     assume everywhere else for this same object. Open the browser console
 *     after saving your first test driver and confirm the name actually
 *     shows up correctly in GHL before trusting this with a real driver.
 *   - Opportunity creation (createOnboardingOpportunity below) — written
 *     against GHL's documented POST /opportunities/ shape, but this repo
 *     has never created an Opportunity from code before (everything else
 *     only ever reads them). If your GHL account requires a linked Contact
 *     on every Opportunity, this call will fail with a clear error from
 *     GHL rather than silently creating something wrong — the driver
 *     record itself still saves fine either way, this step just reports
 *     the failure separately so you know to create that Opportunity by
 *     hand for that one driver.
 * Test this end-to-end on one throwaway test driver first, same as every
 * other live-GHL-write tool in this repo.
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
    onboardingPipelineName: "Driver Onboarding",
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
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/fields", { version: CONFIG.apiVersions.objects })
      .then(function (res) { return (res && (res.fields || res)) || []; });
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
        else keys[fieldKey] = null; // not created yet — run "10. Driver Onboarding Setup" on the Setup page
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
    '#cjt-driver-onboarding-root .donHint{font-size:11.5px;color:var(--don-text-dim);margin-top:3px;line-height:1.4}'
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
    ["donHeading", "donSub", "donForm", "donName", "donEmail", "donPhone", "donEmploymentType", "donOnboardingStatus",
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
        ? "Note: the Pay Statements generator (Setup page, section 9) only computes commission-based pay today — an hourly driver's rate is stored here for now, not yet paid out automatically."
        : "Used by the Pay Statements generator (Setup page, section 9): job value × this %, across that driver's own won Opportunities tagged with their name.";
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
      return;
    }

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

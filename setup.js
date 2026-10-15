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
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@main/setup.js"></script>
 *
 * IMPORTANT: use "@main" here, not "@latest". On jsDelivr, "@latest" for a
 * GitHub-sourced file resolves to the repo's latest git TAG (e.g. a GitHub
 * Release), not the newest commit — so the moment this repo publishes any
 * Release (for the browser-extension zips, say), "@latest" freezes
 * dashboard.js/setup.js at whatever commit existed at that tag, silently
 * serving stale code until another Release is cut. "@main" always tracks
 * the newest commit on the main branch directly and has none of this trap.
 *
 * Optional: extensionRepo/extensionAsset in CJT_CONFIG control the
 * "7. AAA Work Order Extractor" download button (section 7 below) —
 * defaults to this same GitHub repo's Releases if omitted, so most
 * clients never need to set these.
 *
 * After changing anything here, use "Generate dashboard snippet" at the
 * bottom of the Connection section and paste the updated block onto BOTH
 * the dashboard page and this Setup page — there is no shared backend, the
 * GHL page source *is* the config, on both pages independently.
 *
 * REMOVED (2026-10-13) — this used to also mirror every reconciled payment
 * into a separate "aaa_payments" Custom Object purely so the CJT Ops
 * Dashboard's AAA widgets could Sum/subtract fields GHL's own report
 * widgets can't touch (see aaa-diff-widget.js/aaa-diff-stat-tile.js). The
 * client deleted that Custom Object on purpose — AAA payment data belongs
 * on the Opportunity, full stop, not duplicated into a second object — so
 * this file no longer writes to it at all. writeOpportunityFields() below
 * (the real write, onto the matched Opportunity's own custom fields) is
 * now the ONLY write applyReconciliation() performs. The dashboard widgets
 * were updated the same day to read these same Opportunity fields directly
 * instead of the deleted object — see their own top-of-file comments.
 *
 * UNVERIFIED — confirm against a real token before relying on this in front
 * of a client (see README.md "What still needs testing"):
 *   - Custom field IDs below (work order / expected tow amount / AAA payment
 *     fields on the Opportunity) are copied from CJ Taylor Towing's real,
 *     already-live AAA-GHL-Extractor tool (import_aaa_payments.py /
 *     native-host main.go) — confirmed for THIS client, but a different
 *     client's GHL location will have different field IDs for the
 *     equivalent custom fields on their Opportunities, if they even have
 *     them. Re-derive these per client (LIST-GHL-FIELDS-style lookup) rather
 *     than reusing CJ Taylor Towing's IDs.
 *   - buildWoMap()/findOpportunityByWo() (2026-10-08) find each statement
 *     row's Opportunity via GET /opportunities/search?q=WO<number> instead
 *     of paging through every Opportunity in the pipeline (see their own
 *     comments for why — the old approach hit GHL's rate limit once the
 *     pipeline passed ~1,500 records). The "q searches name/contact info"
 *     behavior is confirmed against GHL's documented search parameters and
 *     the repo's own test suite (repo_test/test_setup.js), but NOT yet
 *     against a real GHL token with a large, real pipeline. Every match is
 *     still confirmed against the real Work Order Number field before
 *     being trusted (a bad/missing search match just shows up as NO MATCH,
 *     never a silently wrong write) — but run this against a small
 *     statement first, not a full batch, the first time it's used live.
 *   - findDuplicateWorkOrders() (2026-10-08) — "6. Find duplicate Work
 *     Orders" — is a NEW, read-only, full-pipeline scan added after a real
 *     duplicate was found live: the Towbook historical bulk import (run in
 *     GHL "Create" mode) created a brand-new Opportunity for a job the
 *     already-running AAA Work Order Extractor had separately created for
 *     the same Work Order Number, since the Towbook export's date range ran
 *     through "today". Exercised against the repo's own test suite
 *     (repo_test/test_setup.js) but NOT yet against the real, large CJ
 *     Taylor Towing pipeline — run it there and read the results carefully
 *     before treating "no duplicates found" as conclusive. Expect it to
 *     take a few minutes on a pipeline this size — it GETs every
 *     Opportunity individually, same cost profile as the old pre-2026-10-08
 *     buildWoMap().
 *   - ensureRateEngineSetup() / ensureObjectSchema() / ensureObjectField() /
 *     ensureOpportunityField() ("8. Rates & Services", 2026-10-15) — object/
 *     field *creation* calls, as opposed to the already-proven /objects/
 *     .../records read/write calls everything else in this file reuses.
 *     Written against GHL's documented Objects v3 shape, but never run
 *     against a real token in this session. Click "Set up rate engine"
 *     once against the real location and read what it reports (which
 *     objects/fields got created vs. already existed) before trusting the
 *     Rates & Services tables in front of a client — it's idempotent
 *     (checks before creating), so re-clicking it to retry after a failure
 *     is safe. afterHoursPct's actual effect on the total (a flat percent
 *     markup on the whole computed amount) is this file's own
 *     interpretation, not something ported from a working reference — see
 *     computeExpectedAmount's own comment.
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
    // Where the AAA Work Order Extractor browser-extension zip is published
    // as a GitHub Release asset — same repo this file is hosted in by
    // default, but overridable per deployment (e.g. a reseller's own
    // fork/org). See "7. Extension download" below and README.md
    // "Distributing the extension" for the release/asset naming convention
    // this points at.
    //
    // As of 2026-10-15 the extension talks to a shared cloud bridge
    // (Cloud Run) instead of a per-machine native-messaging host, so there
    // is no more installer, no OS-specific build, and no GHL token ever
    // touches the install — one zip works identically on Mac, Windows, and
    // Linux. Unversioned filename (same reasoning as the old Mac/Windows
    // assets): publish a new GitHub Release with a zip named exactly this,
    // and the download button here picks it up with no code change.
    extensionRepo: "jmdnoob/cjt-ops-dashboard",
    extensionAsset: "AAA-GHL-Extractor.zip",
    objectKeys: {
      drivers: "driver_profiles",
      fleet: "trucks",
      maintenance: "maintenance_records",
      training: "training_records",
      quarters: "driver_quarters",
      // No "aaa" key — AAA payment data lives on the Opportunity only, not
      // in a Custom Object (see the REMOVED note at the top of this file).
      //
      // Rate engine (2026-10-15) — see "8. Rates & Services" below. These
      // ARE reference/config data (like drivers/training above), not
      // per-job data, so Custom Objects are the right fit — the "no
      // duplicate object" rule only ever applied to AAA payment data living
      // redundantly on both an Opportunity and a mirror object.
      rateTables: "rate_tables",
      services: "services",
      businessAccounts: "business_accounts",
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
    // No fallback ID for this one, deliberately (2026-09-17). GHL doesn't
    // allow changing an existing field's type, so this field has now been
    // deleted and recreated three times in one day chasing the right type:
    // Monetary (original) -> GHL confirmed live it silently stores negative
    // values as positive -> Single Line/text (fixed the sign, but text
    // can't be summed by GHL's own report-widget math) -> Number (signed
    // AND summable, but any record reconciled before this field existed
    // kept its old corrupted sign-dropped value — GHL keys a record's
    // stored value to the field's *key*, which doesn't change on
    // recreation, so switching type never clears or fixes old values) ->
    // back to Single Line/text (current — summing in the dashboard was
    // judged less important than a guaranteed-correct sign). Each
    // recreation got a brand new ID, so pasting any one of them in here
    // would only go stale again next time. It relies entirely on the
    // by-name lookup above. If "Test connection" ever shows this one as
    // "not found," it means the field's name changed or the token lacks
    // the Custom Fields scope — not that this fallback needs updating.
    aaaPaymentDifference: [],
    // Read-only inputs to the rate-engine recompute (8. Rates & Services) —
    // never written by this file. No fallback IDs for any of these:
    // towMiles/flatbedRequired/dispatchSource already exist on CJ Taylor
    // Towing's location (the extractor created them) but this file has
    // never needed their IDs before now, so none were ever copied in;
    // serviceType/rateTableUsed are new fields "Set up rate engine" below
    // creates fresh, so there's no ID to fall back to until that's been run
    // once.
    towMiles: [],
    flatbedRequired: [],
    dispatchSource: [],
    serviceType: [],
    rateTableUsed: [],
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
    towMiles: ["tow miles"],
    flatbedRequired: ["flatbed required", "flatbed"],
    // dispatchSource is read-only here (never written) — it already exists
    // (AAA/Private) and doubles as the Business Account lookup key below,
    // so "Set up rate engine" does NOT create a separate "Business Account"
    // field; it just needs a Business Account record named exactly "AAA"
    // and one named exactly "Private" to match this field's two values.
    dispatchSource: ["dispatch source"],
    // The 2 fields "Set up rate engine" (8. Rates & Services) creates on
    // the Opportunity the first time it's run on a given location.
    serviceType: ["service type"],
    rateTableUsed: ["rate table used"],
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
  // GHL API client (identical to dashboard.js), with built-in rate-limit
  // pacing + 429 retry/backoff.
  //
  // GHL's documented limit (marketplace.gohighlevel.com/docs/other/rate-
  // limits) is a burst of 100 requests per rolling 10s window per location
  // (plus a 200,000/day cap). buildWoMap() below fires one GET per
  // Opportunity in the dispatch pipeline (required - see its own comment),
  // and once Towbook's historical jobs are imported that pipeline jumps to
  // 1,500+ records, which blew straight through the burst limit with no
  // pacing at all (confirmed live, 2026-10-08: "GHL API 429 /opportunities/
  // ...: Too Many Requests" partway through a statement-import Preview).
  //
  // Fix is two parts: (1) rateLimitGate() below paces outgoing requests to
  // a conservative 70/10s - under the documented 100/10s so there's
  // headroom left for another staff member's dashboard tab hitting the same
  // location at the same time: GHL's limit is per location, not per tab/
  // token; (2) any 429 that still gets through anyway (e.g. from that other
  // concurrent usage) is retried with exponential backoff (honoring a
  // Retry-After header if GHL sends one) instead of failing the whole
  // import/preview outright.
  // ---------------------------------------------------------------------
  var RATE_LIMIT_WINDOW_MS = 10000;
  var RATE_LIMIT_MAX_PER_WINDOW = 70;
  var requestTimestamps = [];

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Sliding-window gate: blocks (via a delayed retry) until there's room
  // under RATE_LIMIT_MAX_PER_WINDOW within the trailing RATE_LIMIT_WINDOW_MS,
  // then reserves a slot and lets the call through.
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
        return res.json();
      });
    }

    return attempt(0);
  }

  // ---------------------------------------------------------------------
  // 8. Rate engine (2026-10-15) — rate_tables + services + business_accounts
  // Custom Objects, modeled directly on HookOps' own rates module
  // (app/routes/rates.py, app/biz.py:compute_expected_amount) rather than
  // invented fresh: same 3-table shape (services / rate_tables / per-
  // service prices), same job-level "which rate table was current when
  // this was created" pinning so a later rate change never touches a job
  // already priced, same base+per-mile-beyond-included-miles+service-price
  // formula with a rounding rule and a minimum-fee floor.
  //
  // Two things are NOT copied from HookOps, because CJT doesn't need them
  // the way the reference app's multi-tenant version does:
  //   - HookOps keeps services/prices in a separate join table so one
  //     service can price differently across several *simultaneous* rate
  //     tables. CJT only ever has one current table at a time, so each
  //     service record just carries its own `price` directly — simpler,
  //     same result for a single-location business. If a second
  //     concurrent table is ever needed, promote price to its own
  //     per-table record then.
  //   - Flatbed: HookOps doesn't price this at all (flatbed there is a
  //     *truck* attribute, not a pricing input) — CJT's flatbedSurcharge
  //     field is new, not ported. Starts at $0 so it changes nothing until
  //     a real number is set.
  //
  // afterHoursPct is carried on rate_tables (matching HookOps' schema) but
  // HookOps' own compute_expected_amount never actually reads it — it's an
  // unused field there too. Applied here as a straight percentage markup
  // on the whole computed amount, which is this file's own interpretation
  // of what the field is for, not something proven against a working
  // reference — worth confirming before relying on it for real money, same
  // as any other judgment call a real contract detail should settle.
  //
  // UNVERIFIED, same caveat as everything else in this file's own header:
  // the object/field *creation* calls below (ensureObjectSchema,
  // ensureObjectField, ensureOpportunityField) have never been run against
  // a real token in this session — ensureRateEngineSetup() needs to be run
  // once against the real location and its result read carefully before
  // trusting it in front of a client. The *record* read/write calls
  // (listObjectRecords/createObjectRecord/updateObjectRecord) reuse the
  // exact same /objects/:schemaKey/records shape dashboard.js and
  // driver-onboarding.js already call live for driver_profiles/
  // training_records, so those are on solid ground.
  // ---------------------------------------------------------------------

  var RATE_ENGINE_DEFAULTS = {
    name: "Current",
    effectiveDate: null, // filled in with today's date when created
    isCurrent: true,
    baseFee: 85,
    perMileRate: 3,
    includedMiles: 0,
    minimumFee: 0,
    afterHoursPct: 0,
    flatbedSurcharge: 0,
    rounding: "ceiling", // ceiling | nearest | none
  };

  // base + per-mile beyond included miles (rounded per the table's
  // rounding rule) + the service's own price, floored to minimumFee if
  // under it, with flatbedSurcharge added when required and afterHoursPct
  // applied last as a markup on the whole total. Every argument after
  // towMiles/rateTableRow is optional — omit servicePrice/flatbedRequired/
  // isAfterHours for a plain base+mileage job, which reduces to exactly
  // today's $85 + $3/mi formula when rateTableRow is RATE_ENGINE_DEFAULTS.
  function computeExpectedAmount(towMiles, rateTableRow, servicePrice, flatbedRequired, isAfterHours) {
    var rt = rateTableRow || RATE_ENGINE_DEFAULTS;
    var included = parseFloat(rt.includedMiles) || 0;
    var perMile = parseFloat(rt.perMileRate) || 0;
    var base = parseFloat(rt.baseFee) || 0;
    var minimum = parseFloat(rt.minimumFee) || 0;
    var afterHoursPct = parseFloat(rt.afterHoursPct) || 0;
    var flatbedSurcharge = parseFloat(rt.flatbedSurcharge) || 0;
    var billableMiles = Math.max(0, (parseFloat(towMiles) || 0) - included);
    if (rt.rounding === "nearest") billableMiles = Math.round(billableMiles);
    else if (rt.rounding !== "none") billableMiles = Math.ceil(billableMiles); // default: ceiling
    var amount = base + billableMiles * perMile + (parseFloat(servicePrice) || 0);
    if (flatbedRequired) amount += flatbedSurcharge;
    if (isAfterHours && afterHoursPct) amount = amount * (1 + afterHoursPct / 100);
    if (minimum && amount < minimum) amount = minimum;
    return Math.round(amount * 100) / 100;
  }

  // GHL's REST API needs a custom object's schemaKey fully qualified as
  // "custom_objects.<key>" in record-level URLs (confirmed 2026-09-17, see
  // dashboard.js's objectSchemaKey() for the original finding) — repeated
  // here rather than shared since these two files don't share any module
  // system (each is one standalone <script> tag, by design — see README).
  function objectSchemaKey(shortKey) {
    return "custom_objects." + shortKey;
  }

  // Paginates POST /objects/:schemaKey/records/search using searchAfter —
  // identical shape to dashboard.js's loadAllObjectRecords(), copied rather
  // than imported for the same no-shared-module reason as objectSchemaKey
  // above.
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

  function updateObjectRecord(shortKey, recordId, properties) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/records/" + recordId, {
      method: "PUT",
      version: CONFIG.apiVersions.objects,
      body: { properties: properties },
    });
  }

  // Creates the Custom Object schema itself (the "table") if a GET on its
  // key 404s, leaves it alone if it already exists. UNVERIFIED — see this
  // section's top-of-block comment.
  function ensureObjectSchema(shortKey, labels) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey), { version: CONFIG.apiVersions.objects })
      .then(function () { return { created: false }; })
      .catch(function (err) {
        // Only a 404 ("doesn't exist yet") should fall through to create —
        // anything else (a 401/403 from a bad/under-scoped token, a 429, a
        // transient network error) must surface as a real failure instead
        // of being silently reinterpreted as "missing" and retried as a
        // create, which would either mask the real problem or attempt a
        // duplicate create against an object that does exist but errored
        // for some other reason.
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

  // Adds one field to a Custom Object schema if a field with this name
  // doesn't already exist on it. dataType is one of GHL's custom-object
  // field types: TEXT | LARGE_TEXT | NUMERICAL | MONETORY | CHECKBOX |
  // SINGLE_OPTIONS | DATE. UNVERIFIED — see this section's top-of-block
  // comment.
  function ensureObjectField(shortKey, fieldDef) {
    return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/fields", { version: CONFIG.apiVersions.objects })
      .then(function (res) {
        var existing = (res && (res.fields || res)) || [];
        var already = existing.some(function (f) { return String(f.name || "").trim().toLowerCase() === fieldDef.name.trim().toLowerCase(); });
        if (already) return { created: false };
        return ghlApi("/objects/" + objectSchemaKey(shortKey) + "/fields", {
          method: "POST",
          version: CONFIG.apiVersions.objects,
          body: Object.assign({ locationId: CONFIG.locationId }, fieldDef),
        }).then(function () { return { created: true }; });
      });
  }

  // Adds one field to the Opportunity model itself (a different endpoint
  // than custom-object fields above — this is the same
  // /locations/:id/customFields endpoint resolveFieldIds() already reads
  // from, just with method: POST instead of GET). UNVERIFIED.
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
  // before creating). Builds, in order: the 3 Custom Object schemas, their
  // fields, the 2 new Opportunity fields, then seeds exactly one "Current"
  // rate table (today's live $85/$3 numbers, so nothing changes for CJT)
  // plus two Business Account records named "AAA" and "Private" (matching
  // the existing Dispatch Source field's two values) both pointing at it —
  // only on the very first run (skipped if any rate_tables record already
  // exists, so re-running this later never re-seeds over real data).
  function ensureRateEngineSetup(onStep) {
    function step(label, fn) {
      if (onStep) onStep(label);
      return fn();
    }
    return step("Rate tables object", function () {
      return ensureObjectSchema(CONFIG.objectKeys.rateTables, { singular: "Rate Table", plural: "Rate Tables" });
    })
      .then(function () {
        return Promise.all([
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Effective Date", dataType: "DATE" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Is Current", dataType: "CHECKBOX" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Base Fee", dataType: "MONETORY" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Per Mile Rate", dataType: "MONETORY" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Included Miles", dataType: "NUMERICAL" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Minimum Fee", dataType: "MONETORY" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "After Hours Pct", dataType: "NUMERICAL" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, { name: "Flatbed Surcharge", dataType: "MONETORY" }),
          ensureObjectField(CONFIG.objectKeys.rateTables, {
            name: "Rounding", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["ceiling", "nearest", "none"],
          }),
        ]);
      })
      .then(function () {
        return step("Services object", function () {
          return ensureObjectSchema(CONFIG.objectKeys.services, { singular: "Service", plural: "Services" });
        });
      })
      .then(function () {
        return Promise.all([
          ensureObjectField(CONFIG.objectKeys.services, { name: "Category", dataType: "TEXT" }),
          ensureObjectField(CONFIG.objectKeys.services, {
            name: "Unit", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["flat", "per_mile", "per_hour", "per_day", "per_unit"],
          }),
          ensureObjectField(CONFIG.objectKeys.services, { name: "Active", dataType: "CHECKBOX" }),
          ensureObjectField(CONFIG.objectKeys.services, { name: "Price", dataType: "MONETORY" }),
        ]);
      })
      .then(function () {
        return step("Business accounts object", function () {
          return ensureObjectSchema(CONFIG.objectKeys.businessAccounts, { singular: "Business Account", plural: "Business Accounts" });
        });
      })
      .then(function () {
        return Promise.all([
          ensureObjectField(CONFIG.objectKeys.businessAccounts, {
            name: "Type", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["motor_club", "commercial", "property_manager", "dealership", "individual"],
          }),
          ensureObjectField(CONFIG.objectKeys.businessAccounts, { name: "Default Rate Table", dataType: "TEXT" }),
          ensureObjectField(CONFIG.objectKeys.businessAccounts, { name: "Billing Contact", dataType: "TEXT" }),
          ensureObjectField(CONFIG.objectKeys.businessAccounts, { name: "Payment Terms", dataType: "TEXT" }),
          ensureObjectField(CONFIG.objectKeys.businessAccounts, { name: "Notes", dataType: "LARGE_TEXT" }),
        ]);
      })
      .then(function () {
        return step("Opportunity fields (Service Type, Rate Table Used)", function () {
          return Promise.all([
            ensureOpportunityField({ name: "Service Type", dataType: "SINGLE_OPTIONS", picklistOptions: [] }),
            ensureOpportunityField({ name: "Rate Table Used", dataType: "TEXT" }),
          ]);
        });
      })
      .then(function () {
        return step("Seed default rate table + accounts (first run only)", function () {
          return listObjectRecords(CONFIG.objectKeys.rateTables).then(function (existingTables) {
            if (existingTables.length > 0) return { seeded: false };
            var today = new Date().toISOString().slice(0, 10);
            return createObjectRecord(CONFIG.objectKeys.rateTables, {
              name: RATE_ENGINE_DEFAULTS.name,
              effective_date: today,
              is_current: true,
              base_fee: RATE_ENGINE_DEFAULTS.baseFee,
              per_mile_rate: RATE_ENGINE_DEFAULTS.perMileRate,
              included_miles: RATE_ENGINE_DEFAULTS.includedMiles,
              minimum_fee: RATE_ENGINE_DEFAULTS.minimumFee,
              after_hours_pct: RATE_ENGINE_DEFAULTS.afterHoursPct,
              flatbed_surcharge: RATE_ENGINE_DEFAULTS.flatbedSurcharge,
              rounding: RATE_ENGINE_DEFAULTS.rounding,
            }).then(function () {
              return Promise.all([
                createObjectRecord(CONFIG.objectKeys.businessAccounts, { name: "AAA", type: "motor_club", default_rate_table: RATE_ENGINE_DEFAULTS.name }),
                createObjectRecord(CONFIG.objectKeys.businessAccounts, { name: "Private", type: "individual", default_rate_table: RATE_ENGINE_DEFAULTS.name }),
              ]);
            }).then(function () { return { seeded: true }; });
          });
        });
      });
  }

  // GHL's REST API needs a custom object's schemaKey fully qualified as
  // "custom_objects.<key>" in the URL path (confirmed 2026-09-17 against a
  // real location's GET /objects/ listing — a bare key like "aaa_payments"
  // is rejected with 400 "Invalid Key Passed"). CONFIG.objectKeys stays as
  // the short/bare form since it's also usable elsewhere in its short form;
  // this prefix is applied only at the point an actual REST call is made.
  function objectSchemaKey(shortKey) {
    return "custom_objects." + shortKey;
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

  // GET /opportunities/:id normally uses a single `fieldValue` key, but
  // GHL is inconsistent about this across endpoints (confirmed on
  // /opportunities/search, which uses type-specific keys instead —
  // fieldValueString/fieldValueNumber/fieldValueDate/fieldValueArray). Check
  // every key defensively so this keeps working if that inconsistency ever
  // shows up here too.
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

  // Finds the single Opportunity matching one Work Order Number by
  // searching GHL for "WO<number>" as text — every Opportunity this system
  // creates embeds "WO<number>" in its Name (see buildOpportunityName() in
  // the AAA extractor's native host, and the Towbook historical import's
  // own Opportunity Name column) — instead of paging through the whole
  // pipeline. Search's own customFields payload isn't reliably complete
  // (confirmed, see import_aaa_payments.py's docstring) and a name-text
  // match alone could coincidentally substring-match a longer/shorter WO
  // number, so every candidate is still confirmed with a real GET against
  // its actual Work Order Number field before being trusted. Returns null
  // if nothing confirms; throws if more than one Opportunity genuinely
  // carries this same Work Order Number (a real data problem — e.g. a
  // reused AAA PO — not something to silently pick a winner on).
  function findOpportunityByWo(pipelineId, woFieldIds, paymentIdFieldIds, expectedFieldIds, wo) {
    var url = "/opportunities/search?" + qs({
      location_id: CONFIG.locationId,
      pipeline_id: pipelineId,
      status: "all",
      q: "WO" + wo,
      limit: 20,
    });
    return ghlApi(url, { version: CONFIG.apiVersions.opportunities }).then(function (res) {
      var candidates = res.opportunities || [];
      if (candidates.length === 0) return null;
      return mapWithConcurrency(candidates, 4, function (c) { return getOpportunity(c.id); }).then(function (fullCandidates) {
        var exact = fullCandidates.filter(function (full) {
          if (!full) return false;
          var v = getCustomField(full, woFieldIds);
          return v && String(v).trim() === wo;
        });
        if (exact.length === 0) return null;
        if (exact.length > 1) {
          throw new Error(
            'Work Order Number "' + wo + '" matches ' + exact.length + ' different Opportunities (' +
            exact.map(function (e) { return e.id; }).join(", ") +
            ") — this needs to be fixed in GHL (e.g. a reused AAA PO number) before importing."
          );
        }
        var full = exact[0];
        return {
          id: full.id,
          name: full.name,
          existingPaymentId: getCustomField(full, paymentIdFieldIds),
          expectedTowAmount: parseMoney(getCustomField(full, expectedFieldIds)),
        };
      });
    });
  }

  // Builds { workOrderNumber -> { id, name, existingPaymentId,
  // expectedTowAmount } } for ONLY the Work Order Numbers present in `rows`
  // — not every Opportunity in the pipeline. This originally fetched and
  // individually GET-ed every Opportunity in the dispatch pipeline (the
  // only way to reliably read Work Order Number — see findOpportunityByWo's
  // comment), which worked fine at a few hundred Opportunities but hit
  // GHL's rate limit outright once the Towbook backfill pushed the pipeline
  // past 1,500 records (confirmed live, 2026-10-08), and would only get
  // slower every month after that as more jobs pile up. Searching per WO
  // number instead keeps the cost proportional to the size of each
  // statement being imported, not the pipeline's ever-growing total size.
  //
  // Caveat worth knowing: this only finds Opportunities whose Name actually
  // contains "WO<number>". Every Opportunity this system has ever created
  // does, but a one-off Opportunity created by hand with a different name
  // would show up as NO MATCH here even with the right Work Order Number
  // field set — reported the same as any other non-match below, never
  // silently dropped.
  function buildWoMap(rows, onProgress) {
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

      var uniqueWos = [];
      var seen = {};
      rows.forEach(function (row) {
        var wo = pickCol(row, "wo");
        if (wo && !seen[wo]) { seen[wo] = true; uniqueWos.push(wo); }
      });

      return mapWithConcurrency(
        uniqueWos,
        4,
        function (wo) { return findOpportunityByWo(pipeline.id, woFieldIds, paymentIdFieldIds, expectedFieldIds, wo); },
        onProgress
      ).then(function (results) {
        var woMap = {};
        uniqueWos.forEach(function (wo, i) {
          if (results[i]) woMap[wo] = results[i];
        });
        return { woMap: woMap, pipelineName: pipeline.name, matchedCount: Object.keys(woMap).length, searchedCount: uniqueWos.length };
      });
    });
  }

  // Read-only diagnostic (2026-10-08): scans EVERY Opportunity in the
  // dispatch pipeline — unlike buildWoMap() above, which only looks up the
  // specific Work Order Numbers present in one statement — and groups them
  // by their real Work Order Number field, so any WO number held by more
  // than one Opportunity shows up. Added after a real duplicate was found
  // live (two Opportunities both named "WO68157261", one created by the
  // Towbook historical bulk import and one by the already-running AAA Work
  // Order Extractor for the same job) — the Towbook import ran in "Create"
  // mode with no awareness of what the extractor had already created for
  // Work Order Numbers inside the same date range. This never writes
  // anything; it only reports what it finds so the duplicates can be
  // reviewed and cleaned up by hand in GHL.
  //
  // Reuses the same rate-limit-safe primitives as the old full-pipeline
  // buildWoMap() (loadAllOpportunities + per-Opportunity GET via
  // mapWithConcurrency) — correct but slow on a large pipeline (seconds per
  // ~25-30 Opportunities at the 70-req/10s pacing in ghlApi, so a few
  // minutes once the dispatch pipeline is in the thousands) — which is fine
  // for an occasional manual scan, just don't expect it to be instant.
  function findDuplicateWorkOrders(onProgress) {
    return resolveFieldIds().then(function () {
      return loadPipelines();
    }).then(function (pipelines) {
      var pipeline = pipelines.filter(function (p) {
        return (p.name || "").toLowerCase() === CONFIG.dispatchPipelineName.toLowerCase();
      })[0];
      if (!pipeline) throw new Error('No pipeline named "' + CONFIG.dispatchPipelineName + '" found in this GHL location.');
      var woFieldIds = fieldIdsFor("workOrderNumber");
      var paymentIdFieldIds = fieldIdsFor("aaaPaymentId");

      return loadAllOpportunities(pipeline.id).then(function (list) {
        return mapWithConcurrency(list, 4, function (o) { return getOpportunity(o.id); }, onProgress).then(function (fullOpps) {
          var groups = {};
          var withWoCount = 0;
          fullOpps.forEach(function (full) {
            if (!full) return;
            var wo = getCustomField(full, woFieldIds);
            wo = wo ? String(wo).trim() : "";
            if (!wo) return;
            withWoCount += 1;
            if (!groups[wo]) groups[wo] = [];
            groups[wo].push({
              id: full.id,
              name: full.name,
              updatedAt: full.updatedAt || full.dateUpdated || full.createdAt || null,
              hasPaymentId: !!getCustomField(full, paymentIdFieldIds),
              status: full.status || null,
            });
          });
          var duplicateGroups = Object.keys(groups)
            .filter(function (wo) { return groups[wo].length > 1; })
            .sort()
            .map(function (wo) { return { wo: wo, opportunities: groups[wo] }; });
          return {
            pipelineName: pipeline.name,
            totalOpportunities: list.length,
            withWoCount: withWoCount,
            duplicateGroups: duplicateGroups,
          };
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
  // Write step — mirrors import_aaa_payments.py's --apply path: PUT onto
  // the matched Opportunity's own custom fields. That's the only write this
  // does now (see the REMOVED note at the top of this file for why there
  // used to be a second write into an "aaa_payments" Custom Object too).
  // ---------------------------------------------------------------------
  function writeOpportunityFields(item) {
    var customFields = [];
    if (item.paymentId && fieldId("aaaPaymentId")) customFields.push({ id: fieldId("aaaPaymentId"), fieldValue: item.paymentId });
    if (item.grossAmount !== null && fieldId("aaaGrossPaid")) customFields.push({ id: fieldId("aaaGrossPaid"), fieldValue: String(item.grossAmount) });
    if (item.payDate && fieldId("aaaPayDate")) customFields.push({ id: fieldId("aaaPayDate"), fieldValue: item.payDate });
    if (item.towMileage && fieldId("aaaPaidTowMiles")) customFields.push({ id: fieldId("aaaPaidTowMiles"), fieldValue: item.towMileage });
    // AAA Payment Difference is a Single Line/text field (2026-09-17,
    // reverted back from a brief stint as Number-type — Number could be
    // summed by dashboard report widgets, but the priority is seeing and
    // exporting a correct positive/negative value, so it's text again).
    // Sent as a formatted string, like the Monetary fields above, so the
    // negative sign is preserved exactly (a genuinely Number/MONETARY-typed
    // GHL field silently drops negative signs on write — confirmed live).
    // toFixed(2) avoids floating-point noise from the grossAmount - expected
    // subtraction (e.g. 19.999999999998) and keeps the export looking like
    // a normal dollar amount (e.g. "-19.00").
    if (item.diff !== null && fieldId("aaaPaymentDifference")) customFields.push({ id: fieldId("aaaPaymentDifference"), fieldValue: item.diff.toFixed(2) });
    if (customFields.length === 0) return Promise.resolve({ skipped: true });
    return ghlApi("/opportunities/" + item.opp.id, {
      method: "PUT",
      version: CONFIG.apiVersions.opportunities,
      body: { customFields: customFields },
    });
  }

  // Applies a reconcile() result to GHL. Writes matched/exception rows onto
  // their matched Opportunity's own custom fields (writeOpportunityFields
  // above) — the only write this performs now. No-match rows have no
  // Opportunity to write to and, since 2026-10-13, nowhere else to go
  // either (the aaa_payments Custom Object they used to be mirrored into is
  // gone on purpose — see the REMOVED note at the top of this file), so
  // they're reported in the Preview summary (renderSummary()'s "No match"
  // tile) but never turned into a task here; skips noWo and
  // alreadyReconciled entirely too, same as the Python tool.
  function applyReconciliation(reconciled, onProgress) {
    var tasks = [];
    reconciled.toWrite.forEach(function (item) {
      tasks.push(function () {
        return writeOpportunityFields(item);
      });
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

  // AAA's own "Pay Statements" export is a Salesforce report, which ships
  // several title/filter-criteria rows before the real header row (e.g.
  // "Pay Statements", "As of <date>... Generated by...", "Filtered By",
  // "Status equals Payment Processed", ...) — confirmed live, 2026-10-08:
  // assuming row 1 is always the header (the old behavior here) silently
  // treated one of those junk rows as the header instead, so not a single
  // real column (Work Order Number, Payment ID, etc.) ever matched and
  // every row fell into "NO WO #" with zero rows actually reconciled.
  //
  // Scans the first few rows of raw cell data (array-of-arrays — row index
  // must stay aligned with the real sheet/line position, so callers must
  // NOT pre-filter blank rows before calling this) for the one that
  // actually looks like statement headers — matches at least 2 of our
  // known column names (COLUMN_ALIASES, case/whitespace-insensitive) —
  // instead of assuming row 0. Falls back to row 0 (the original behavior)
  // if nothing scores, so an already-clean CSV/statement with no report
  // chrome above its header row (true for row 0 itself, which already
  // matches >=2 aliases) is completely unaffected.
  function findStatementHeaderRowIndex(rowsOfCells) {
    var allAliases = [];
    Object.keys(COLUMN_ALIASES).forEach(function (k) {
      allAliases = allAliases.concat(COLUMN_ALIASES[k]);
    });
    var scanLimit = Math.min(rowsOfCells.length, 30);
    for (var r = 0; r < scanLimit; r++) {
      var cells = (rowsOfCells[r] || []).map(function (c) { return normalizeHeader(c); });
      var hits = 0;
      allAliases.forEach(function (alias) {
        if (cells.indexOf(alias) !== -1) hits += 1;
      });
      if (hits >= 2) return r;
    }
    return 0;
  }

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
    // Trim fully-blank trailing/leading lines, but keep every other row's
    // position intact — findStatementHeaderRowIndex needs real row indices,
    // not a pre-filtered list, to find the header wherever it actually is.
    while (rows.length && rows[0].length === 1 && rows[0][0] === "") rows.shift();
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
    if (rows.length === 0) return [];
    var headerIdx = findStatementHeaderRowIndex(rows);
    var headers = rows[headerIdx];
    return rows.slice(headerIdx + 1).map(function (r) {
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
      return obj;
    }).filter(function (obj) {
      return Object.keys(obj).some(function (k) { return String(obj[k]).trim() !== ""; });
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
      // header: 1 → raw array-of-arrays, one entry per actual sheet row, so
      // row indices line up with the real sheet (needed by
      // findStatementHeaderRowIndex — see its own comment for why row 0
      // can't just be assumed to be the header).
      var raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      var headerIdx = findStatementHeaderRowIndex(raw);
      // range as a bare number = "start at this 0-indexed row" (SheetJS),
      // which both treats that row as the header and skips everything
      // above it.
      return XLSX.utils.sheet_to_json(sheet, { defval: "", range: headerIdx }).filter(function (obj) {
        return Object.keys(obj).some(function (k) { return String(obj[k]).trim() !== ""; });
      });
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
    findDuplicateWorkOrders: findDuplicateWorkOrders,
    reconcile: reconcile,
    applyReconciliation: applyReconciliation,
    sha256Hex: sha256Hex,
    loadPipelines: loadPipelines,
    resolveFieldIds: resolveFieldIds,
    FIELD_NAME_CANDIDATES: FIELD_NAME_CANDIDATES,
    computeExpectedAmount: computeExpectedAmount,
    RATE_ENGINE_DEFAULTS: RATE_ENGINE_DEFAULTS,
    ensureRateEngineSetup: ensureRateEngineSetup,
    listObjectRecords: listObjectRecords,
    createObjectRecord: createObjectRecord,
    updateObjectRecord: updateObjectRecord,
  };

  // ---------------------------------------------------------------------
  // UI layer — CSS + markup ship inline in this one file, same reasoning
  // as dashboard.js: one file on GitHub, one script tag in GHL.
  // ---------------------------------------------------------------------
  var CSS_TEXT = [
    ':root{--bg:#f5f6f8;--panel:#fff;--border:#e4e4e9;--text:#19191c;--text-dim:#6b7280;--accent:#19191c;--accent-soft:#fff6de;--accent-strong:#000000;--good:#15803d;--good-soft:#e1f4e8;--warn:#b45309;--warn-soft:#fbeed9;--crit:#dc2626;--crit-soft:#fbe4e2;--info:#2563eb;--info-soft:#dbeafe;--chip-bg:#eef1f5;--shadow:0 1px 2px rgba(25,25,28,.05),0 2px 10px rgba(25,25,28,.06)}',
    '#cjt-setup-root *{box-sizing:border-box}',
    '#cjt-setup-root{background:var(--bg);color:var(--text);font-family:"Roboto",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px 16px 60px;position:relative}',
    '#cjt-setup-root .mono{font-family:"Roboto",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}',
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
    '#cjt-setup-root textarea{resize:vertical;font-family:"Roboto",monospace;font-size:12px}',
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
    '#cjt-setup-root .summaryTile .n{font-family:"Roboto",monospace;font-size:20px;font-weight:700}',
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
    '#cjt-setup-root .cjtLockOverlay{position:fixed;inset:0;background:rgba(25,25,28,.6);display:none;align-items:center;justify-content:center;z-index:999999;padding:16px}',
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

    '<div class="card" id="cardDupes"><h2>6. Find duplicate Work Orders</h2>' +
    '<div class="cardDesc">Scans every Opportunity in the dispatch pipeline and groups them by their real Work Order Number field, so any WO number held by more than one Opportunity card shows up — e.g. one created by the Towbook historical import and a separate one created independently by the live AAA Work Order Extractor for the same job. Read-only: this only looks, it never writes or deletes anything in GHL. A full scan reads every Opportunity individually, so it can take a few minutes on a large pipeline.</div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnScanDupes">Scan for duplicates</button></div>' +
    '<div class="progressWrap" id="dupeProgress"><div class="progressBar"><div id="dupeProgressBar"></div></div><div class="progressLabel" id="dupeProgressLabel"></div></div>' +
    '<div class="statusMsg" id="dupeStatus"></div>' +
    '<div id="dupeResultsWrap"></div>' +
    '</div>' +

    '<div class="card" id="cardExtension"><h2>7. AAA Work Order Extractor (browser extension)</h2>' +
    '<div class="cardDesc">The dispatcher-side companion tool: it reads an AAA work order page and can sync it straight into this pipeline. No GHL token or setup ever lives on the dispatcher\'s computer — the extension just talks to a shared cloud bridge. Install is one download, no installer to run: unzip it and load it in Chrome.</div>' +
    '<div id="extDownloadWrap"></div>' +
    '</div>' +

    '<div class="card" id="cardRates"><h2>8. Rates &amp; Services</h2>' +
    '<div class="cardDesc">What a job costs, in one place instead of scattered across GHL screens: a catalog of services (what kind of job), rate tables (base fee, per-mile rate, minimum, flatbed surcharge — a job keeps whatever table was current when it was created, so changing a rate here never touches a past job), and business accounts (AAA vs. Private today — each can default to its own rate table).</div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnSetupRateEngine">Set up rate engine</button><button type="button" class="btn" id="btnLoadRates">Reload</button></div>' +
    '<div class="statusMsg" id="rateSetupStatus"></div>' +

    '<div style="margin-top:20px;"><h3 style="font-size:13.5px;margin:0 0 4px;">Services</h3>' +
    '<div class="hint" style="margin-bottom:10px;">What kind of job this is — each can carry its own price, added on top of the base fee/mileage below.</div>' +
    '<div id="servicesTableWrap"></div>' +
    '<div class="fieldRow" style="margin-top:12px;">' +
    '<div class="field"><label>Name</label><input type="text" id="fSvcName" placeholder="e.g. Winch Out"></div>' +
    '<div class="field"><label>Category</label><input type="text" id="fSvcCategory" placeholder="towing" value="towing"></div>' +
    '</div>' +
    '<div class="fieldRow">' +
    '<div class="field"><label>Unit</label><select id="fSvcUnit"><option value="flat">flat</option><option value="per_mile">per_mile</option><option value="per_hour">per_hour</option><option value="per_day">per_day</option><option value="per_unit">per_unit</option></select></div>' +
    '<div class="field"><label>Price ($)</label><input type="number" step="0.01" id="fSvcPrice" value="0"></div>' +
    '</div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnSaveService">Add service</button><button type="button" class="btn" id="btnCancelSvcEdit" style="display:none;">Cancel edit</button></div>' +
    '<div class="statusMsg" id="svcStatus"></div>' +
    '</div>' +

    '<div style="margin-top:28px;"><h3 style="font-size:13.5px;margin:0 0 4px;">Rate Tables</h3>' +
    '<div class="hint" style="margin-bottom:10px;">Only one table is "current" at a time — that\'s the one new jobs get priced against. Changing numbers on a historical (non-current) table never affects anything.</div>' +
    '<div id="ratesTableWrap"></div>' +
    '<div class="fieldRow" style="margin-top:12px;">' +
    '<div class="field"><label>Name</label><input type="text" id="fRtName" placeholder="e.g. 2027 Contract"></div>' +
    '<div class="field"><label>Rounding</label><select id="fRtRounding"><option value="ceiling">ceiling</option><option value="nearest">nearest</option><option value="none">none</option></select></div>' +
    '</div>' +
    '<div class="fieldRow">' +
    '<div class="field"><label>Base Fee ($)</label><input type="number" step="0.01" id="fRtBase" value="85"></div>' +
    '<div class="field"><label>Per-Mile Rate ($)</label><input type="number" step="0.01" id="fRtPerMile" value="3"></div>' +
    '</div>' +
    '<div class="fieldRow">' +
    '<div class="field"><label>Included Miles (free)</label><input type="number" step="0.1" id="fRtIncluded" value="0"></div>' +
    '<div class="field"><label>Minimum Fee ($)</label><input type="number" step="0.01" id="fRtMin" value="0"></div>' +
    '</div>' +
    '<div class="fieldRow">' +
    '<div class="field"><label>After-Hours Markup (%)</label><input type="number" step="0.1" id="fRtAfterHours" value="0"></div>' +
    '<div class="field"><label>Flatbed Surcharge ($)</label><input type="number" step="0.01" id="fRtFlatbed" value="0"></div>' +
    '</div>' +
    '<div class="field"><label><input type="checkbox" id="fRtIsCurrent" style="width:auto;margin-right:6px;">Make this the current table</label></div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnSaveRateTable">Add rate table</button><button type="button" class="btn" id="btnCancelRtEdit" style="display:none;">Cancel edit</button></div>' +
    '<div class="statusMsg" id="rtStatus"></div>' +
    '</div>' +

    '<div style="margin-top:28px;"><h3 style="font-size:13.5px;margin:0 0 4px;">Business Accounts</h3>' +
    '<div class="hint" style="margin-bottom:10px;">Matches the existing Dispatch Source field (AAA / Private) by name — add one here with that exact name to give it its own default rate table.</div>' +
    '<div id="acctsTableWrap"></div>' +
    '<div class="fieldRow" style="margin-top:12px;">' +
    '<div class="field"><label>Name</label><input type="text" id="fAcctName" placeholder="e.g. AAA (must match Dispatch Source)"></div>' +
    '<div class="field"><label>Type</label><select id="fAcctType"><option value="motor_club">motor_club</option><option value="commercial">commercial</option><option value="property_manager">property_manager</option><option value="dealership">dealership</option><option value="individual">individual</option></select></div>' +
    '</div>' +
    '<div class="field"><label>Default Rate Table</label><select id="fAcctRateTable"></select></div>' +
    '<div class="btnRow"><button type="button" class="btn primary" id="btnSaveAcct">Add business account</button><button type="button" class="btn" id="btnCancelAcctEdit" style="display:none;">Cancel edit</button></div>' +
    '<div class="statusMsg" id="acctStatus"></div>' +
    '</div>' +
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
    fontLink.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;900&display=swap";
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
     "btnScanDupes", "dupeProgress", "dupeProgressBar", "dupeProgressLabel", "dupeStatus", "dupeResultsWrap",
     "extDownloadWrap",
     "btnSetupRateEngine", "btnLoadRates", "rateSetupStatus",
     "servicesTableWrap", "fSvcName", "fSvcCategory", "fSvcUnit", "fSvcPrice", "btnSaveService", "btnCancelSvcEdit", "svcStatus",
     "ratesTableWrap", "fRtName", "fRtRounding", "fRtBase", "fRtPerMile", "fRtIncluded", "fRtMin", "fRtAfterHours", "fRtFlatbed", "fRtIsCurrent", "btnSaveRateTable", "btnCancelRtEdit", "rtStatus",
     "acctsTableWrap", "fAcctName", "fAcctType", "fAcctRateTable", "btnSaveAcct", "btnCancelAcctEdit", "acctStatus"
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
            '<script src="https://cdn.jsdelivr.net/gh/' + (CONFIG.extensionRepo || "jmdnoob/cjt-ops-dashboard") + '@main/dashboard.js"><\/script>\n\n' +
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

      // "No match" rows have nowhere to be written since the aaa_payments
      // Custom Object was removed (2026-10-13) — they're shown above for
      // visibility only, never counted as writable here.
      var writable = reconciled.toWrite.length;
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
          setImportProgress(true, 0, 1, "Looking up work orders in GHL…");
          return buildWoMap(rows, function (done, total) {
            setImportProgress(true, done, total, "Looking up work orders in GHL… " + done + " / " + total);
          }).then(function (info) {
            lastWoMapInfo = info;
            var reconciled = reconcile(rows, info.woMap);
            lastReconciled = reconciled;
            setImportProgress(false, 0, 0, "");
            showStatus(els.importStatus, "info", "Checked " + rows.length + " row(s) — matched " + info.matchedCount + " of " + info.searchedCount + " distinct Work Order Number(s) in “" + info.pipelineName + "”. Nothing written yet — review below.");
            renderSummary(reconciled);
          });
        })
        .catch(function (err) {
          setImportProgress(false, 0, 0, "");
          showStatus(els.importStatus, "err", err.message);
        })
        .finally(function () { els.btnPreview.disabled = false; });
    });

    // ---- 6. Find duplicate Work Orders (read-only) ----
    var lastDupeResult = null;

    function setDupeProgress(shown, done, total, label) {
      els.dupeProgress.className = "progressWrap" + (shown ? " show" : "");
      if (total) els.dupeProgressBar.style.width = Math.round((done / total) * 100) + "%";
      els.dupeProgressLabel.textContent = label || (total ? done + " / " + total : "");
    }

    function renderDupeResults(result) {
      if (!result.duplicateGroups.length) {
        els.dupeResultsWrap.innerHTML = "";
        return;
      }
      var body = result.duplicateGroups.map(function (g) {
        return g.opportunities.map(function (o) {
          return "<tr><td>" + esc(g.wo) + "</td><td>" + esc(o.name || "—") + "</td>" +
            "<td class=\"mono\">" + esc(o.id) + "</td>" +
            "<td>" + (o.updatedAt ? esc(String(o.updatedAt)) : "—") + "</td>" +
            "<td>" + (o.hasPaymentId ? "Yes" : "No") + "</td></tr>";
        }).join("");
      }).join("");
      els.dupeResultsWrap.innerHTML =
        '<div class="tableWrap"><table><thead><tr><th>Work Order</th><th>Opportunity Name</th><th>Opportunity ID</th><th>Last Updated</th><th>Has AAA Payment ID?</th></tr></thead><tbody>' +
        body + "</tbody></table></div>" +
        '<div class="hint" style="margin-top:8px;">Each row is a separate Opportunity card in GHL for the same Work Order Number. For each one: open both cards in GHL (search the Work Order Number), decide which to keep — usually whichever one already has an AAA Payment ID, or has more fields filled in (Assigned Driver, Destination Address) — then move anything useful from the other onto it and delete the other by hand in GHL. This scan only finds and lists them; it never deletes or merges anything itself.</div>';
    }

    els.btnScanDupes.addEventListener("click", function () {
      Object.assign(CONFIG, liveConfigFromForm());
      if (!CONFIG.locationId || !CONFIG.privateToken) {
        showStatus(els.dupeStatus, "err", "Set up the connection (section 1) and test it before scanning.");
        return;
      }
      hideStatus(els.dupeStatus);
      els.dupeResultsWrap.innerHTML = "";
      els.btnScanDupes.disabled = true;
      setDupeProgress(true, 0, 1, "Scanning the dispatch pipeline — this reads every Opportunity individually and can take a few minutes on a large pipeline…");

      findDuplicateWorkOrders(function (done, total) {
        setDupeProgress(true, done, total, "Scanning… " + done + " / " + total);
      })
        .then(function (result) {
          lastDupeResult = result;
          setDupeProgress(false, 0, 0, "");
          if (result.duplicateGroups.length === 0) {
            showStatus(els.dupeStatus, "ok", "Scanned " + result.totalOpportunities + " Opportunities in “" + result.pipelineName + "” (" + result.withWoCount + " with a Work Order Number) — no duplicates found.");
          } else {
            var dupOppCount = result.duplicateGroups.reduce(function (n, g) { return n + g.opportunities.length; }, 0);
            showStatus(els.dupeStatus, "err", "Scanned " + result.totalOpportunities + " Opportunities — found " + result.duplicateGroups.length + " Work Order Number(s) with more than one Opportunity card (" + dupOppCount + " Opportunities total). Review below before importing or applying more payment statements for these.");
          }
          renderDupeResults(result);
        })
        .catch(function (err) {
          setDupeProgress(false, 0, 0, "");
          showStatus(els.dupeStatus, "err", "Scan failed: " + err.message);
        })
        .finally(function () { els.btnScanDupes.disabled = false; });
    });

    // ---- 7. Extension download (GitHub Releases) ----
    // A webpage can never install or run software on a visitor's computer
    // by itself — this only gets them the zip with one click. The actual
    // install (unzip + Load unpacked in the browser) still happens
    // locally, once, on each computer that needs the extension — but as of
    // 2026-10-15 that's the whole install: no installer script, no OS
    // detection needed (one zip, same steps on Mac/Windows/Linux), no GHL
    // token touches this computer at all. The URL below is GitHub's stable
    // "always the newest Release" link — publishing a new GitHub Release
    // with the same asset filename is the only thing that has to happen to
    // ship an update; this link never changes. Unlike this URL,
    // dashboard.js/setup.js are loaded via jsDelivr's "@main" (not
    // "@latest" — see the top-of-file comment), since those files should
    // always track the newest commit, not a Release tag; the two
    // mechanisms are intentionally different because Releases here version
    // the extension zip, not this dashboard code.
    function releaseAssetUrl(repo, asset) {
      return "https://github.com/" + repo + "/releases/latest/download/" + encodeURIComponent(asset);
    }

    // installSteps/openInstallSteps: the on-page checklist that pops up the
    // instant someone clicks the download button, so the guidance reads as
    // part of that click even though the file-save itself is the browser's
    // own UI. The overlay is appended to <body>, not #cjt-setup-root, so it
    // always covers the full viewport.
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
    // Checklist progress persists per-computer (localStorage), so closing
    // the popup — or leaving the page and coming back later to finish
    // install — doesn't lose which steps were already done. This is a
    // per-browser convenience only: it never leaves this machine and
    // nothing here is synced anywhere.
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

    function renderExtensionDownload() {
      var repo = (CONFIG.extensionRepo || "").trim();
      var asset = (CONFIG.extensionAsset || "").trim();
      if (!repo) {
        els.extDownloadWrap.innerHTML = '<div class="hint">Set <span class="mono">extensionRepo</span> in CJT_CONFIG (e.g. "your-org/cjt-ops-dashboard") to show the download button here.</div>';
        return;
      }
      var btn = asset
        ? '<a class="btn primary" id="extDownloadBtn" href="' + esc(releaseAssetUrl(repo, asset)) + '" target="_blank" rel="noopener noreferrer" download>Download the extension</a>'
        : '<button type="button" class="btn" disabled>Download the extension (not published yet)</button>';
      els.extDownloadWrap.innerHTML =
        '<div class="btnRow">' + btn + "</div>" +
        '<div class="hint" style="margin-top:10px;">Same download for Mac, Windows, and Linux — works in Chrome, Edge, Brave, or Vivaldi. ' +
        "Click to start the download — a step-by-step install checklist pops up here right away to walk you through the rest (it's just unzip and load it in the browser, no installer). This button only starts the download; the checklist covers the rest." +
        "</div>";
      // Don't preventDefault on click — the browser's own download must
      // still fire normally. This only opens the on-page checklist for
      // what to do once that download lands.
      var a = els.extDownloadWrap.querySelector("#extDownloadBtn");
      if (a) a.addEventListener("click", function () { openInstallSteps(); });
    }
    renderExtensionDownload();

    // ---- 8. Rates & Services -------------------------------------------
    var rateEngineData = { services: [], rateTables: [], accounts: [] };
    var editingSvcId = null, editingRtId = null, editingAcctId = null;

    function requireConn() {
      if (!CONFIG.locationId || !CONFIG.privateToken) {
        showStatus(els.rateSetupStatus, "err", "Fill in Location ID and Private Integration Token above first (section 1), then come back here.");
        return false;
      }
      return true;
    }

    els.btnSetupRateEngine.addEventListener("click", function () {
      if (!requireConn()) return;
      Object.assign(CONFIG, liveConfigFromForm());
      els.btnSetupRateEngine.disabled = true;
      showStatus(els.rateSetupStatus, "info", "Starting…");
      ensureRateEngineSetup(function (label) { showStatus(els.rateSetupStatus, "info", label + "…"); })
        .then(function () {
          showStatus(els.rateSetupStatus, "ok", "Rate engine is set up. Loading…");
          return loadRatesData();
        })
        .catch(function (err) {
          showStatus(els.rateSetupStatus, "err", "Setup failed: " + err.message + " — safe to click “Set up rate engine” again, it skips anything already created.");
        })
        .finally(function () { els.btnSetupRateEngine.disabled = false; });
    });
    els.btnLoadRates.addEventListener("click", function () {
      if (!requireConn()) return;
      Object.assign(CONFIG, liveConfigFromForm());
      loadRatesData();
    });

    function loadRatesData() {
      showStatus(els.rateSetupStatus, "info", "Loading services, rate tables, and business accounts…");
      return Promise.all([
        listObjectRecords(CONFIG.objectKeys.services).catch(function () { return []; }),
        listObjectRecords(CONFIG.objectKeys.rateTables).catch(function () { return []; }),
        listObjectRecords(CONFIG.objectKeys.businessAccounts).catch(function () { return []; }),
      ]).then(function (results) {
        rateEngineData.services = results[0];
        rateEngineData.rateTables = results[1];
        rateEngineData.accounts = results[2];
        renderServicesTable();
        renderRateTablesTable();
        renderAcctsTable();
        hideStatus(els.rateSetupStatus);
      }).catch(function (err) {
        showStatus(els.rateSetupStatus, "err", "Couldn't load — " + err.message + ". If this is the first time, click “Set up rate engine” first.");
      });
    }

    function propsOf(r) { return r.properties || {}; }

    function renderServicesTable() {
      var rows = rateEngineData.services;
      if (!rows.length) { els.servicesTableWrap.innerHTML = '<div class="hint">No services yet — add one below (optional; the base fee/mileage rate below work fine with zero services).</div>'; return; }
      els.servicesTableWrap.innerHTML =
        '<div class="tableWrap"><table><thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>Price</th><th>Active</th><th></th></tr></thead><tbody>' +
        rows.map(function (r) {
          var p = propsOf(r);
          return "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.category || "") + "</td><td>" + esc(p.unit || "flat") + "</td><td>" + money(p.price) + "</td><td>" +
            (p.active === false ? "inactive" : "active") + '</td><td><button type="button" class="btn" data-edit-svc="' + esc(r.id) + '">Edit</button></td></tr>';
        }).join("") + "</tbody></table></div>";
      Array.prototype.forEach.call(els.servicesTableWrap.querySelectorAll("[data-edit-svc]"), function (btn) {
        btn.addEventListener("click", function () {
          var rec = rows.filter(function (r) { return r.id === btn.getAttribute("data-edit-svc"); })[0];
          if (!rec) return;
          var p = propsOf(rec);
          editingSvcId = rec.id;
          els.fSvcName.value = p.name || "";
          els.fSvcCategory.value = p.category || "towing";
          els.fSvcUnit.value = p.unit || "flat";
          els.fSvcPrice.value = p.price != null ? p.price : 0;
          els.btnSaveService.textContent = "Save changes";
          els.btnCancelSvcEdit.style.display = "";
        });
      });
    }

    function resetSvcForm() {
      editingSvcId = null;
      els.fSvcName.value = ""; els.fSvcCategory.value = "towing"; els.fSvcUnit.value = "flat"; els.fSvcPrice.value = 0;
      els.btnSaveService.textContent = "Add service";
      els.btnCancelSvcEdit.style.display = "none";
    }
    els.btnCancelSvcEdit.addEventListener("click", resetSvcForm);
    els.btnSaveService.addEventListener("click", function () {
      if (!requireConn()) return;
      var name = els.fSvcName.value.trim();
      if (!name) { showStatus(els.svcStatus, "err", "Name is required."); return; }
      var props = { name: name, category: els.fSvcCategory.value.trim() || "towing", unit: els.fSvcUnit.value, price: parseFloat(els.fSvcPrice.value) || 0, active: true };
      els.btnSaveService.disabled = true;
      var p = editingSvcId ? updateObjectRecord(CONFIG.objectKeys.services, editingSvcId, props) : createObjectRecord(CONFIG.objectKeys.services, props);
      p.then(function () {
        showStatus(els.svcStatus, "ok", "Saved.");
        resetSvcForm();
        return loadRatesData();
      }).catch(function (err) {
        showStatus(els.svcStatus, "err", "Couldn't save: " + err.message);
      }).finally(function () { els.btnSaveService.disabled = false; });
    });

    function renderRateTablesTable() {
      var rows = rateEngineData.rateTables;
      if (!rows.length) { els.ratesTableWrap.innerHTML = '<div class="hint">No rate tables yet — click “Set up rate engine” above to seed the first one from today\'s live numbers.</div>'; return; }
      els.ratesTableWrap.innerHTML =
        '<div class="tableWrap"><table><thead><tr><th>Name</th><th>Base</th><th>Per Mile</th><th>Included mi</th><th>Minimum</th><th>After-hrs %</th><th>Flatbed +</th><th>Rounding</th><th>Current</th><th></th></tr></thead><tbody>' +
        rows.map(function (r) {
          var p = propsOf(r);
          return "<tr><td><b>" + esc(p.name) + "</b></td><td>" + money(p.base_fee) + "</td><td>" + money(p.per_mile_rate) + "</td><td>" + esc(p.included_miles || 0) +
            "</td><td>" + money(p.minimum_fee) + "</td><td>" + esc(p.after_hours_pct || 0) + "%</td><td>" + money(p.flatbed_surcharge) + "</td><td>" + esc(p.rounding || "ceiling") +
            "</td><td>" + (p.is_current ? '<span class="status-pill status-matched">current</span>' : '<span class="status-pill">historical</span>') +
            '</td><td><button type="button" class="btn" data-edit-rt="' + esc(r.id) + '">Edit</button></td></tr>';
        }).join("") + "</tbody></table></div>";
      Array.prototype.forEach.call(els.ratesTableWrap.querySelectorAll("[data-edit-rt]"), function (btn) {
        btn.addEventListener("click", function () {
          var rec = rows.filter(function (r) { return r.id === btn.getAttribute("data-edit-rt"); })[0];
          if (!rec) return;
          var p = propsOf(rec);
          editingRtId = rec.id;
          els.fRtName.value = p.name || "";
          els.fRtRounding.value = p.rounding || "ceiling";
          els.fRtBase.value = p.base_fee != null ? p.base_fee : 85;
          els.fRtPerMile.value = p.per_mile_rate != null ? p.per_mile_rate : 3;
          els.fRtIncluded.value = p.included_miles || 0;
          els.fRtMin.value = p.minimum_fee || 0;
          els.fRtAfterHours.value = p.after_hours_pct || 0;
          els.fRtFlatbed.value = p.flatbed_surcharge || 0;
          els.fRtIsCurrent.checked = !!p.is_current;
          els.btnSaveRateTable.textContent = "Save changes";
          els.btnCancelRtEdit.style.display = "";
        });
      });
    }

    function resetRtForm() {
      editingRtId = null;
      els.fRtName.value = ""; els.fRtRounding.value = "ceiling"; els.fRtBase.value = 85; els.fRtPerMile.value = 3;
      els.fRtIncluded.value = 0; els.fRtMin.value = 0; els.fRtAfterHours.value = 0; els.fRtFlatbed.value = 0; els.fRtIsCurrent.checked = false;
      els.btnSaveRateTable.textContent = "Add rate table";
      els.btnCancelRtEdit.style.display = "none";
    }
    els.btnCancelRtEdit.addEventListener("click", resetRtForm);
    els.btnSaveRateTable.addEventListener("click", function () {
      if (!requireConn()) return;
      var name = els.fRtName.value.trim();
      if (!name) { showStatus(els.rtStatus, "err", "Name is required."); return; }
      var makeCurrent = els.fRtIsCurrent.checked;
      var props = {
        name: name, rounding: els.fRtRounding.value,
        base_fee: parseFloat(els.fRtBase.value) || 0, per_mile_rate: parseFloat(els.fRtPerMile.value) || 0,
        included_miles: parseFloat(els.fRtIncluded.value) || 0, minimum_fee: parseFloat(els.fRtMin.value) || 0,
        after_hours_pct: parseFloat(els.fRtAfterHours.value) || 0, flatbed_surcharge: parseFloat(els.fRtFlatbed.value) || 0,
        is_current: makeCurrent,
      };
      if (!editingRtId) props.effective_date = new Date().toISOString().slice(0, 10);
      els.btnSaveRateTable.disabled = true;
      var save = editingRtId ? updateObjectRecord(CONFIG.objectKeys.rateTables, editingRtId, props) : createObjectRecord(CONFIG.objectKeys.rateTables, props);
      save.then(function () {
        if (!makeCurrent) return;
        // Only one table should ever be "current" — unset every other one
        // that still claims it, same rule HookOps' own data enforces (it
        // just happens to do it via a UNIQUE-ish admin convention rather
        // than a real constraint — mirrored here explicitly since GHL has
        // no such constraint to lean on at all).
        var others = rateEngineData.rateTables.filter(function (r) { return propsOf(r).is_current && r.id !== editingRtId; });
        return Promise.all(others.map(function (r) { return updateObjectRecord(CONFIG.objectKeys.rateTables, r.id, { is_current: false }); }));
      }).then(function () {
        showStatus(els.rtStatus, "ok", "Saved.");
        resetRtForm();
        return loadRatesData();
      }).catch(function (err) {
        showStatus(els.rtStatus, "err", "Couldn't save: " + err.message);
      }).finally(function () { els.btnSaveRateTable.disabled = false; });
    });

    function renderAcctsTable() {
      var opts = '<option value="">—</option>' + rateEngineData.rateTables.map(function (r) {
        return '<option value="' + esc(propsOf(r).name) + '">' + esc(propsOf(r).name) + "</option>";
      }).join("");
      els.fAcctRateTable.innerHTML = opts;
      var rows = rateEngineData.accounts;
      if (!rows.length) { els.acctsTableWrap.innerHTML = '<div class="hint">No business accounts yet — “Set up rate engine” seeds “AAA” and “Private” automatically.</div>'; return; }
      els.acctsTableWrap.innerHTML =
        '<div class="tableWrap"><table><thead><tr><th>Name</th><th>Type</th><th>Default Rate Table</th><th></th></tr></thead><tbody>' +
        rows.map(function (r) {
          var p = propsOf(r);
          return "<tr><td><b>" + esc(p.name) + "</b></td><td>" + esc(p.type || "") + "</td><td>" + esc(p.default_rate_table || "—") +
            '</td><td><button type="button" class="btn" data-edit-acct="' + esc(r.id) + '">Edit</button></td></tr>';
        }).join("") + "</tbody></table></div>";
      Array.prototype.forEach.call(els.acctsTableWrap.querySelectorAll("[data-edit-acct]"), function (btn) {
        btn.addEventListener("click", function () {
          var rec = rows.filter(function (r) { return r.id === btn.getAttribute("data-edit-acct"); })[0];
          if (!rec) return;
          var p = propsOf(rec);
          editingAcctId = rec.id;
          els.fAcctName.value = p.name || "";
          els.fAcctType.value = p.type || "individual";
          els.fAcctRateTable.value = p.default_rate_table || "";
          els.btnSaveAcct.textContent = "Save changes";
          els.btnCancelAcctEdit.style.display = "";
        });
      });
    }

    function resetAcctForm() {
      editingAcctId = null;
      els.fAcctName.value = ""; els.fAcctType.value = "individual"; els.fAcctRateTable.value = "";
      els.btnSaveAcct.textContent = "Add business account";
      els.btnCancelAcctEdit.style.display = "none";
    }
    els.btnCancelAcctEdit.addEventListener("click", resetAcctForm);
    els.btnSaveAcct.addEventListener("click", function () {
      if (!requireConn()) return;
      var name = els.fAcctName.value.trim();
      if (!name) { showStatus(els.acctStatus, "err", "Name is required — use the exact Dispatch Source value (e.g. “AAA” or “Private”) so this account is actually picked up."); return; }
      var props = { name: name, type: els.fAcctType.value, default_rate_table: els.fAcctRateTable.value || "" };
      els.btnSaveAcct.disabled = true;
      var save = editingAcctId ? updateObjectRecord(CONFIG.objectKeys.businessAccounts, editingAcctId, props) : createObjectRecord(CONFIG.objectKeys.businessAccounts, props);
      save.then(function () {
        showStatus(els.acctStatus, "ok", "Saved.");
        resetAcctForm();
        return loadRatesData();
      }).catch(function (err) {
        showStatus(els.acctStatus, "err", "Couldn't save: " + err.message);
      }).finally(function () { els.btnSaveAcct.disabled = false; });
    });

    // Auto-load if a connection is already configured (e.g. this page was
    // loaded with a real CJT_CONFIG already pasted in), so the admin isn't
    // staring at empty tables before doing anything.
    if (CONFIG.locationId && CONFIG.privateToken) loadRatesData();
  }
})();

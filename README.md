# CJT Ops Dashboard

A GHL-native ops dashboard for CJ Taylor Towing (and, later, other towing-company
clients running on GoHighLevel). No backend, no Claude/Anthropic dependency at
runtime — it's two plain JavaScript files, pasted into GHL's own Website/Funnel
builder as Custom HTML, that call GHL's REST API directly from the browser.

## Why it's built this way

- **Lives inside GHL.** Pasting an externally-hosted URL into a GHL Custom Menu
  Link renders blank (confirmed — external hosts commonly send headers that
  block iframe embedding). The fix: paste the code into GHL's own Website/Funnel
  Custom HTML/CSS/JS element, then point a Custom Menu Link (in "Embedded
  iframe" mode) at *that page's own GHL URL*. That keeps everything inside GHL,
  no external host in the loop.
- **Hosted on GitHub, loaded via jsDelivr.** Each client's pasted snippet is
  tiny — a config block plus one `<script src="https://cdn.jsdelivr.net/gh/...">`
  tag. All the real logic lives in `dashboard.js` / `setup.js` here. Push an
  update to this repo and every client's dashboard picks it up the next time
  their page loads — no re-pasting code per client.
- **No backend, on purpose.** The GHL REST API (`services.leadconnectorhq.com`)
  allows open CORS, confirmed live via an `OPTIONS` preflight
  (`access-control-allow-origin: *`), so the browser can call it directly with
  an embedded Private Integration Token. Simpler to build and sell than
  standing up and hosting a server per client — the tradeoff is spelled out in
  "Security model" below.

## Files

- **`dashboard.js`** — the client-facing dashboard: Dispatch, AAA Payments,
  Drivers (profiles/performance/commissions/training), Trucks (fleet/
  assignments/maintenance). Reads live from GHL on load and via a manual
  Refresh button. Optional passcode lock + idle-blur screen lock.
- **`setup.js`** — the admin-only config generator and AAA payment-statement
  importer. Generates the exact snippet to paste into both pages, tests the
  GHL connection, and reconciles AAA pay statements against Dispatch
  Opportunities by Work Order Number, same matching logic as the existing
  `AAA-GHL-Extractor` tool's `import_aaa_payments.py`. Also owns the rate
  engine (services/rate tables/business accounts — see "Rate engine" below)
  — it's the only file that writes to those three objects.

## Setting up a new client

1. In GHL: Settings → Private Integrations → create a token with read/write
   access to Opportunities, Contacts, and Objects.
2. In GHL's Website/Funnel builder, add a page (or use an existing one) with a
   Custom HTML/CSS/JS element. Paste:
   ```html
   <div id="cjt-dashboard-root"></div>
   <script>
     window.CJT_CONFIG = {
       locationId: "THEIR_GHL_LOCATION_ID",
       privateToken: "THEIR_GHL_PRIVATE_INTEGRATION_TOKEN",
       ghlBase: "https://app.THEIRDOMAIN.com",
       dispatchPipelineName: "Towing Dispatch",
       baseTowRate: 85,
       mileageRate: 3,
       setupUrl: "https://THEIRDOMAIN.com/setup"
     };
   </script>
   <script src="https://cdn.jsdelivr.net/gh/YOUR_GH_ORG/cjt-ops-dashboard@latest/dashboard.js"></script>
   ```
3. Do the same on a second page for Setup, swapping `cjt-dashboard-root` for
   `cjt-setup-root` and `dashboard.js` for `setup.js` at the end.
4. In GHL: Settings → Menu Links → add Custom Menu Links to each page's own
   GHL URL, mode "Embedded iframe". Set the dashboard link visible to All
   users, and the Setup link visible to Admins only (Role-Based Visibility) —
   Setup can read and write live data with the same token, so it should never
   be reachable by non-admin staff.
5. Open the Setup page once to confirm the connection ("Test connection"),
   set pricing rates, optionally set a passcode + idle-lock minutes, then use
   "Generate dashboard snippet" and paste the output back into both pages'
   Custom HTML elements (step 2/3), replacing the placeholder block.

After that, updating pricing, the passcode, or the token is: change it on the
Setup page, Generate, paste the new snippet into both pages. There's no shared
backend, so the GHL page source *is* the config, on each page independently.

## AAA payment-statement import (Setup page, section 5)

Ports the matching logic already confirmed and live in
`AAA-GHL-Extractor/import_aaa_payments.py`: match each statement row to its
Opportunity by Work Order Number, skip rows already reconciled (same Payment
ID already on file), compute AAA Payment Difference only when the matched
Opportunity has an Expected Tow Amount on file. Nothing is written until you
type `APPLY` to confirm, after reviewing the preview summary and table.

Supports CSV and Excel (`.xlsx`) directly. For a PDF statement, copy the table
out of your PDF viewer and use "...or paste a table instead" — it accepts
tab- or comma-separated pasted text. True PDF parsing (reading the file
directly) isn't built yet; it needs a real sample PDF statement to get the
layout right rather than guessing one.

**Works on any sub-account cloned from your snapshot, with zero per-client
config.** The AAA fields on the Opportunity (Work Order Number, Expected Tow
Amount, AAA Payment ID, etc.) are looked up **by name** through GHL's own
`GET /locations/{locationId}/customFields` endpoint at the start of every
preview/import run — not hardcoded IDs. This matters because GHL regenerates
a new internal ID for every custom field when a snapshot is cloned into a new
sub-account, even though the field *name* stays identical — so a hardcoded ID
only ever works for the one location it was copied from. Name-based lookup
works for any client whose sub-account came from the same snapshot, since the
snapshot guarantees the names match even though the IDs don't. Hitting "Test
connection" on the Setup page shows a field-mapping table so you can confirm,
per client, that all 7 AAA fields resolved by name before running a real
import — if one shows "using fallback ID" or "not found," that field's name
in this location doesn't match what's expected (check spelling/capitalization
in GHL), and import results for that field won't be reliable until it's
fixed. See `FIELD_NAME_CANDIDATES` in `setup.js` to add a name variant.

Pipeline names and custom-object schema keys (`driver_profiles`, `trucks`,
etc.) don't have this problem — GHL preserves those exactly through a
snapshot clone, so `dashboard.js`'s other sections (Drivers, Trucks,
Maintenance, Training) already work unchanged on a new client's sub-account,
same snapshot, no config beyond the token/Location ID and confirming the
pipeline name in Setup.

On Apply, each row writes to the matched Opportunity's own AAA custom fields
(AAA Payment ID, AAA Gross Paid Amount, AAA Pay Date, AAA Paid Tow Miles, AAA
Payment Difference) — same fields `import_aaa_payments.py` already writes.
That's the only write (see the REMOVED note at the top of `setup.js`: AAA
payment data used to also mirror into a separate `aaa_payments` Custom
Object, deleted on purpose 2026-10-13 — it belongs on the Opportunity only).
A statement row with no matching Opportunity ("no match") has nowhere to go
and is reported in the Preview summary only, same as a no-op in the Python
tool.

## Rate engine (Setup page, section 8)

What a job costs, modeled directly on a real working reference rather than
invented fresh: the same `services` + `rate_tables` shape (and the same
`compute_expected_amount` formula) as HookOps' own rates module
(`app/routes/rates.py`, `app/biz.py`) — the software this whole build is
patterned on. Three new Custom Objects:

- **`rate_tables`** — Name, Effective Date, Is Current, Base Fee, Per Mile
  Rate, Included Miles (free before per-mile billing starts), Minimum Fee,
  After-Hours Pct, Flatbed Surcharge, Rounding (ceiling/nearest/none). Only
  one table is ever "current" — that's the one new jobs get priced against.
  A job keeps whichever table was current when it was created (stamped onto
  its own **Rate Table Used** field, a new field on the Opportunity, set at
  creation time — see "What still needs testing" below for who sets this,
  since the compiled extractor can't be changed from this repo), so changing
  a rate later never touches a job already priced. Reduces to exactly
  today's $85 + $3/mi formula when every extra field is left at zero.
- **`services`** — Name, Category, Unit (flat/per_mile/per_hour/per_day/
  per_unit), Active, Price. What kind of job it is; each can carry its own
  price, read off the Opportunity's **Service Type** field (also new).
  Optional — the base fee/mileage rate above work fine with zero services.
- **`business_accounts`** — Name, Type, Default Rate Table, Billing Contact,
  Payment Terms, Notes. Matches the *existing* Dispatch Source field
  (AAA/Private) **by name** rather than adding a third new Opportunity
  field — "Set up rate engine" seeds one named "AAA" and one named "Private"
  automatically, both pointing at the seeded rate table.

**Not ported from HookOps, because CJT doesn't need it the way the reference
app's multi-tenant version does**: HookOps keeps service prices in a
separate join table so one service can price differently across several
*simultaneous* rate tables; CJT only ever has one current table, so each
service just carries its own price directly. Flatbed Surcharge is new too —
HookOps treats flatbed as a *truck* attribute, not a pricing input, and
doesn't charge for it anywhere. Starts at $0, so it changes nothing until a
real number is set. After-Hours Pct is carried on `rate_tables` matching
HookOps' own schema, but HookOps' `compute_expected_amount` never actually
reads it either — applying it here as a flat percentage markup on the whole
computed total is this repo's own interpretation of what the field is for,
not something proven against a working reference.

**"Set up rate engine" is idempotent** — safe to click more than once; it
checks before creating anything, and only seeds the first rate table/
accounts on the very first run (skipped if any `rate_tables` record already
exists, so it never re-seeds over real data).

**Dashboard-side, read-only**: `dashboard.js`'s AAA Payments tab adds a "Rate
engine says" column next to the existing Expected/Diff columns — what the
rate engine computes a job *should* cost from its Rate Table Used/Service
Type/Flatbed Required/Tow Miles, flagged when it disagrees with whatever the
extractor actually wrote as Expected Tow Amount. This is diagnostic only: it
does **not** change the existing AAA Payment Difference write, which still
compares Gross Paid against the Opportunity's own stored Expected Tow
Amount, exactly as before. The extractor (`native-host/src/main.go`, a
compiled binary) can't be updated from this repo to use the richer formula
at job-creation time, so this column is how a mismatch becomes visible
without silently rewriting a financial field nobody asked to change yet.

## The AAA Work Order Extractor extension (bundled, downloaded from here)

The dispatcher-side companion tool — a Chrome extension plus a small local
"bridge" program — lives in a separate project (`AAA-GHL-Extractor-Mac`),
not in this repo's `dashboard.js`/`setup.js`. It reads an open AAA work
order page and can preview/sync it straight into the Dispatch pipeline this
dashboard also reads from. It never stores a GHL token itself — all GHL
calls go through the local bridge, which reads its own `.env`/config on
that computer.

**Setup page section 6 ("AAA Work Order Extractor") is a download button,
not an installer.** A webpage cannot install or run software on a
visitor's computer by itself, full stop — clicking the button only
downloads a zip from this repo's GitHub Releases. The actual install
(unzip, then run the `.command` installer inside) still happens once,
locally, on each computer that needs the extension — the same as
installing any other desktop app.

**Distributing an update:** build/zip the extension project as usual, then
on GitHub: Releases → Draft a new release → attach the zip **named exactly**
`AAA-GHL-Extractor-Mac.zip` (the filename `extensionMacAsset` in
`setup.js`'s `DEFAULTS` expects) → publish. The Setup page's download
button always points at
`github.com/{extensionRepo}/releases/latest/download/{asset}`, GitHub's own
"always resolves to the newest published Release" URL — so publishing a new
Release with the same asset filename is the only step needed to ship an
update; the button and every client's pasted snippet never change.
`extensionRepo` defaults to this repo (`jmdnoob/cjt-ops-dashboard`) but can
be overridden per deployment via `CJT_CONFIG.extensionRepo` (e.g. a
reseller's own fork). A Windows build now ships too (2026-09-17) — attach
`AAA-GHL-Extractor-Windows.zip` to the same Release alongside the Mac zip;
`setup.js`'s `DEFAULTS.extensionWindowsAsset` already points at that exact
filename, so the Windows button activates as soon as the Release has that
asset. Same "publish a new Release with the same asset filename to ship an
update" rule applies to both platforms — **both asset filenames are
unversioned on purpose** (the Windows one was pinned to
`...-v1.0.0.zip` until 2026-10-15, which meant a setup.js edit was needed
for every single Windows update; fixed to match the Mac convention, so
shipping either platform's update again is just "attach a zip with this
exact name to a new Release," no code change, ever).

**2026-10-15 fix — native host registered for one browser only.** Both the
Mac and Windows installers originally wrote their native-messaging
registration into Microsoft Edge's lookup location only (Mac:
`~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`;
Windows: `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\...`). Loading
the extension into any OTHER browser (Chrome especially, since that's what
most people actually use) showed "Native host unavailable (Specified
native messaging host not found.)" in the popup — a correctly-run install
that simply couldn't be found by the browser it was loaded into. Fixed in
both installers (Mac `AAA-GHL-Extractor-Mac.zip`, Windows
`AAA-GHL-Extractor-Windows.zip`) to register the same manifest under
Chrome's, Edge's, Brave's, and Vivaldi's own lookup locations; Opera needs
nothing extra since it reads Chrome's registration instead of maintaining
its own (confirmed via Opera's own forum). `setup.js`'s install checklist
text was updated to match — it no longer tells people to specifically look
for Edge.

**The extension's own field-ID bug (fixed 2026-09-17).** The native bridge
(`native-host/src/main.go`) had the exact same class of bug `setup.js` had:
~10 GHL custom-field IDs (Work Order Number, Tow Miles, Base/Mileage Rate,
Expected Tow Amount, Dispatch Source, Flatbed Required, Destination Name,
etc.) were hardcoded to CJ Taylor Towing's own location. Fixed the same
way: at the start of every preview/create/commit, the bridge now calls GHL's
own `GET /locations/{locationId}/customFields`, matches each field it needs
**by name**, and only falls back to the hardcoded CJ-Taylor-Towing ID when
no name match is found (cached 10 minutes per location so a long-lived
bridge process isn't re-fetching on every message). `--self-check` /
`CHECK-SETUP.command` now also prints how many fields resolved by name vs.
fell back, same diagnostic value as this page's own field-mapping table
above. Covered by new Go tests (`TestDynamicFieldResolutionAcrossSubAccounts`,
`TestDynamicFieldResolutionFallsBackWhenNameMissing`,
`TestFieldIDResolutionIsCached`) simulating a second sub-account with
regenerated field IDs but identical names — same scenario a real client's
snapshot clone produces. All pre-existing tests still pass unchanged. The
Mac binaries in `native-host/bin/` have been rebuilt with this fix; nothing
else about installing/registering the extension changed.

## Security model

There is no way to hide a secret embedded in client-side code from someone
with devtools or page-source access — the Private Integration Token and the
passcode hash are both readable by anyone who views the page source. This
project doesn't try to pretend otherwise:

- The **passcode + idle-blur lock** (dashboard and Setup) is a deterrent
  against a screen left open and unattended at the shop — not real
  cryptographic protection. It stops a passerby, not a technical attacker who
  reads the page source.
- What actually protects a client's data is **token scoping and easy
  rotation**: give the Private Integration Token only the GHL scopes it needs
  (Opportunities, Contacts, Objects — not more), and rotate it via the Setup
  page (new token → Generate → paste into both pages) if it's ever exposed.
- Setup should be reachable only by admins (Role-Based Visibility on its
  Custom Menu Link) since it can write live data, not just read it.

## What still needs testing

No real GHL Private Integration Token has been available in this build
session — everything below has been verified against realistic *shapes* of
real, previously-captured GHL API responses (see the JSON dumps this repo's
build process used), via a Playwright test harness that stubs `fetch`, but
not against live traffic. Before relying on this in front of a client:

- [ ] Confirm the `Version` header value GHL currently expects for each
      endpoint (`apiVersions` in both files) — GHL versions endpoints
      independently and these are last-known-good, not guaranteed current.
- [ ] Confirm the write shape for `POST /objects/aaa_payments/records` — this
      build writes currency-shaped properties as plain numbers to match how
      they read back elsewhere in the dashboard, but that hasn't been
      confirmed against a real write. Run one import in preview-only mode,
      then Apply on a **small** statement first, and check the created record
      in GHL before trusting this at scale.
  - [ ] Once confirmed, capture a real created-record response and update
        this checklist.
- [ ] Confirm the AAA/Work-Order field **names** `FIELD_NAME_CANDIDATES` in
      `setup.js` searches for actually match what's in GHL on a real
      location — these are inferred from labels the existing Python
      Extractor tool prints for the same fields, not independently
      re-confirmed against a live `customFields` dump. Run "Test connection"
      on Setup and check the field-mapping table; it should show all 7 as
      "found by name" (`FIELD_ID_FALLBACKS` only covers CJ Taylor Towing's
      own IDs as a safety net, not a real fix for a different client).
- [ ] Confirm custom-object property keys (`objectKeys` in both files) for a
      different client's GHL objects, if their schema differs from CJ Taylor
      Towing's (`driver_profiles`, `trucks`, `maintenance_records`,
      `training_records`, `driver_quarters`, `aaa_payments`).
- [ ] Confirm the pagination cap on `/objects/:schemaKey/records/search`
      behaves as expected at real data volumes (currently capped at 5,000
      records / batch-size-based stop as a safety net, not a confirmed GHL
      limit).
- [ ] Load-test `setup.js`'s per-Opportunity `GET` calls (`buildWoMap`)
      against a pipeline with a few hundred+ Opportunities — it fetches full
      detail for every Opportunity in the dispatch pipeline (6 at a time) to
      read Work Order Number, since `/opportunities/search` doesn't reliably
      return complete `customFields` (confirmed by the existing Python tool's
      own docstring). This is fine for a small towing company's pipeline but
      hasn't been timed at scale.
- [ ] Rate engine (section 8, 2026-10-15) — click "Set up rate engine" once
      against a real token and read what it reports before relying on any of
      this in front of a client:
  - [ ] The object/field *creation* calls (`ensureObjectSchema`,
        `ensureObjectField`, `ensureOpportunityField`) have never been run
        live — written against GHL's documented Objects v3 shape, same
        confidence level as everything else in this checklist, not more.
  - [ ] Nothing in this repo sets the new **Service Type** / **Rate Table
        Used** fields on an Opportunity at job-creation time — that's the
        extractor's job (`native-host/src/main.go`, a compiled binary not in
        this repo), and it hasn't been updated to do so. Until it is, every
        job keeps showing "—" in the dashboard's "Rate engine says" column
        (no Rate Table Used on file), which is the correct, safe state, not
        a bug — it just means the recompute diagnostic has nothing to check
        yet for jobs created by the extractor as it exists today.
  - [ ] Confirm `MONETORY`/`NUMERICAL`/`CHECKBOX`/`SINGLE_OPTIONS` are
        accepted as Custom Object field `dataType` values on a real token —
        spelled and cased exactly as GHL's own docs give them, not
        independently re-verified live.

## Not yet built

- Chrome extension self-hosted auto-update (`update_url` manifest mechanism)
  for the separate `AAA-GHL-Extractor` browser-extension product — today,
  shipping a new version means publishing a new GitHub Release (see
  "Distributing the extension" above); Chrome itself still needs the
  extension reloaded/reinstalled to pick up a packed-extension code change,
  which the download button doesn't automate.
- True PDF parsing for AAA statements (currently: paste-the-table fallback).
- An actual live-GHL paste-and-render check of `dashboard.js`/`setup.js` on
  a **second**, real GHL sub-account cloned from the snapshot — the
  by-name field resolution in both this repo and the extension's native
  host has only been verified against realistic fixture data that
  *simulates* a second sub-account's regenerated field IDs, not a real one.
- The extractor (`native-host/src/main.go`) setting **Service Type** / **Rate
  Table Used** on a new Opportunity at creation time, and picking a rate
  table by Business Account / choosing a service-specific price — the rate
  engine (section 8) is fully built and live on the GHL/dashboard side, but
  the compiled extractor still only ever writes the plain base+mileage
  formula, since it's a separate binary this repo can't rebuild. Until the
  extractor's own source is available to update, new jobs won't have a Rate
  Table Used on file, and the dashboard's "Rate engine says" column has
  nothing to compare against — not a bug, just the current ceiling.

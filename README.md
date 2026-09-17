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
  `AAA-GHL-Extractor` tool's `import_aaa_payments.py`.

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

On Apply, each row writes to **two places**:
1. The matched Opportunity's own AAA custom fields (AAA Payment ID, AAA Gross
   Paid Amount, AAA Pay Date, AAA Paid Tow Miles, AAA Payment Difference) —
   same fields `import_aaa_payments.py` already writes, so nothing that
   depends on those fields breaks.
2. A new record in the `aaa_payments` custom object (`aaa_payment_id`,
   `work_order_number`, `gross_paid_amount`, `expected_tow_amount`,
   `payment_difference_value`, `reconciliation_status`, `exception_reason`) —
   this is what `dashboard.js`'s "AAA Payments" section actually reads, and it
   captures unmatched/exception rows too, which the Opportunity-only approach
   can't (there's no Opportunity to write to for an unmatched Work Order).

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
`AAA-GHL-Extractor-Windows-v1.0.0.zip` to the same Release alongside the Mac
zip; `setup.js`'s `DEFAULTS.extensionWindowsAsset` already points at that
exact filename, so the Windows button activates as soon as the Release has
that asset. Same "publish a new Release with the same asset filename to
ship an update" rule applies to both platforms.

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

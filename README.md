# Bus Ticketing Platform

Enterprise bus transportation and ticketing platform for the Bangladesh market.

**Status: a proven booking core, seven applications, and the platform beneath
them** — an event backbone, notifications in Bangla and English, passenger and
staff authentication, a search read model, promotions and referrals, three-way
reconciliation, an operations control centre, a partner API with signed
webhooks, a fraud engine, and analytics. Parts of the 44-week plan remain
unwritten. Read [What is NOT built](#what-is-not-built) before planning around
this repo.

---

## The rule this repo exists to enforce

> Every sales channel — web, app, counter POS, agent, operator, partner API, AI — calls the exact same Inventory Service. No channel gets its own seat logic.

The plan's step 13 makes that rule testable: *prove the inventory architecture
cannot double-book before building anything on top of it.* This repo is that
proof, executable — and every application and every API is built on top of it,
holding no seat logic of its own. The test that matters most fires a purchase
from the website, a counter, an agent and a counter quota reservation at the
same seat inside a 100 ms window and asserts **exactly one winner**. A partner
booking through the public API loses that race the same way anybody else does.

---

## Run it

**Prerequisites:** Docker. Go 1.24+ and Node 20+ for the app tier.

```bash
# 1. database and cache (schema + seed apply on first boot)
cd deploy && docker compose up -d postgres redis

# 2. API — serves /api/v1, relays events, sweeps holds, generates trips,
#    indexes search, detects operational alerts, delivers partner webhooks
cd ..
DATABASE_URL="postgres://platform:platform@localhost:55440/platform?sslmode=disable" \
  SHOW_OTP=true \
  go run ./services/api/cmd/api          # :8080

# 3. every application
cd apps/web && npm install && npm run dev  # :3000
```

Open http://localhost:3000 to book a ticket, or http://localhost:3000/staff/login
to sign in to any of the six staff workplaces. Payments use a sandbox provider;
no money moves.

`SHOW_OTP=true` returns the one-time sign-in code in the API response so a
passenger can sign in without an SMS gateway. Leave it off anywhere real.

### Signing in

**Passengers** sign in at `/login` with a mobile number and a six-digit code.
You do not need an account to buy a ticket — guest checkout is the default path,
and signing in afterwards claims the bookings made on that number.

**Staff** use `/staff/login`. Every demo account uses the password `Jatra#2026`.
These are fixtures for a local harness, which is precisely why they are weak and
public — no real credential is committed to this repository.

| Account | Lands in | Notice |
|---|---|---|
| `admin@jatra.test` | Admin console | Super Admin — holds every permission by construction |
| `finance@jatra.test` | Admin console | Ledger, settlements and reconciliation; cannot sell a seat or touch risk |
| `ops@jatra.test` | Admin console | Control centre, the event backbone, notifications |
| `auditor@jatra.test` | Admin console | Reads everything, changes nothing |
| `support@jatra.test` | Support console | Booking timelines and cases |
| `owner@greenline.test` | Operator ERP | Everything inside Green Line only |
| `dispatch@greenline.test` | Operator ERP | Watches the control centre; provably cannot act on it |
| `counter.dhaka@greenline.test` | Counter POS | Arambagh counter, with its own cash drawer |
| `driver@greenline.test` | Driver & crew | Their trips, their manifest, the scanner |
| `agent@shafi.test` | Agent portal | Shafi Travels wallet and credit line |

Where you land is decided by the server from your permissions, not from a role
name hardcoded in the app.

### Verify it

```bash
# 29 concurrency, money, promotion and event proofs (needs only Docker)
cd deploy && docker compose run --rm proof

# the 100,000-contender stampede from the specification
docker compose run --rm -e PROOF_CONTENDERS=100000 -e PROOF_WORKERS=256 -e PROOF_POOL=90 proof

# API flow suites against a running API
node scripts/smoke.mjs             # 38 checks — passenger booking and sign-in
node scripts/channels-smoke.mjs    # 79 checks — all six staff channels
node scripts/platform-smoke.mjs    # 70 checks — backbone, notifications, search,
                                   #             promotions, reconciliation, control
                                   #             centre, partner API, risk, analytics

# full flows in a real browser, with screenshots
cd apps/web
node scripts/browser-flow.mjs      # 33 checks — search → pay → ticket → cancel → sign in
node scripts/staff-flow.mjs        # 85 checks — all six staff apps and every console,
                                   #             including a real network cut
```

The browser suites sell real tickets on real trips, and the corridor fixture has
one departure per operator per day. Run them enough times and the near
departures fill up — at which point the suites are failing on a seat shortage
rather than on anything about the platform. Give the seats back with:

```bash
node scripts/reset-fixtures.mjs --days 4
```

That cancels those bookings through the same endpoint a passenger uses, so
refunds are quoted by policy, seats are released by inventory-service and the
ledger stays balanced. There is no back door that reaches into `trip_seats`,
because there is no back door anywhere.

Tear down including the database volume: `docker compose down -v`

---

## The seven applications

Next.js 16 + React 19 + TypeScript, one deployment, seven distinct workplaces.
Every route below is built and exercised by one of the two browser suites.

### Passenger website

| Route | What it does |
|---|---|
| `/` | Search, popular routes |
| `/search` | Results with operator / AC / sold-out filters and four sorts |
| `/trips/[id]` | Trip detail, route timeline, **seat map**, live price |
| `/checkout` | Passenger details, saved passengers, promo code, hold countdown |
| `/payment/[bookingId]` · `/payment/sandbox` | bKash · Nagad · card · bank |
| `/confirmation/[pnr]` | Polls until the webhook confirms |
| `/tickets/[pnr]` | E-ticket with a real scannable QR per passenger, printable |
| `/manage` · `/manage/[pnr]` · `/manage/[pnr]/reschedule` | Lookup, refund quote, cancellation, change departure |
| `/tracking/[pnr]` | Route progress and ETA, labelled by source |
| `/login` | Sign in with a one-time code or a password |
| `/account` | Trips, saved passengers, referral code, devices, language |
| `/offers` · `/support` | Live campaigns, FAQ |

### Counter POS — `/counter`

Sell, print, and balance a drawer. Search → live seat map → passenger details →
cash/bKash/Nagad/card → ticket. Shift open and close with a declared float,
counted against the ledger to the taka. Offline quota reservation, offline
selling, an automatic replay queue, and a service worker so a terminal that
reloads while the line is down still comes back up.

### Agent portal — `/agent`

Wallet, sell, bookings, commission, recharge. The wallet shows spendable,
balance, held and credit as four separate numbers, because any one of them alone
misleads.

### Operator ERP — `/operator`

Dashboard with sales-by-channel and live occupancy · **control centre** with the
seven alert types · trips with the full lifecycle and a printable manifest ·
fleet · routes and versioned fares · schedules · bookings across every channel ·
counters and their shift history · staff and roles · settlements · reports.

### Admin console — `/admin`

Platform overview · operators · agencies · wallet recharges · bookings ·
payments and every provider notification including the rejected ones · the
ledger with a live trial balance · settlements through all seven states ·
**three-way reconciliation** · **campaigns and referrals** · **the notification
delivery log** · **risk and fraud** · **partners and webhook deliveries** · **the
event backbone** · staff and roles · the append-only audit log · system health.

### Support console — `/helpdesk`

One search box that takes a PNR, phone number, email, passenger name or provider
transaction id — and a booking timeline assembled from the tables that actually
recorded what happened, each entry naming its source table, now including every
message the passenger was sent and which aggregator carried it.

### Driver & crew — `/driver`

Assigned trips, trip state, position sharing, printable manifest, the boarding
scanner, and incident reporting that actually reaches somebody.

---

## What the platform underneath does

### The event backbone

Every producing service writes to **its own transactional outbox** in the same
transaction as its state change. A relay is the only thing that publishes. Events
carry the plan's standard envelope, a **schema registry** rejects a producer that
changes shape before any consumer sees it, five **consumer groups** advance their
own checkpoints, and a message a consumer cannot handle is **dead-lettered and
replayable** rather than left to wedge everything behind it.

Kafka is not running here. The contract is the same and the sink is one file:
`events.Bus.Relay`.

### Notifications

Templates for every event in **Bangla and English**, per-event channel routing,
**two SMS aggregators with failover**, per-message cost, a **monthly budget
circuit breaker** that suppresses operational traffic and never a ticket
confirmation, per-hour caps by message class, per-recipient language and channel
preferences, and a delivery log that answers "did you send it?" with a row.

### Search

Search reads a **projection** maintained from the event stream — one row per
sellable leg — fronted by a Redis result cache with event-driven invalidation.
No search query touches `catalog.trips`, `inventory.trip_seats` or
`commerce.bookings`. Every response states how stale the projection was and
whether the page came from cache.

### Identity

Passengers: phone plus a one-time code, optional password, guest checkout that
is promoted into an account on first sign-in, **rotating refresh tokens with
reuse detection**, and device management. Staff: PBKDF2, hashed session tokens,
**TOTP second factor** where an account turns it on, and 61 permissions across 14
data-driven roles.

### Money

The double-entry ledger from before, plus: a **reschedule that actually moves
money** (collects an upgrade, refunds a downgrade, and posts a journal that
reverses the old split and applies the new one), and **three-way reconciliation**
against a gateway settlement file and a bank statement, detecting all eight
exception classes and blocking settlement approval while any of them is open.

### Operations

A detector that raises the **seven alert types** — six of which are about
something that did *not* happen, so it scans rather than listens — and a
**replacement bus** flow that atomically re-seats every passenger it can and
produces a conflict list for the ones it cannot.

### Ecosystem

A **partner API** with HMAC-signed requests, a five-minute replay window, single-
use nonces, per-partner quotas and IP allow-lists, and a sandbox tier that must
be certified before it can go live. Outbound webhooks are signed, retried with
backoff for a day, dead-lettered, replayable, and visible to the partner.

A **risk engine** with the five outcomes, rules as rows, shadow mode by default,
a review queue, reversible blocks, and a hard 30 ms latency budget that fails
open.

### Analytics

An event-sourced fact table and rollups, with an integrity check comparing the
reporting store against the transactional one. No report reads the booking
database.

---

## Verified results

Measured on this machine, Docker Desktop, single Postgres 16 container.

### Concurrency and money proofs

| Proof | Asserts | Result |
|---|---|---|
| 1 · Stampede | 100,000 concurrent buyers contend for seat A1 | **1 winner, 99,999 clean rejections, 0 errors** — 27,269 attempts/sec |
| 2 · Segment matrix | All 36 journey pairs vs an independent overlap oracle | all 36 agree |
| 2b · Segment resale | Seat sold Dhaka→Cumilla stays sellable Cumilla→Chattogram | resold; full corridor then correctly refused |
| 3 · Disjoint holds | Two holds own different segments of one seat at once | coexisted; releasing one left the other intact |
| 4 · Expiry race | Confirm vs sweeper at the same instant, 120 iterations | 97 confirmed / 23 expired, **0 ambiguous** |
| 5 · Idempotent confirm | 100 concurrent confirm replays | exactly 2 booking events (2 seats) |
| 6 · Multi-seat atomicity | 150 rounds, overlapping seat sets in opposite order | always exactly 1 winner, no partial holds, no deadlocks |
| 7 · Event reconciliation | Live masks vs masks replayed from the append-only log | agree on every seat |
| 8 · Sweeper | Expiry with no cache involved at all | reclaimed all 10 holds |
| 9 · Webhook storm | Same signed webhook delivered 200× concurrently | **1 payment, 1 confirmation, 2 tickets** |
| 10 · Verification chain | Bad signature / wrong amount / wrong currency / unknown booking | all 4 rejected, no state change |
| 11 · Ledger | 25 ticketed bookings, then one worked example | **variance 0 poisha; 0 journals unbalanced individually**; ৳1,200 splits to ৳1,182 / ৳18 / ৳1,035 / ৳165 exactly as the plan says |
| 12 · End to end | hold → book → webhook → confirm → ticket → QR | seat provably SOLD afterwards |

### Counter quota proofs

| Proof | Asserts | Result |
|---|---|---|
| A · Quota leaves sale | A reserved seat disappears platform-wide | website hold refused; release restores it exactly |
| B · Quota-only selling | Offline sale of a seat outside the quota | refused — including another counter's quota seat |
| C · Replay storm | 40 concurrent replays of one offline sale | **1 sale, 39 refused** |
| D · Segment-scoped quota | Quota on leg 1 vs a hold on leg 3 | coexist; overlapping journey blocked |
| E · Quota ceiling | A request above the per-counter cap | refused, nothing partially reserved |

### Agent wallet proofs

| Proof | Asserts | Result |
|---|---|---|
| 1 · Oversell | 1,000 concurrent purchases against credit for exactly 10 | **10 held, 990 clean refusals, 0 errors** in 206 ms |
| 2 · Idempotent capture | 50 concurrent captures of one hold | **1 sale row**, charged once |
| 3 · Idempotent release | 10 releases of one hold | spending power restored exactly once |
| 4 · Maker-checker | Self-approving a recharge | refused by the service **and** by the database CHECK |

### Promotion proofs

| Proof | Asserts | Result |
|---|---|---|
| 1 · Coupon cap | 1,000 different people redeem a coupon capped at 25, all at once | **exactly 25 claimed, 975 clean refusals, 0 errors** in 449 ms |
| 2 · Per-user limit | One person, 200 simultaneous attempts, limit 3 | **exactly 3 claimed** |
| 3 · Idempotent release | Claimed once, released five times | counter back to 0, allowance restored once |

### Event backbone proofs

| Proof | Asserts | Result |
|---|---|---|
| 1 · Relay idempotency | Relay, simulate a crash, relay again | **1 event in the log**, not 2 |
| 2 · Schema registry | An event missing a required field, and an unregistered type | **0 reached the log**; both parked with a reason |
| 3 · Poisoned event | 3 events, the middle one unprocessable | 2 delivered, 1 dead-lettered, checkpoint moved past it |
| 4 · Concurrent relays | 200 events, 8 relays racing the same outbox | **200 published exactly once, 0 left behind** |

### API suites

`scripts/smoke.mjs` — 38 checks. The passenger flow, plus: the account area
refuses an anonymous caller, a one-time code signs in, guest bookings are
claimed, and **a replayed refresh token revokes the whole family**.

`scripts/channels-smoke.mjs` — 79 checks across all six staff channels, ending
with the load-bearing one:

```
four channels, one seat, exactly one winner  — web=201 counter=409 agent=409 quota=409
```

`scripts/platform-smoke.mjs` — 70 checks. Highlights, all measured:

- the outbox is drained, every consumer group is at zero lag, nothing dead-lettered
- a booking confirmation is rendered and sent **in Bangla**, costed per message
- **a dead primary SMS aggregator does not drop the message** — `SSLWIRELESS:FAILED, BULKSMSBD:SENT` — and the primary is used again once it recovers
- **a blown notification budget suppresses operational traffic and still delivers a transactional message**
- a held seat reaches search **through the event stream**; the second identical search is served from cache
- three-way reconciliation detects five distinct exception classes from seeded files
- a dispatcher may watch the control centre and **is refused when they try to act**
- **a replayed signed partner request is refused**; an unsigned seat-moving request is refused
- a partner books through the same inventory and **loses the seat race to the website**
- a partner webhook is **signed, delivered over HTTP and verified at the far end** — `booking.confirmed → HTTP 200`
- **a risk rule that has never fired cannot be promoted to enforcement**
- the reporting store agrees with the transactional store

### Browser flows

Real Chromium sessions, clicks and keystrokes only — no direct API calls, so
they fail if an application is wired up wrongly even when the backend is perfect.

**Passenger** (`apps/web/scripts/browser-flow.mjs`, 33 checks) — search
`Dhaka → ctg` with the alias resolved, AC filter, price sort, a 36-seat map, hold
with countdown, sandbox payment, **PNR confirmed by webhook**, a real QR, ৳1,832
refund quote, cancellation, **both cancelled seats sellable again** — then
**signed out the account shows nothing**, a one-time code signs the passenger in,
and **the trip they booked as a guest is waiting for them**. No console errors.

**All six staff apps** (`apps/web/scripts/staff-flow.mjs`, 85 checks):

| Step | Result |
|---|---|
| One door, six workplaces | each account lands where the server says it works |
| Admin console | 12-account chart, **total debits = total credits** |
| Counter | **an offline shell installs, scoped to `/counter` only** |
| Counter sale | cash sale issues a ticket, and **the seat vanishes from the public website** |
| Counter offline | network genuinely cut; POS restricts to owned seats; sale queued |
| Reconnect | **queue replays by itself — "Synced 1 sale"**, no button pressed |
| Drawer close | **balanced to the taka** against the ledger |
| Agent portal | wallet reconciles to its log; sale issues a ticket with commission |
| Maker-checker | finance **cannot enter the agent portal**; a second person approves |
| Operator ERP | **one manifest carrying web + counter + counter-offline + agent** |
| Driver & crew | boarding scan clears a passenger; **the same ticket twice is caught** |
| Support console | timeline covers held → ticketed → boarded → **notified** |
| Event backbone | **unrelayed outbox 0**, 7 groups all at zero lag |
| Notifications | Bangla messages in the log; an aggregator taken down and brought back |
| Reconciliation | files imported, **three legs compared**, exceptions classified in plain words |
| Risk | rules listed with their mode and the p95 they cost the booking path |
| Partners | webhooks dispatched; the delivery log is visible |
| Control centre | live buses, how many are reporting a position, open alerts |
| RBAC | a Dispatcher is refused the ledger by URL; **and the control centre's buttons** |
| Console | no uncaught page errors |

Screenshots land in `apps/web/artifacts/screenshots/`.

The compose file disables `fsync` and `synchronous_commit`. That changes
throughput, never correctness — every invariant above is enforced by transactions
and constraints, which behave identically either way. Do not copy those settings
to production.

---

## How the seat lock works

A trip over N stops has N−1 segments. A journey from stop `b` to stop `d` occupies segment bits `b..d-1`:

```
mask(b,d) = (1<<d) - (1<<b)
```

On the Dhaka(0) → Cumilla(1) → Feni(2) → Chattogram(3) corridor:

```
Dhaka->Cumilla       mask(0,1) = 0b001
Cumilla->Chattogram  mask(1,3) = 0b110   ->  AND = 0    both sell on ONE seat
Dhaka->Feni          mask(0,2) = 0b011   ->  AND = 0b010  overlap, one winner
```

Acquisition is a single conditional `UPDATE` whose rowcount **is** the lock. There is no `SELECT` first:

```sql
UPDATE inventory.trip_seats
   SET segment_hold_mask = segment_hold_mask | $3,
       version           = version + 1
 WHERE trip_id = $1::uuid
   AND seat_no = $2
   AND (segment_hold_mask | segment_sold_mask | blocked_mask) & $3 = 0;
-- rowcount 1 = acquired.  rowcount 0 = someone owns an overlapping segment.
```

Multi-seat holds run this once per seat inside one transaction, in sorted seat order (deterministic lock ordering, so two overlapping requests can never deadlock), and roll back entirely if any seat fails. Segment resale is therefore arithmetic, not application logic.

The counter's offline quota is the same idea one step further. Reserving quota
sets bits in `blocked_mask`, which every channel already respects, so a quota
seat is invisible to the website for as long as the counter holds it. Selling it
moves those bits blocked → sold under a guard that requires they were blocked in
the first place:

```sql
UPDATE inventory.trip_seats
   SET segment_sold_mask = segment_sold_mask | $3,
       blocked_mask      = blocked_mask & ~($3::bigint)
 WHERE trip_id = $1::uuid AND seat_no = $2
   AND (blocked_mask & $3::bigint) = $3::bigint;
-- rowcount 0 = this counter never owned that seat. The sale is refused.
```

That guard is why a terminal replaying an hour of offline sales cannot sell a
seat it does not own, and why replaying the same sale forty times books once.

**The same shape appears everywhere something can be over-issued.** A limited
coupon, an agent's credit line, a partner's daily quota and a replacement bus's
seat move are all a conditional UPDATE whose rowcount is the verdict. That is
why 1,000 people redeeming a coupon capped at 25 produce exactly 25 redemptions.

### One correction to the written plan

`docs/DEVELOPMENT-PLAN.md` puts a `current_hold_id` column on `trip_seats`. **That is wrong and this repo does not do it.** Two different holds can legitimately own non-overlapping segments of the same physical seat, which a single-valued column cannot represent — it would silently corrupt segment inventory the first time it mattered. Ownership lives in `inventory.seat_hold_items`, keyed `(hold_id, seat_no)` with the exact mask. Proof 3 is the regression test.

---

## Layout

```
db/migrations/            applied by Postgres initdb on first boot
  001–006                 catalog, inventory, commerce, ledger, corridor seed
  007_channels.sql        staff+RBAC, counters/shifts/quota, agent wallets,
                          crew/boarding/GPS, settlements, maker-checker, support
  008_channels_seed.sql   roles, permissions, staff accounts, counters, agencies
  009_events_notify.sql   event log, schema registry, consumer groups, outboxes,
                          dead letters · notification templates/routes/providers
  010_identity_search.sql passenger auth, sessions, refresh families, guest
                          promotion · the search projection and locations index
  011_platform.sql        analytics facts · campaigns and referrals · the seven
                          alert types and replacement-bus remap · gateway and
                          bank files, reconciliation exceptions · partners,
                          quotas, webhook deliveries · risk rules, cases, blocks
  012_platform_seed.sql   14 new permissions and who holds them; coupon migration
  013_reschedule_money.sql  amount_due and reschedule_of, so a change moves money
  014_analytics_backfill.sql  seed the reporting store from existing bookings
  015_staff_mfa.sql       one-time codes are good exactly once
  016_corridor_capacity.sql  a second Green Line departure, so the fixture holds
  017_dhaka_today.sql     one definition of "today", and it is Dhaka's

services/
  inventory/inventory/    the ONLY code permitted to mutate seat state
  commerce/commerce/      booking, webhook verification, tickets, ledger,
                          cancellation, counter/agent settlement, reschedule
  staff/staff/            PBKDF2 auth, sessions, RBAC, audit, TOTP
  identity/identity/      passenger auth: OTP, password, refresh rotation, guest
  wallet/wallet/          agent wallet — ledger-backed, conditional-UPDATE holds
  events/events/          outbox relay, event log, consumer groups, dead letters
  notify/notify/          templates, routing, provider failover, cost, breaker
  searchidx/searchidx/    the search projection and the only query that reads it
  promo/promo/            campaigns with atomic caps, referrals
  recon/recon/            gateway and bank file import, the three-way match
  ops/ops/                alert detection, replacement bus, seat remap
  partner/partner/        request signing, quotas, webhook delivery and retries
  risk/risk/              five outcomes, shadow mode, blocks, review cases
  analytics/analytics/    event-sourced facts, live metrics, reports
  platform/cache/         a small Redis client — accelerator, never authority
  api/httpapi/            the REST surface: passenger, six channels, partner API
  api/eventwire/          binds consumers to services without coupling them
  api/tripgen/            schedule -> trips -> inventory (idempotent)
  api/cmd/api/            server + sweeper + relay + indexer + detector + dispatcher

apps/web/                 all seven applications (Next.js 16, React 19, TypeScript)
  app/                    passenger routes at the root; /counter /agent /operator
                          /admin /helpdesk /driver /staff for the six workplaces
  components/StaffShell   the staff chrome, nav and permission gate
  lib/api.ts              typed client for the passenger REST API
  lib/auth.ts             passenger sign-in, refresh rotation
  lib/staff.ts            bearer-token client that fails closed on 401
  lib/offline.ts          the counter's offline queue and quota cache
  public/counter-sw.js    the counter's offline shell — never caches the API
  scripts/                browser-flow.mjs (passenger) · staff-flow.mjs (six apps)

scripts/smoke.mjs           38-check passenger API flow
scripts/channels-smoke.mjs  77-check staff channel API flow
scripts/platform-smoke.mjs  69-check platform services flow
deploy/docker-compose.yml   Postgres + Redis + the proof runner
docs/                       the 44-week plan, and the original spec verbatim
```

`commerce` depends on an `InventoryClient` **interface**, not on inventory's
package; `ops` depends on a `SeatMover` interface; `notify` depends on a
`Resolver` interface and does not know how to read a booking; `identity` depends
on a `Courier` interface and does not know templates exist. In production those
are generated gRPC clients and the services share neither a process nor a
database. Go's `internal` rule enforces the first boundary at compile time — it
is what forced the interface to exist rather than an import.

---

## Design decisions worth knowing

**PostgreSQL is authoritative; Redis is an accelerator.** Hold expiry is a
PostgreSQL `expires_at` plus a sweeper using `FOR UPDATE SKIP LOCKED`. Redis
caches search results and counts rate limits. The asymmetry is deliberate: the
cache may refuse a request *earlier* than the database would, which under a
flood is the point, and can never let one through that the database would
refuse. Flush Redis entirely and no seat, hold or payment fact is lost.

**Idempotency is a database constraint, not an application check.**
`UNIQUE(provider, provider_txn_id)` collapses 200 concurrent duplicate webhooks
into one payment. `UNIQUE(event_id)` on the event log makes relaying idempotent.
`PRIMARY KEY (staff_id, code, step)` makes a one-time code single-use.
`UNIQUE(partner_id, nonce)` makes a signed request unreplayable. In every case
the insert **is** the check — an application "have I seen this?" lookup would
race the second copy.

**The browser never confirms payment.** `HandleWebhook` is the only path that
can, and it runs a fixed rejection-only chain: signature → currency → booking →
amount → idempotency → confirm seats → finalise.

**Money moves through the ledger, never around it.** Every channel lands in the
same `Finalise()`; what differs is only which accounts the money touches. A
reschedule reverses the old split and applies the new one rather than pricing
the fare twice. `finance.assert_journal_balanced` refuses an unbalanced journal
inside the transaction that writes the booking.

**A balance column is never the truth.** An agent wallet's `available_poisha` is
a cache that exists so a sale can be authorised in one statement;
`agent.wallet_transactions` is the truth. System health counts wallets that have
drifted.

**Outbox or it didn't happen.** A producer writes its event in the same
transaction as its state change, and a relay is the only thing that publishes.
An incident report and the message that raises it are one statement. A payment
and its `payment.success` event come from the same `RETURNING`.

**A schema registry, not a convention.** A topic declares its required fields.
An event that does not satisfy them is parked, counted on the health page, and
never delivered — so a consumer is never the first thing to discover that a
producer changed shape.

**Rules are data.** Permissions are `resource.action` strings and roles are rows
(61 permissions, 14 roles). Risk rules are rows with a mode. Notification
routing is rows. Cancellation tiers are rows. Creating "Regional Supervisor"
with exactly the rights it needs is an INSERT.

**Shadow mode is the default for anything that can refuse a customer.** A risk
rule is evaluated and recorded but enforces nothing until somebody promotes it,
and the server refuses to promote a rule that has never fired.

**A variance is never absorbed.** A counter drawer that does not match posts an
explicit Cash Variance entry. A reconciliation exception blocks settlement
approval and cannot be overridden.

**Some rules are database constraints rather than code.** `CHECK (approved_by <>
requested_by)` on approvals and recharges. A partial unique index for one open
drawer per counter, and another for one open alert of a kind per trip.
`CHECK (redeemed <= max_redemptions)` on campaigns. A service can forget to
check; a constraint cannot.

**Shard-readiness is structural.** `trip_seats`, `seat_holds` and
`inventory_events` are hash-partitioned by `trip_id` from the first migration,
and every statement in the inventory package carries `trip_id`.

**"Today" means today in Dhaka.** PostgreSQL's `current_date` is the date in the
database's timezone, which is UTC in most deployments — six hours behind the
country this platform sells in. Between midnight and 06:00 local time the two
disagree, and a driver at half past midnight was shown a trip window that had
silently slipped a day, hiding the departure they were about to drive. Every
"today" now goes through `catalog.bd_today()`, so there is one definition and
one place to change it.

---

## What is NOT built

Measured against the 44-week plan this is Phase 1 essentially complete, most of
Phase 2, and the ecosystem and fraud slices of Phase 3.

**Not started at all** — the Flutter mobile apps (passenger and driver), real
Kafka / OpenSearch / ClickHouse clusters, white-label tenancy, every AI feature
(support agent, voice booking, operator assistant), demand forecasting and
dynamic pricing, multi-region and disaster recovery, and inventory sharding.

**Deliberately interim, and load-bearing if you scale this**

- **The infrastructure is substituted, not absent.** The event backbone, the
  search index and the analytics store all implement the contract the plan
  specifies — envelope, registry, consumer groups, dead letters, a projection
  read model, an event-sourced fact table — on PostgreSQL. Each is a one-file
  swap to Kafka, OpenSearch and ClickHouse, and each is stated as a substitution
  in the migration that creates it rather than passed off as the real thing.
- **Nothing physically leaves the building.** A "sent" SMS lands in
  `notify.outbound_sink`. The routing, the language, the failover, the per-message
  cost, the budget breaker and the delivery log are all real; the aggregator is
  not, because there is no contract behind it.
- **Payments are sandbox-only.** No bKash or Nagad integration exists; the
  provider is a signed stand-in that exercises the real webhook path.
- **The reconciliation files are generated from our own payments.** The matcher,
  the eight exception classes, the ageing and the settlement block are real. The
  gateway file and the bank statement are produced with deliberate faults seeded
  into them, because there is no aggregator sending real ones.
- **Staff MFA is real but not mandatory.** The plan requires TOTP for every staff
  account. It is implemented, enforced at sign-in and single-use — but it is
  opt-in per account, because forcing it on the demo fixtures would make this
  harness unusable.
- **The risk engine has never seen real abuse.** Its rules are written against
  synthetic traffic, which is exactly what the plan says not to trust — four of
  the six are in shadow mode for that reason.
- **GPS is driver-app only.** Hardware trackers and third-party GPS providers
  both go through the same Location Gateway shape, but neither is integrated.
- **No push notifications.** There is no mobile app, so no device token exists;
  PUSH deliveries are skipped visibly in the log rather than silently.
- **The partner API has no rate limiter per minute.** Daily quotas are enforced;
  the per-minute rate is stored and not applied.

**Next step per the plan:** the plan's own Phase 3 order — the AI support agent
behind the read-only tool gateway, then forecasting on the data the pilot would
now be producing, then the scaling ladder. See `docs/DEVELOPMENT-PLAN.md`.

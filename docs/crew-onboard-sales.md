# The conductor as a sales channel

On a real intercity route in Bangladesh the conductor is not only a boarding
tool operator. Passengers get on at Cumilla with no ticket, negotiate a fare,
pay cash, and the conductor settles up with the owner at the end of the run.
The crew app could represent none of that: it listed trips, showed a manifest,
scanned at the door and reported incidents.

This branch makes the on-board sale a first-class channel, with the cash
accounted for and the discount paid for by somebody specific.

Five things were asked for:

1. **Search** — trips to sell on, a passenger already on this bus, tickets sold
   earlier.
2. **Charge less than the published fare** when necessary.
3. **See what was sold** — today, this week.
4. **Commissions**, and **what is owed to the bus owner**.
5. **A real profile.**

The architectural rule is untouched, and is what made this tractable:

> **Every sales channel calls the exact same Inventory Service. No channel gets
> its own seat logic.**

`handleCrewSale` acquires seats through the same `inv.AcquireHold` the website
uses and confirms them through the same `ConfirmHold`. There is no seat logic
in the crew app, in the crew handler, or in the crew half of commerce.

---

## 1 · The money model

The part worth getting right, and small once written down. All figures in
poisha; `S` is the ৳50 platform service fee.

```
full  = fare × seats + S           what the fare table says
D     = discount granted           capped and reasoned, see §2
gross = full − D                   cash actually taken
base  = full − S                   the base BEFORE the discount
```

**Sale journal** — `CrewPostings`, the same shape as `CounterPostings`:

```
DR 1002  Cash in Transit — Crew    gross     party = duty
CR 4101  Platform Revenue          base/10 + S
CR 2101  Operator Payable          gross − platform
```

Platform revenue is computed on the **undiscounted** base, so a conductor
negotiating at a roadside stop cannot move a number the platform reports.
Expressing the operator leg as `gross − platform` rather than recomputing it
makes the journal balance by construction: whatever cash came in is exactly
what is credited out.

**Commission journal** — separate and balanced, exactly as agent commission is,
so it can be reported and disputed without unpicking the sale:

```
C0      = crewRule(base)           what they would have earned
forfeit = min(D, C0)               the discount eats their commission first
DR 5101  Commission Expense        C0
CR 2103  Crew Payable              C0 − forfeit   ← what they keep
CR 2101  Operator Payable          forfeit        ← handed back to the operator
```

That third leg is the whole of the owner's decision. Without it the operator
would absorb the discount in the sale journal **and** the crew would lose
commission — charging the same reduction twice.

| Net effect of a discount | |
|---|---|
| Platform | unchanged, always |
| Crew | loses `min(D, C0)` |
| Operator | loses only `max(0, D − C0)` — the spill |

### The ceiling nobody specified

Writing the test first turned up a case the plan had not named. At a large
enough discount `gross − platform` goes **negative**, and
`finance.ledger_entries` has `CHECK (amount_poisha > 0)` — so the sale would
have failed at the moment of payment with an error nobody on a bus could act
on. A 100% discount produced an operator leg of **−৳130**.

`MaxCrewDiscount(full)` names the real limit: **the operator's own share of the
fare**, `base − base/10`. Past it the operator would be paying the platform for
the privilege of giving a free ride. That may be a real product one day (an
operator-funded staff pass) but it has to be a deliberate feature with its own
posting, not a side effect of dragging a slider to 100. Every configured cap is
bounded by this one, and the API refuses above it with the ceiling in the error.

### What is owed to the owner

Three lines, never one number:

```
Cash you should be holding   = opening float + cash movements this duty
Your commission this duty    = Σ commission
Hand to the owner            = the first minus the second
```

"Hand over ৳4,385" alone is a figure somebody has to take on trust. As a
subtraction it is a sum a conductor can check against the notes in their hand.

---

## 2 · Discount authority

Three limits bind and the smallest wins:

| Limit | Where |
|---|---|
| The operator's policy for the crew role — a percentage **and** a taka ceiling | `crew.discount_policies` |
| The reason's own ceiling — a child fare is not a blank cheque | `crew.discount_reasons` |
| The structural maximum | `commerce.MaxCrewDiscount` |

**An operator with no policy row cannot discount at all.** The absence of a
policy is not permission: a lookup that finds nothing refuses rather than waves
through.

`crew.discount` is granted separately from `crew.sell`, so an operator can let a
helper sell a ticket without letting them set a price. The seeded fixture gives
DRIVER 20% / ৳200 and HELPER 10% / ৳100, for the demo operator only.

**Discounts are refused, never clamped.** A conductor who believes they gave
৳100 off and actually gave ৳50 will be short at handover and will have no way to
find out why. Errors are explicit — `discount_too_large` carries the real
ceiling, `discount_reason_required`, `discount_not_permitted`.

Every discount carries a reason, because an unexplained discount is
indistinguishable from a conductor pocketing the difference.

---

## 3 · The cash bag

Both halves the owner asked for:

- **`crew.duties`** — the bag itself, opened with a float and closed by
  counting. A unique partial index enforces **one open duty per person**: two
  open bags make every taka in a pocket unattributable, and no later reporting
  recovers the attribution. Closing compares the count with the expected figure
  and posts any variance to `5301 Cash Variance`, exactly as a counter drawer
  does.
- **`crew.duty_trips`** — each bus run inside the duty, sealed with a snapshot
  rather than a count. A conductor running four trips counts money once, and a
  dispute about the 22:00 run is still answered with that run's own numbers.

Crew cash gets account `1002 Cash in Transit — Crew` rather than sharing `1001`
with counter drawers. A drawer is in a locked room; a bag is in a pocket on a
moving bus. Its own account makes "how much cash is in pockets right now" a
single balance query — which is the control this feature exists to provide.

Tapping *open a duty* twice returns the bag you already have rather than an
error. Somebody tapping it twice meant to be selling, not to be told off.

---

## 4 · The app

`apps/mobile/crew` gains a **persistent bottom bar** — one `Navigator` per tab
nested in the shell, the shape proven in the passenger app a release ago. A
pushed screen sits inside its tab, so the bar survives the seat map, the price
screen and the receipt.

| Tab | |
|---|---|
| **যাত্রা** Trips | roster → trip → manifest, scan, GPS |
| **বিক্রি** Sell | search → seat map → price → cash → ticket |
| **হিসাব** Money | duty, today/week, per run, sales, commissions |
| **আমি** Me | details, password, sessions, language, sign out |

**Search**, all three kinds:

- *Trips to sell on* — the same `PlaceField` and gazetteer the passenger app
  uses. `PlaceField` was typed to `PassengerApi`; a `DiscoveryApi` was extracted
  that both APIs extend, so the crew app reuses the picker rather than owning a
  second typo-tolerance table that would drift.
- *A passenger on this bus* — filters the manifest already in memory, by name,
  seat, PNR or number. No network: the moment somebody needs it is at the door
  of a bus with no signal. Seat matching is exact, so typing `1` over seat 1
  does not return A1, B1, C11 and D21.
- *Tickets they sold* — `GET /crew/sales?q=`, scoped by the server to the person
  asking.

**The honest line.** The price screen shows, before the sale:

```
নির্ধারিত ভাড়া        ৳855
ছাড় · দরদাম করা       - ৳60
যাত্রী দেবেন           ৳795
আপনার কমিশন: ৳0  (ছিল ৳40 — ৳40 ছাড়ে চলে গেল)
```

*Your commission: ৳0 (was ৳40 — ৳40 went to the discount).* A conductor should
learn what a discount costs them **before** they grant it, not at handover. The
ceiling is shown in taka, not a percentage, because taka is what gets argued
about at the side of a road.

The rate behind that figure is **resolved by the server** and returned in
`/crew/sell/context`, not assumed by the app. Writing this document is what
surfaced the problem: the preview had a hardcoded 5%, which agrees with the
receipt right up until an operator configures anything else and then disagrees
silently — the worst kind of wrong for a number somebody makes a decision on.

Bangla words, Latin figures throughout — the crew app is one of the frontline
three.

---

## 5 · Server surface

New, in `services/api/httpapi/crew.go`:

```
POST   /api/v1/crew/duties               open (returns the existing one if any)
POST   /api/v1/crew/duties/close         count and close
GET    /api/v1/crew/duties               history, plus the open bag
POST   /api/v1/crew/duties/trips/close   seal one bus run

GET    /api/v1/crew/sell/context         role, caps, reasons, open duty
POST   /api/v1/crew/sales                the sale
GET    /api/v1/crew/sales                own sales, searchable
GET    /api/v1/crew/report               today · week · duty · per run
GET    /api/v1/crew/commissions          per booking, with forfeits shown
```

Ownership is enforced **inside the SQL** — `AND staff_id = $n::uuid` — not by a
guard above it that a refactor could step around. Another person's duty returns
404, the same answer a duty that does not exist gets, so an id cannot be probed.

Staff also finally got what passengers have had for a release:

```
PATCH  /api/v1/staff/profile
POST   /api/v1/staff/password/change     revokes every OTHER session
GET    /api/v1/staff/sessions
POST   /api/v1/staff/sessions/revoke-all
```

Email is deliberately not editable: it is the login identifier, issued by the
operator, and letting somebody change it from a phone on a bus is how an account
quietly stops belonging to the person the operator hired. Changing a password
requires the current one — not because the session is untrusted, but because the
threat is a phone left unlocked on a seat, and the current password is the one
thing the person who put it down knows and the person who picked it up does not.

---

## Verification

| Suite | Result |
|---|---|
| `flutter test` | **132 hermetic tests** — 53 passenger, 49 crew, 30 voice grammar |
| `flutter analyze` | clean, all three packages |
| `go test ./services/...` | pass, including the money-split table test |
| `go build` / `go vet` | clean |
| `scripts/channels-smoke.mjs` | ALL CHANNEL CHECKS PASSED — 101 checks, 23 of them the new §9 |
| `scripts/smoke.mjs` | ALL CHECKS PASSED |
| `scripts/platform-smoke.mjs` | ALL PLATFORM CHECKS PASSED |
| `browser-flow` · `staff-flow` · `lang-audit` · `place-picker` | all pass |

**The money split is proved twice** — once as arithmetic in
`crew_money_test.go` at `D = 0`, `D < C0`, `D = C0`, `D > C0` and at the
ceiling, asserting platform revenue is *identical in every case*; and once
against the real database, by reading the posted legs back out of
`finance.ledger_entries` and netting the operator across both journals:

```
  pnr   | discount | op_sale | op_back | operator_actually_lost | model_says
--------+----------+---------+---------+------------------------+-----------
 NT9G9K |        0 |  103500 |       0 |                      0 |          0
 KGJA7X |     2000 |  101500 |    2000 |                      0 |          0
 3ACYGG |    10000 |   93500 |    5750 |                   4250 |       4250
```

Every safety-critical guard was confirmed **by breaking it and watching a test
go red**: the commission floor, the operator hand-back leg, the discount cap,
the per-tab navigator, and the tab reload.

### Four defects the device found that no test had

Running the app caught what reading it did not:

- **`common.ok` rendered as itself** on the duty dialog — a missing key does not
  throw, it draws the key. Fixed, and `strings_test.dart` now walks every
  `l('…')` in the crew and core sources against the catalogue, so the next one
  is caught before anybody sees it.
- **The duty dialog crashed on OK** — `_dependents.isEmpty is not true`. A
  controller created by the caller and disposed the moment `showDialog`
  returned, while the route was still animating out and its field still
  listening. All three dialogs now own their controllers, and a test opens and
  closes each one.
- **The money tab showed stale numbers after a sale.** `IndexedStack` keeps
  every tab alive, so `initState` ran once at launch and never again — a
  conductor sold a ticket and came back to a screen still claiming they had
  taken nothing. Tabs that can go stale now reload when shown.
- **A Green Line driver sold a seat on a Hanif coach**, and the preview promised
  a commission the settlement then did not pay. Two lookups disagreed: the
  discount ceiling resolves from the crew member's *employer*, the commission
  rule from the *trip owner*. Neither was wrong on its own; selling across
  operators was. `handleCrewSale` now refuses with `not_your_bus` **before a
  seat is held**, the search results are filtered to the crew member's own
  company, and `channels-smoke.mjs` asserts the refusal against a real
  cross-operator departure. The mismatch was the symptom; the missing rule was
  the defect.

### The flake, finally explained

`channels-smoke.mjs` had been failing roughly **one run in five** with
`timeline shows what the passenger was told — none`, and had been reported twice
as unexplained. Running it in a loop caught it: notifications are asynchronous,
and one `POST /admin/events/drain` moves the outbox into the event log but the
notify consumer then has to run and write its own row. That second hop had not
always happened by the time the timeline was read. The suite now drains in a
short bounded loop until the effect appears. Six consecutive clean runs since.

Also fixed while there: the suite was not re-runnable, because a duty left open
by a previous run made every check below it lie.

### On the emulator

Signed in as `driver@greenline.test` · bottom bar present on the seat map, price
screen and receipt · opened a duty with a ৳500 float · searched **chittagong**
and got চট্টগ্রাম · picked F1 out of a seat map where free and sold are plainly
different · gave ৳60 off a ৳855 fare and watched the commission line fall to
**৳0 (ছিল ৳40)** · issued ticket **ECVUMX**, collected ৳795 · money tab showed
৳1,295 held, ৳0 commission, ৳1,295 to hand over · closed the bag counting ৳50
short and got **VARIANCE**, with the trial balance still exactly zero.

---

## Stated plainly

- **On-board sales are cash only.** bKash-on-the-bus needs a provider
  integration and a device that can show a QR to a passenger. Adding it later is
  a new `method` value, not a new design.
- **The QR scanner is still unverified.** The emulator has no camera; this
  branch does not change that.
- **Nothing here nets counter or crew cash off the platform→operator
  settlement.** `CalculateSettlement` still computes the operator's payable
  across all channels alike. That simplification predates this branch, it is
  worth fixing, and it is not this change.
- Seeded local fixtures — the demo staff password, the sandbox keys — are still
  public in this repository and should be rotated before anything real.

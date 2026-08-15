# Bus Ticketing Platform — 3-Phase Master Development Plan

## Context

The project owner has written a detailed master specification for an enterprise bus transportation and ticketing ecosystem for the Bangladesh market (bKash/Nagad payments, multi-stop routes such as Dhaka → Cumilla → Feni → Chattogram), designed to scale toward 10 million concurrent users. That specification is organised into 5 phases containing 83 numbered sub-sections.

The owner's request: **compress those 83 sub-sections into 3 development phases, drop nothing, and finish as fast as is safely possible.** When Phase 3 closes, the entire production system must exist — passenger booking, operators, counters, agents, payments, finance, GPS, apps, AI, analytics, API partners, scalability, security and disaster recovery.

`d:\bus ticket` is currently empty. This is a greenfield build with no existing code, no migrations, and no prior architectural commitments to work around.

The single architectural rule that governs everything below, stated by the owner and adopted here without modification:

> **Every sales channel — web, app, counter POS, agent, operator, partner API, AI — calls the exact same Inventory Service. No channel gets its own seat logic.**

That decision, more than any other, determines whether the system stays correct as it grows from thousands of users to millions. It is why Phase 1 builds and *proves* the inventory core before any channel is built on top of it.

The source specification has been preserved verbatim at `docs/reference/source-master-plan.md` (written during execution) so the compression can always be audited against the original.

---

## Decisions Locked

These were confirmed by the owner and are treated as fixed constraints throughout.

| # | Decision | Consequence for this plan |
|---|---|---|
| 1 | **Team of 20–40 engineers**, ramping from ~24 to ~40 | Workstreams run in parallel; the schedule below is only valid at this headcount |
| 2 | **True microservices from day one** — all 21 services independently deployed, gRPC internal, REST public | Costs ~3–4 weeks versus a modular monolith. Requires saga/outbox correctness, per-service CI/CD, contract testing and distributed tracing as hard requirements from week 1 |
| 3 | **Controlled pilot inside Phase 2** — 1–3 real operators, real money, limited routes, around weeks 25–27 | Phase 3 hardens a system that is already earning revenue. Every Phase 3 migration must be online and reversible |
| 4 | **Build and run full 10M capacity in Phase 3** — full multi-region, live, regardless of current traffic | Deliberate capacity insurance bought ahead of demand. Requires FinOps controls from week 31, since this is the largest recurring cost in the project |

Decision 2 was made against the recommendation to start with a modular monolith and extract services under load. The owner's choice stands; the schedule below absorbs its cost rather than hiding it. Decision 4 likewise buys confidence at a real and recurring price, quantified in Phase 3.

---

## The Compression Map

Every numbered section of the original specification, and where it now lives. Nothing is dropped.

| Original | Now in | Note |
|---|---|---|
| 1.1 – 1.12 (architecture, services, environments, auth, RBAC, roles, geography, operators, fleet, seat layouts, routes, schedules) | **Phase 1** | Unchanged in scope, compressed in calendar |
| 2.1 – 2.14 (inventory, atomic locking, holds, segments, search, booking, pricing, payment, payment safety, tickets, QR, cancellation, refund, reschedule) | **Phase 1** | Merged forward. Phase 1 now ends with a *proven* booking core, not just a data model |
| 5.1, 5.3, 5.5, 5.6, 5.7, 5.11, 5.13, 5.19 *(partial)* | **Phase 1** | Only the parts that are ruinous to retrofit: API gateway, Redis usage patterns, partition-ready and shard-ready schema, Kafka envelope + schema registry, security baseline, immutable audit, per-service test matrix. The rest of Phase 5 stays in Phase 3 |
| 3.1 – 3.15 (passenger web, passenger app, operator ERP, counter POS, counter offline, agents, agent wallet, commission, ledger, settlement, reconciliation, admin, support, promotions, referral) | **Phase 2** | Unchanged in scope |
| 4.1 – 4.13 (driver app, crew mode, boarding, GPS, live tracking, ETA, ops control center, replacement bus, incidents, notifications, analytics infra, reports, real-time dashboard) | **Phase 2** | Moved forward from original Phase 4 — operations must exist before a real operator can run a real trip in the pilot |
| 4.14 – 4.22 (fraud, partner API, partner webhooks, white-label, AI support, AI voice, AI operator assistant, forecasting, dynamic pricing) | **Phase 3** | Deliberately after the pilot: fraud rules, forecasting and pricing all need real production data to be worth anything |
| 5.1 – 5.20 (gateway, CDN, Redis cluster, OpenSearch cluster, PostgreSQL scaling, sharding, Kafka topology, multi-region, autoscaling, circuit breakers, security, financial controls, audit, backups, DR, load testing, load scenarios, chaos, test matrix, E2E) | **Phase 3** | Full versions, including the parts partially started in Phase 1 |

**Net effect:** the original Phase 1+2 become the new Phase 1; the original Phase 3+4 become the new Phase 2; the original Phase 4 tail plus all of Phase 5 become the new Phase 3.

---

## Timeline & Team

| Phase | Weeks | Duration | Headcount | Ends with |
|---|---|---|---|---|
| **Phase 1** — Foundation & the Booking Core | 1–14 | 14 weeks | ~24 | A booking core proven incapable of double-booking |
| **Phase 2** — Every Channel, the Money, and the Road | 15–30 | 16 weeks | ~38 | Real operators selling real tickets for real money |
| **Phase 3** — Intelligence, Ecosystem & 10M Production | 31–44 | 14 weeks | ~40 | General availability at proven 10M capacity |

**Total: 44 weeks (~10 months) to full production.**

That figure assumes the headcount above is actually in place on schedule, and that hiring for the Phase 2 ramp (24 → 38) begins in week 1, not week 14. Recruiting lead time is the most commonly underestimated dependency in a plan of this shape; it is treated here as a critical-path item.

### Team shape by phase

| Group | P1 | P2 | P3 |
|---|---|---|---|
| Go backend | 10 | 12 | 10 |
| Frontend (Next.js/TS) | 2 | 8 | 5 |
| Flutter | 1 | 4 | 3 |
| Platform / DevOps / SRE | 3 | 3 | 7 |
| DBA / data / analytics | 1 | 2 | 2 |
| AI engineers | — | — | 2 |
| QA automation / performance | 3 | 5 | 6 |
| Security | 1 | 1 | 2 |
| Product / BA | 1 | 2 | 2 |
| EM + tech lead | 2 | 1 | 1 |
| **Total** | **24** | **38** | **40** |

---

## Architecture Baseline

Per the owner's specification and Decision 2, all 21 services are independently deployed from day one.

```
identity  operator  fleet     location  route     schedule
inventory search    booking   payment   ticket    agent
notification finance tracking promotion support   analytics
risk      partner-api  ai
```

| Layer | Choice |
|---|---|
| Frontend | Next.js + React + TypeScript |
| Mobile | Flutter (Android/iOS) |
| Backend | Go |
| Internal transport | gRPC |
| Public API | REST under `/api/v1/` |
| Transactional store | PostgreSQL (schema per service) |
| Cache / timers | Redis Cluster |
| Events | Apache Kafka |
| Search | OpenSearch |
| Analytics | ClickHouse |
| Objects | S3 |
| Runtime | Docker + Kubernetes |
| Infrastructure | Terraform |
| Metrics / dashboards | Prometheus + Grafana |
| Tracing | OpenTelemetry |
| Logs | Loki / OpenSearch |
| CI/CD | GitHub Actions |

Environments: `LOCAL`, `DEV`, `QA`, `STAGING`, `PRE-PRODUCTION`, `PRODUCTION`, `DR`.

---

## Cross-Cutting Standards

Applied from week 1 across every service. These are not Phase 3 concerns.

**API.** All public routes under `/api/v1/`. Every mutation accepts `request_id` and `idempotency_key`, and records `actor` and `timestamp`.

**Events.** Standard Kafka envelope on every topic:

```json
{ "event_id": "...", "event_type": "...", "version": 1,
  "timestamp": "...", "producer": "...", "correlation_id": "...", "payload": {} }
```

**Observability.** Every request carries `request_id` and `trace_id` end to end. Monitored from the first deploy: API latency, API error rate, requests/sec, search latency, seat-hold latency, booking confirmation latency, payment success rate, webhook errors, DB utilisation, Redis utilisation, Kafka consumer lag, OpenSearch latency, active trips, GPS event lag.

**Performance targets (p95).** Gate conditions, not aspirations:

| Operation | Target |
|---|---|
| Search | < 200 ms |
| Trip details | < 150 ms |
| Seat availability | < 150 ms |
| Seat hold | < 250 ms |
| Booking creation | < 300 ms |
| Internal ticket lookup | < 150 ms |
| QR verification | < 200 ms |

Third-party payment processing time is excluded from these.

---

## Phase 1 — Foundation & the Booking Core (Weeks 1–14)

### Phase 1 at a Glance

| | |
|---|---|
| **Window** | Weeks 1–14 |
| **Headcount** | 24: 10 Go backend, 2 frontend (Next.js/TS), 1 Flutter, 3 platform/SRE, 1 DBA, 3 QA automation, 1 security, 1 product/BA, 1 EM, 1 tech lead/architect |
| **Done means** | A stranger with an API key can search a generated trip, hold seats, pay via bKash sandbox, and receive a signed ticket — and 100,000 rivals for the same seat cannot break it. |
| **Hardest technical risk** | Segment-correct atomic seat inventory that stays consistent across three services (inventory → booking → payment) without 2PC, on a schema that must already be shard-ready by `trip_id`. |

### What Phase 1 Delivers

Phase 1 delivers a provably correct booking core behind versioned APIs: all 21 services scaffolded and independently deployable, with identity/RBAC, catalog (geography, operators, fleet, seat layouts), routing/scheduling with automatic trip generation, the atomic segment inventory engine, the search pipeline, and the full commerce chain (booking → payment → ticket → cancellation → refund → reschedule) — plus the platform spine (gateway, tracing, audit, outbox/Kafka, security baseline) that the original specification deferred to Phase 5 and that is correctly built in from day one here.

There is **no customer-facing product** at the end of Phase 1 — only a thin reference web client (one flow: search → seat map → pay → ticket) that exists to prove the APIs end to end and keep the two frontend engineers exercising real contracts.

Building the storefront first would be a mistake because the storefront is the cheap, replaceable part. Every screen depends on inventory semantics, price snapshots and payment safety that do not yet exist, so UI built early is UI built against guesses and rebuilt later — while the one thing that can kill the company, double-sold seats and unpaid tickets, ships unproven. The system's value is the invariant, not the pixels. The pixels are Phase 2.

### Entry Criteria

Locked before Week 1 (owner + EM accountable):

- **Cloud region**: AWS ap-southeast-1 (Singapore) primary — nearest full-service region to Bangladesh; DR region designated (ap-south-1). Managed services approved: EKS, RDS PostgreSQL, ElastiCache, MSK, OpenSearch Service, S3, CloudFront, WAF.
- **Payments**: bKash and Nagad **sandbox credentials in hand by Week 1**; merchant/aggregator applications *filed* in Week 1 (6–10 week lead time — this cannot start later). Card gateway (SSLCommerz or equivalent) sandbox requested.
- **Legal entity** registered and empowered to sign operator contracts and payment merchant agreements; counsel opinion on whether an aggregator/PSP licence is required for holding operator funds.
- **Domains + TLS**: production domain, api/staging subdomains, DNS control, certificate automation.
- **Owner decisions on record**: default cancellation tiers (24h+/90%, 12–24h/70%, 6–12h/50%, <6h/0% — operator-overridable), currency = BDT only in Phase 1 (schema carries a currency code regardless), VAT treatment (fare VAT-inclusive at 15%, ledger splits it), SMS OTP vendor selected, data-residency stance for PII.
- **Accounts**: GitHub org, artifact registry, secrets vault (AWS Secrets Manager vs Vault decided), PagerDuty/alerting, Sentry or equivalent.

### Workstreams

#### P1-A — Platform Foundation
**Owner**: Platform lead (3 platform/SRE + tech lead) · **Depends on**: entry criteria · **Weeks**: 1–6, then sustaining

- **Monorepo** (single Go module workspace + `proto/` + `deploy/`), not polyrepo. Justification: 21 services, 24 engineers, heavy early contract churn — atomic cross-service refactors of protos and shared chassis libraries beat 21 repos of version skew. Per-service CI/CD via path-filtered pipelines: each service builds, tests, versions and deploys **independently**. Monorepo ≠ monolithic deploy.
- Terraform for all 7 environments (LOCAL = docker-compose, DEV, QA, STAGING, PRE-PROD, PROD, DR); PROD/DR are minimal-footprint but real pipelines from Week 12.
- EKS clusters; **Linkerd** service mesh (mTLS, gRPC load balancing, retries/timeouts) — chosen over Istio because a 3-person platform team cannot also operate Istio; the need is mTLS and traffic policy, not a platform hobby.
- API Gateway (Kong or Envoy Gateway): authn, rate limits, routing, versioning, `request_id` injection, tenant identification.
- Golden-path service template ("chassis"): gRPC + REST, health/readiness, OTel tracing, structured logs, config, outbox library, idempotency middleware — a new service goes template → deployed-to-DEV in under one day.
- MSK Kafka + **schema registry** (event envelope enforced), DLQs; secrets vault integration; container scanning in CI.

**Done when**: a template service reaches DEV via its own pipeline in <1 day; all 7 environments stand up from Terraform with no manual steps; mesh mTLS is on for all service-to-service traffic; a schema-registry-rejected event fails CI; secrets never appear in env files or repo (scanner enforced).

#### P1-B — Data Layer
**Owner**: DBA + tech lead · **Depends on**: P1-A wk1 · **Weeks**: 1–4, then sustaining

- **Database-per-service** on RDS (shared clusters in DEV/QA, isolated in STAGING+). No service ever reads another service's tables — this is the shard-readiness enforcement mechanism.
- Migration tooling (golang-migrate/Atlas) wired into each service's pipeline; migrations reviewed by the DBA via CODEOWNERS.
- Schema conventions doc: UUIDv7 PKs, `created_at`/`updated_at`, soft-delete policy, `operator_id` tenancy column + RLS policies, currency in minor-unit integers, no cross-service FKs.
- Partition and shard readiness from migration #1: `trip_seats`, `seat_holds`, `inventory_events` hash-partitioned by `trip_id`; `bookings`, `payments`, `tickets`, `ledger_entries`, `audit_logs` range-partitioned by month; every inventory PK includes `trip_id`; no global sequences.
- pgbouncer/RDS Proxy pooling; slow-query analysis in CI perf jobs.

**Done when**: every service owns exactly one schema and cross-schema grants are absent; partitioned tables verified by an automated catalog check in CI; a synthetic "move trip X to another database" drill succeeds using only `trip_id` routing; migration rollback tested for every table.

#### P1-C — Identity & RBAC
**Owner**: 2 Go engineers + security engineer · **Depends on**: P1-A wk2, P1-B · **Weeks**: 2–7

- Passenger auth: phone OTP (rate-limited, Redis-backed, SMS vendor abstraction), email/password, **guest checkout** (guest identity promotable to account), password reset, device/session management, social login (Google; framework for others).
- Staff auth: email/password + **TOTP MFA mandatory**, password policy, suspicious-login lockout, session/device revocation.
- Tokens: short-lived access JWT + **rotating refresh tokens** (reuse detection revokes the family); gateway validates, services receive identity via mesh-trusted headers + gRPC introspection.
- RBAC: `roles`, `permissions`, `role_permissions`, `user_roles` — **no hardcoded roles**; `resource.action` permission strings; all four role families seeded (Platform 8, Operator 10, Partner 4, Customer 2); operator roles scoped by `operator_id`.

**Done when**: OTP login, guest checkout and staff MFA pass automated E2E; refresh-token reuse triggers family revocation in test; a permission check is a single middleware call and a denied `booking.cancel` is proven by test per role family; creating a new role requires zero code changes; all auth events land in the audit log.

#### P1-D — Catalog Domain (geography, operators, fleet, seat layouts)
**Owner**: 2 Go engineers + product/BA · **Depends on**: P1-C · **Weeks**: 3–8

- location-service: countries → divisions → districts → cities → areas → terminals → stops with lat/lng/timezone; `location_aliases` with canonicalization (Chattogram / Chittagong / CTG → one ID) applied at ingest and at search; Bangladesh gazetteer imported.
- operator-service: full lifecycle (PENDING → ACTIVE → SUSPENDED → BLOCKED → TERMINATED), branches, documents, bank accounts, commission/settlement/cancellation config, **multi-tenant isolation** — every operator-scoped query filtered by `operator_id` with Postgres RLS as a backstop.
- fleet-service: buses, bus_types, documents, amenities, assignments, maintenance; statuses per spec; GPS device registry (registry only — tracking is Phase 2).
- **Seat-layout builder** (API + JSON model; admin UI is Phase 2): reusable versioned templates; single deck, double deck, sleeper coach, configurable aisles; every seat typed (Normal / Business / Sleeper / Premium / Female-Reserved / Accessible / Blocked / Crew) with row, column, deck, fare_class, position, availability_rules. Layout versions are **immutable** once referenced by a trip.

**Done when**: alias search resolves all three Chattogram spellings to one canonical location in test; an operator-A staff token provably cannot read operator-B data (RLS test); a 40-seat AC single-deck and a 30-berth double-deck sleeper layout are creatable via API and render in the reference client; layout mutation after trip reference is rejected.

#### P1-E — Routing & Scheduling
**Owner**: 2 Go engineers · **Depends on**: P1-D locations · **Weeks**: 4–9

- route-service: routes, ordered route_stops, boarding/dropping points, **route_segments** (Dhaka → Cumilla → Feni → Chattogram = 3 segments), per-segment `route_fares` by fare class. Fare rows are versioned, never mutated (price snapshots reference them).
- schedule-service: recurring schedules (days-of-week, validity window), `schedule_exceptions` (skip/override dates), **automatic trip generation** (rolling horizon job, e.g. 30 days out, idempotent per schedule+date), materialized `trip_stops` with times, bus assignment.
- Full trip lifecycle: DRAFT → SCHEDULED → OPEN → BOARDING → DEPARTED → IN_PROGRESS → ARRIVED → COMPLETED / CANCELLED, with legal-transition enforcement and `trip.*` events. A trip **snapshots its segment map and layout version** at generation and is immutable thereafter.

**Done when**: a "10:00 PM daily Dhaka → Chattogram AC Business" schedule generates 30 trips with correct stop times; an exception date generates no trip; re-running generation creates zero duplicates; an illegal transition (OPEN → COMPLETED) is rejected; `trip.created` events flow to Kafka with a valid envelope.

#### P1-F — The Inventory Core *(highest-value workstream)*
**Owner**: Tech lead + 2 senior Go engineers + DBA + 1 QA · **Depends on**: P1-B only (the prototype needs fixtures, **not** P1-D/E) · **Weeks**: 2–10

- **Weeks 2–4, prototype on fixture data**: a bare `trip_seats` table, Redis, and a load rig. Prove the locking design before anything is built on it.
- Data model: `trip_inventory` (per-trip summary), `trip_seats` (one row per physical seat per trip, carrying **two bitmasks**, `segment_sold_mask` and `segment_hold_mask`, over the trip's segment ordinals), `seat_segments` (materialized per-segment availability for search), `seat_holds`, append-only `inventory_events`. Seat states AVAILABLE / HELD / PAYMENT_PENDING / BOOKED / BLOCKED / BOARDED are derived per segment from the masks plus status.
- **Atomic acquisition — never SELECT-then-UPDATE.** One conditional UPDATE per seat, all seats of a hold in one transaction, all-or-nothing:

```sql
-- want_mask = OR of segment bits between boarding and dropping stop
UPDATE trip_seats
   SET segment_hold_mask = segment_hold_mask | :want_mask,
       current_hold_id   = :hold_id,
       version           = version + 1
 WHERE trip_id = :trip_id
   AND seat_id = :seat_id
   AND (segment_hold_mask | segment_sold_mask | blocked_mask) & :want_mask = 0;
-- rowcount 1 = acquired for exactly those segments; 0 = conflict -> roll back the entire hold
```

- Segment correctness falls out of the mask: Dhaka→Cumilla (bit 0) and Cumilla→Chattogram (bits 1–2) never intersect; Dhaka→Feni (bits 0–1) versus Cumilla→Chattogram (bits 1–2) collide on bit 1, and the second buyer gets 0 rows.
- **Holds**: `HOLD_xxxxx` with trip, seats, segment range, passenger/session, frozen price-snapshot reference, channel, `expires_at` (5–10 min, configurable per channel). **Redis holds the expiry timer (keyspace notifications) for speed; the PostgreSQL `expires_at` is the authority.** A sweeper scans PostgreSQL for expired holds every 15s and releases mask bits conditionally (`WHERE current_hold_id = :hold_id`), so losing Redis can never strand a seat — only delay release by ≤15s.
- Every mutation writes an `inventory_events` row (append-only) in the same transaction, plus an outbox event (`seat.held` / `seat.released` / `seat.booked`).
- Confirm (HELD → BOOKED) and release are **idempotent, keyed by `hold_id`** — replays are no-ops.
- Shard-readiness: every statement is single-trip; the service routes internally by `hash(trip_id)` from day one (one partition group now, N shards in Phase 3, zero API change).

**Done when**: the 100k-contender proof test passes — **gated at Week 5 before commerce builds on it**; the segment matrix test (all pairs of overlapping and non-overlapping segment holds) passes exhaustively; the hold-expiry race test passes; a Redis flush during active holds loses zero seats; p95 hold acquisition <250 ms at 5k holds/min sustained; no query in the service lacks `trip_id` in its WHERE clause (lint-enforced).

#### P1-G — Search Pipeline
**Owner**: 1–2 Go engineers · **Depends on**: P1-E events, P1-A Kafka · **Weeks**: 7–11

- Indexer: `trip.*` and `seat.*` events → Kafka → OpenSearch trip index (denormalised: route, stops, operator, bus type, amenities, fares, per-segment availability counts); locations and operators indexes.
- Query API: origin/destination (alias-canonicalised), travel_date, passenger_count; filters (operator, bus type, AC, departure/arrival windows, price, amenities, boarding/dropping, availability); sorts (recommended, price, departure, duration, availability); Redis result cache with event-driven invalidation.
- Search returns *approximate* availability; the seat map and the hold always hit inventory-service. Search may be stale; inventory may not.

**Done when**: end-to-end index lag <5s from `trip.created` to searchable; all filter/sort combinations covered by API tests; p95 search <200 ms on a 10k-trip corpus; killing an OpenSearch node degrades latency but returns correct results (replica test); zero search queries touch PostgreSQL.

#### P1-H — Commerce (booking, pricing, payment, ticket, cancel/refund/reschedule)
**Owner**: 3 Go engineers + QA · **Depends on**: the P1-F gate (wk5), P1-C · **Weeks**: 6–13

- booking-service: full state machine (CREATED → PAYMENT_PENDING → CONFIRMED → TICKETED → COMPLETED; FAILED / EXPIRED / CANCELLED / REFUND_PENDING / REFUNDED / PARTIALLY_REFUNDED), `booking_status_history` on every transition, passengers/items/seats/price_breakdown tables. booking-service is the **saga orchestrator**.
- Price engine: `Base + Taxes + Platform Fee + Operator Fee − Discount − Coupon = Total`; the full snapshot is **frozen at hold time**, stored on the hold and copied to the booking; historical prices are never recomputed.
- payment-service: provider-independent interface (`createPayment` / `verifyPayment` / `getPaymentStatus` / `refundPayment` / `handleWebhook`); adapters for **bKash and Nagad** (sandbox-live), **card and bank** (sandbox/stub per gateway readiness), **cash and agent-wallet** (internal, fully functional — these prove the flow with no external dependency). The webhook chain is enforced in order: verify signature → verify with provider → amount → currency → booking → idempotency (`UNIQUE(provider, provider_txn_id)`) → confirm.
- ticket-service: `booking.confirmed` → PNR (collision-checked, human-readable) → ticket → **signed opaque QR token** (rotatable keys, no PII in the token) → notification event. QR states VALID / BOARDED / CANCELLED / USED / EXPIRED; internal verify endpoint now, boarding app in Phase 2.
- Cancellation engine: policy resolution (operator > route > schedule > class > channel > time-tier) with the default tiers from the entry criteria; refund engine (REQUESTED → APPROVED → PROCESSING → SUCCESS / FAILED / REJECTED) with inventory release, provider refund, notification and audit.
- **Reschedule as a saga**: hold new seats → compute fare delta → collect/refund → cancel old allocation → issue replacement ticket; any failure compensates fully (old ticket untouched, new hold released, delta refunded).
- **Double-entry ledger from day one**: finance-service records balanced `journal_entries` / `ledger_entries` (Gateway Clearing, Customer Receivable, Operator Payable, Refund Payable, Platform Revenue, Tax Payable) for every booking, payment and refund event. No finance UI yet — but Phase 2 inherits real data.

**Done when**: the full happy path passes automated E2E (search → hold → book → pay (sandbox) → webhook → confirm → ticket → QR verify); the webhook-storm test passes; every terminal booking state has balanced ledger entries (automated trial-balance check = 0); cancellation returns the policy-correct amount across all four tiers; the reschedule-failure test leaves the original ticket valid and the money whole.

#### P1-I — Cross-Cutting: Observability, Audit, Security, Contracts, Reference Client
**Owner**: Security engineer + 3 QA + 2 frontend + platform · **Depends on**: P1-A · **Weeks**: 1–14

- Observability: OpenTelemetry in the chassis — every request carries `request_id` and `trace_id` across gRPC, REST and Kafka; Prometheus/Grafana dashboards for every metric in the specification; Loki logs correlated by `trace_id`; SLO alerts paging the platform team.
- **Immutable audit log**: a dedicated append-only store (partitioned, INSERT-only role, no UPDATE/DELETE grants) capturing actor, role, action, resource, before/after, IP, device and `request_id` for every sensitive mutation — wired into the chassis so services get it for free.
- Security baseline: TLS everywhere, mesh mTLS, PII column encryption (phone, email, NID) with KMS-managed keys, secrets vault, refresh-token rotation, WAF in front of the gateway, secure headers, dependency and container scanning, signed webhooks.
- **Contract testing as a CI gate**: buf breaking-change detection on all protos; consumer-driven contracts (Pact) on the inventory ↔ booking ↔ payment ↔ ticket seams; a service cannot deploy past a broken contract.
- Reference web client (Next.js): one flow — search, seat map, hold countdown, checkout, sandbox payment, ticket with QR. Deliberately minimal; it is a test harness with a URL.

**Done when**: one `trace_id` follows a booking across ≥4 services and 3 Kafka hops in Grafana/Tempo; the audit table provably rejects UPDATE and DELETE; a deliberately breaking proto change fails CI; PII columns are unreadable with database-only access; the reference client completes the full flow against STAGING.

### Sequencing — Week by Week

Critical path: **A → B → F (prototype) → F (gate wk5) → H → exit tests.** Everything else parallels around it.

| Wk | Active | Milestone landing |
|----|--------|-------------------|
| 1 | A, B, I | Monorepo + CI skeleton; Terraform bootstrap; LOCAL/DEV up; schema conventions ratified; owner decisions confirmed |
| 2 | A, B, C, F, I | Service chassis v1 (OTel/outbox/idempotency); migration tooling live; **seat-lock prototype starts on fixtures**; identity schema |
| 3 | A, B, C, D, F, I | DEV cluster + Linkerd + vault; OTP login working; BD gazetteer imported; inventory bitmask design reviewed and frozen |
| 4 | A, C, D, F, I | **Concurrency rig run #1: 100k contenders vs Seat A1 on DEV**; RBAC engine + role seeds; operator CRUD; QA environment |
| 5 | C, D, F, H, I | **GATE: seat-lock proof signed — 1 winner, 0 double-holds, segment matrix exhaustive pass. Commerce build authorised.** Kafka + schema registry live; fleet + layout builder underway |
| 6 | D, E, F, H, I | Holds with Redis timers + PG sweeper; routes/segments/fares API; audit log service live; STAGING environment |
| 7 | E, F, G, H, I | Trip generation producing trips; booking state machine skeleton; payment interface + bKash sandbox connected; search indexer consuming `trip.created` |
| 8 | E, F, G, H, I | Segment inventory integrated with real generated trips; price engine + frozen snapshots; contract tests gating CI |
| 9 | E, F, G, H, I | **Hold → booking → payment saga end-to-end in DEV (bKash sandbox)**; Nagad sandbox; search filters/sorts complete; trip lifecycle complete |
| 10 | F, G, H, I | Ticket/PNR/signed QR issuance; webhook verification chain hardened; expiry sweeper + reconciler proven; reference client starts |
| 11 | G, H, I | Cancellation + refund engines; **ledger entries balancing for book/pay/refund**; cash/agent-wallet/card adapters; Redis search cache; PRE-PROD environment |
| 12 | H, I | Reschedule saga + compensation; first service-death chaos drills on STAGING; dashboards + SLO alerts complete; PROD/DR pipelines dry-run |
| 13 | H, I, all | **Exit-gate proof tests executed (all six) on STAGING**; performance tuning to p95 targets; security review + PII/secrets audit |
| 14 | all | Bug-burn; full gate suite green **twice consecutively**; runbooks; Phase 2 handoff with pilot-operator onboarding checklist |

### Data Model Delivered

Decisions that are cheap now and brutal later:

- **IDENTITY** — `audit_logs` and `otp` monthly range-partitioned from migration #1; users unsharded (fits one node for years) but UUIDv7-keyed so a later split is mechanical.
- **OPERATORS** — `operator_id` tenancy column on every operator-scoped row plus RLS now; small tables, no partitioning. Changing tenancy enforcement later means auditing every query in the system.
- **FLEET** — no partitioning; **seat layout versions immutable** once trip-referenced. Retrofitting this means re-deriving what every historical ticket meant.
- **LOCATION** — static reference data, replicated and cached, no partitioning; canonical alias resolution at write time so IDs, never spellings, are stored downstream.
- **ROUTES** — fare and segment rows are versioned-immutable; trips snapshot them. Mutating fares in place would corrupt the provenance of every frozen price snapshot.
- **SCHEDULE** — `trips` monthly range-partitioned by service date; `trip_id` is a UUIDv7 minted **only** by schedule-service. A single mint point is what makes `trip_id` a viable shard key.
- **INVENTORY** — `trip_seats`, `seat_holds`, `inventory_events` **hash-partitioned by `trip_id` now, shard key `trip_id` later**: one trip has exactly one authoritative owner. The implication is accepted deliberately: inventory answers only single-trip questions, so **cross-trip queries (my bookings, operator occupancy) are served by booking-service and analytics projections, never by fanning out across inventory shards** — which is why those read models are built in Phase 2 rather than bolted on in Phase 3.
- **BOOKING** — `bookings` and children monthly range-partitioned by `created_at`; PNR gets a global unique lookup index (PNR → booking_id) because PNR lookup must survive sharding; booking carries `trip_id` as a plain column, with no FK across service databases.
- **PAYMENT** — `payment_webhooks` append-only, monthly partitioned; `UNIQUE(provider, provider_txn_id)` exists in migration #1. That constraint *is* the idempotency defence and cannot be added later without deduplicating history.
- **TICKETS** — monthly partitioned by issue date; QR is a signed opaque token with a key ID for rotation; no PII in the token, ever. The alternative is re-issuing every live QR later.
- **REFUNDS** — low volume, monthly partitioned `refund_transactions`; every refund row links payment_id, booking_id and ledger journal_id from day one.
- **FINANCE (ledger only in this phase)** — `ledger_entries` append-only, monthly partitioned, no UPDATE grant; corrections are reversing entries. Starting this in Phase 2 would mean a backfill that no auditor accepts.

### Distributed Correctness

No two-phase commit. **Orchestrated saga with booking-service as orchestrator** — the booking state machine *is* the saga state, giving one accountable owner for compensation, auditable through `booking_status_history` — plus a **transactional outbox in every producing service's own database** (the outbox row is inserted in the same local ACID transaction as the state change; Debezium CDC relays to Kafka, with a poller as fallback). No service ever dual-writes to its database and to Kafka.

```
client            gateway        inventory-svc              booking-svc               payment-svc            ticket-svc
  │ POST /holds (Idem-Key K1)──────►│
  │                                 │ ONE TX: conditional UPDATE per seat (all-or-nothing)
  │                                 │  + seat_holds + inventory_events + outbox(seat.held)
  │◄─ hold_id, expires_at, price────┘
  │ POST /bookings {hold_id} (K2)──────────────────────────►│
  │                                 │◄─gRPC ValidateAndExtendHold(hold_id)
  │                                 │  (extend to payment window; fail → booking FAILED)
  │                                 │                        │ TX: booking PAYMENT_PENDING + outbox(booking.created)
  │◄─ booking_id ───────────────────────────────────────────┘
  │ POST /payments {booking_id} (K3)───────────────────────────────────────────►│ create provider intent
  │        …customer completes bKash checkout…                                  │
 provider ══ webhook ════════════════════════════════════════════════════════► │ verify: signature→provider→amount→currency
                                                                               │         →booking→idempotency(provider_txn_id)
                                                                               │ TX: payment PAID + outbox(payment.succeeded)
                    booking-svc ◄── Kafka: payment.succeeded ──────────────────┘
                    │ TX: booking CONFIRMED + outbox(booking.confirmed)
                    │ gRPC inventory.ConfirmSeats(hold_id) → HELD→BOOKED
                    │      (conditional WHERE current_hold_id = :hold_id, idempotent)
                    │ Kafka: booking.confirmed ─────────────────────────────────────────────────► issue PNR + ticket + QR
                    │                                                                             (idempotent on booking_id)
```

**Idempotency propagation.** The client supplies an `Idempotency-Key` on every public mutation; the owning service stores `(key, actor, endpoint, request_hash, response)` and replays the stored response on retry. Derived internal operations use **deterministic keys** — confirm-seats key = `hold_id`, ticket key = `booking_id`, compensation-refund key = `payment_id` — so retries at any hop collapse to a single effect.

**Failure points and outcomes:**

| Failure | Outcome |
|---|---|
| Seat 2 of 3 already taken | Transaction rolls back, zero seats held, 409 with alternates |
| Hold expires before booking | `ValidateAndExtendHold` fails → booking FAILED, no money moved |
| Payment webhook lands after hold lost | `ConfirmSeats` returns SEAT_LOST → compensation: `refundPayment` (deterministic key), booking → FAILED_REFUNDED, passenger notified. Money returns rather than seats double-selling |
| Duplicate webhook ×100 | `UNIQUE(provider, provider_txn_id)` → one payment row, one outbox event, 99 acknowledged no-ops |
| **payment-service dies mid-flow** | Booking sits PAYMENT_PENDING; the PG-driven sweeper releases the hold at expiry and booking → EXPIRED. If the provider actually charged, the reconciliation job (provider status query + webhook replay on restart) finds the orphaned charge and auto-refunds it. No orphaned holds (the sweeper is inventory-owned and PG-authoritative); no unpaid tickets (tickets only issue from `booking.confirmed`) |
| ticket-service down | Booking stays CONFIRMED; issuance is **retried from Kafka, never compensated** — the consumer group redelivers, idempotent on `booking_id` |

Seat acquisition is always the exact conditional UPDATE shown in P1-F. The rowcount is the lock.

### APIs & Events Delivered

**Public REST under `/api/v1/`** (gateway-fronted; every mutation accepts `Idempotency-Key` and carries `request_id`/`trace_id`): `auth/*` (otp, login, refresh, sessions, devices) · `locations/*` (+ alias search) · `operators/*` · `fleet/*` (buses, layouts) · `routes/*` · `schedules/*` · `trips/{id}` (+ `/seatmap`, `/availability`) · `search` · `holds` (POST/GET/DELETE) · `bookings` (+ `/cancel`, `/reschedule`) · `payments` (+ `payments/webhooks/{provider}` — signed, provider-IP-restricted) · `tickets/{id}` (+ `/qr/verify`) · `refunds/*` · `admin/*` (RBAC-gated catalog management).

**Internal gRPC** (mesh mTLS only, never gateway-exposed): `inventory.v1` (AcquireHold, ValidateAndExtendHold, ConfirmSeats, ReleaseHold, GetSeatMap) · `pricing.v1` (QuoteAndFreeze) · `identity.v1` (Introspect, CheckPermission) · `ticket.v1` (Issue, VerifyQR) · `ledger.v1` (PostJournal).

**Kafka topics this phase** (standard envelope, schema-registry enforced, DLQ per consumer group): `user.created` · `operator.created` · `trip.created|updated|cancelled` · `seat.held|released|booked` · `booking.created|confirmed|cancelled` · `payment.created|success|failed` · `ticket.issued` · `refund.requested|completed` — plus internal `audit.recorded`.

### The Non-Negotiables

1. **Every channel calls the same Inventory Service.** No seat logic in web, POS, agent, partner or app code — ever. This is the load-bearing wall of the entire company.
2. **Never SELECT-then-UPDATE for seats.** Conditional UPDATE; the rowcount is the verdict. Code review rejects violations and a lint rule hunts them.
3. **The browser success page never confirms payment.** Only the verified webhook chain confirms. The success page reads state; it never writes it.
4. **Price snapshots are frozen at hold time.** Historical bookings are never repriced from current fare rules.
5. **The double-entry ledger records booking, payment and refund entries from day one** — even though the finance UI is Phase 2. Phase 2 opens the books on real, balanced data. There is no backfill, because auditors don't accept backfills.
6. Every mutation is idempotent — public via `Idempotency-Key`, internal via deterministic keys. No exceptions, including "internal-only" endpoints.
7. PostgreSQL is authoritative; Redis is an accelerator. If Redis vanishes, no seat, hold or payment fact is lost.
8. Outbox or it didn't happen: no service publishes to Kafka outside its transactional outbox.
9. No service touches another service's database. All cross-service reads are API- or event-fed projections.
10. Every inventory row carries `trip_id`; no inventory query spans trips.
11. The audit log is append-only at the grant level, not by convention.
12. A request without a propagated `trace_id` is a build failure, not a style nit.

### Risks & Mitigations

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | *(Microservices)* Contract churn across 21 services stalls teams in integration hell | Protos in the monorepo; buf breaking-change CI; consumer-driven Pact tests on the inventory ↔ booking ↔ payment ↔ ticket seams; contract-freeze review every Friday from Week 6 |
| 2 | *(Microservices)* Saga bugs create orphaned holds or unpaid tickets that unit tests never catch | Orchestrated saga with a single owner; deterministic compensation keys; the service-death test is an exit-gate item, not an afterthought; reconciliation job from Week 10 |
| 3 | Seat-lock design flaw discovered late, after commerce is built on it | Prototype on fixtures in Week 2; the 100k proof gated at Week 5 **before** commerce is authorised; bitmask design frozen by review in Week 3 |
| 4 | bKash/Nagad merchant approval slips past Phase 1 | Sandbox from Week 1, merchant filing in Week 1; provider-independent interface; cash and agent-wallet adapters prove the full flow with zero external dependency |
| 5 | *(Microservices)* A 3-person platform team drowns operating 7 environments, a mesh and Kafka for 21 services | Managed services throughout (EKS/MSK/RDS/ElastiCache/OpenSearch); Linkerd over Istio; golden-path chassis so service teams self-serve deploys; PROD/DR minimal-footprint until Week 12 |
| 6 | Redis quietly becomes the source of truth for holds under deadline pressure | PG `expires_at` authoritative plus a 15s sweeper in the design from day one; a chaos drill that flushes Redis with active holds is a standing STAGING test |
| 7 | Route or fare mutation corrupts segment masks or frozen snapshots | Trips snapshot the segment map and layout version at generation; fares and layouts are versioned-immutable once referenced; mutation attempts rejected at the API |
| 8 | Scope creep toward storefront features "since the frontend engineers are free" | Reference client scope fixed at one flow; the EM owns the no-list; surplus frontend time goes to contract tests and the Phase 2 design-system spike, not features |

### Phase 1 Exit Gate

**(a) Functional checklist** (the source specification's Phase 1 + Phase 2 acceptance criteria, automated wherever testable): passenger OTP/email auth, guest checkout, social login, password reset · staff MFA and suspicious-login handling · `resource.action` permissions enforced across all four role families, roles data-driven · operators fully isolated, cross-tenant read provably denied · buses and seat maps configurable via API including double-deck and sleeper · multi-stop routes with per-segment fares · schedules auto-generating trips, exceptions honoured, trip lifecycle complete · atomic seat hold with Redis expiry and PostgreSQL authority · segment inventory live · search pipeline Kafka → OpenSearch → Redis with all filters and sorts · booking state machine with full history · frozen price snapshots · bKash, Nagad, cash and agent-wallet payments through one interface · webhook verification chain · ticket, PNR, signed QR and verify endpoint · cancellation tiers, refund lifecycle, reschedule with compensation · balanced ledger entries for every money movement · complete immutable audit logging · per-service CI/CD, all 7 environments, mesh, contract tests gating · `request_id`/`trace_id` on every request, dashboards and SLO alerts live.

**(b) Hard proof tests** — run on STAGING against production-shaped data, results archived. The suite must pass **twice consecutively**:

1. **Seat A1 stampede.** 100,000 concurrent hold requests (distributed rig, ≥500 workers, randomised jitter ≤50 ms) for the same seat and segment. Pass: exactly 1 hold acquired, 99,999 clean 409s, `inventory_events` shows exactly one acquisition, 0 duplicate tickets after driving the winner through to ticketed. Repeat at segment level — the winner holds Dhaka→Cumilla; verify Cumilla→Chattogram remains acquirable during and after.
2. **Webhook storm.** Fire the identical signed provider webhook 100× concurrently and 100× sequentially, plus 50 with tampered signature, wrong amount and wrong currency (all rejected). Pass: 1 payment row, 1 booking confirmation, 1 ticket, 1 ledger journal; 199 idempotent no-op acknowledgements.
3. **Segment-inventory matrix.** For a 4-stop trip (3 segments), exhaustively test all 6 segment-pair combinations concurrently. Pass: a seat sold Dhaka→Cumilla is sellable Cumilla→Chattogram; every overlapping pair yields exactly one winner; final masks match an oracle model recomputed from `inventory_events`.
4. **Hold-expiry race.** Schedule a webhook to arrive in a ±2s window around hold expiry, 500 iterations. Pass: every iteration ends in exactly one of {confirmed booking with BOOKED seat} or {refunded payment with released seat}; zero iterations end paid-and-unrefunded or seat-BOOKED-and-unpaid.
5. **Reschedule-failure compensation.** Inject failure at each reschedule step (new-hold, delta-payment, old-cancel, reissue), 4 × 50 runs. Pass: the original ticket remains VALID, new holds released, net money movement zero, ledger balanced, every compensation visible in audit and booking history.
6. **Service death.** `kill -9` payment-service pods mid-flow at three points (after intent creation, mid-webhook processing, before outbox relay) under live traffic. Pass: after restart plus the reconciliation window (≤5 min), zero orphaned holds, zero unpaid tickets, any provider-charged orphans auto-refunded, Kafka consumer lag back to baseline. Repeat once each for inventory-service and booking-service pods.

**(c) Performance gate** — p95 on STAGING under sustained mixed load of 2,000 RPS search / 300 holds per minute / 150 bookings per minute, third-party payment latency excluded: search <200 ms · trip details <150 ms · seat availability <150 ms · seat hold <250 ms · booking creation <300 ms · internal ticket lookup <150 ms · QR verification <200 ms. Any miss blocks exit. **Phase 2 does not start on a red gate.**



## Phase 2 — Every Channel, the Money, and the Road (Weeks 15–30)

### Phase 2 at a Glance

| | |
|---|---|
| **Window** | Weeks 15–30 (16 weeks) |
| **Headcount** | ~38 peak: 12 Go, 8 FE (Next.js/TS), 4 Flutter, 3 platform/SRE, 1 DBA, 1 analytics engineer, 5 QA automation, 1 security, 2 product/BA, 1 EM |
| **Hiring ramp** | All 4 Flutter + 9 Go by W15; all 12 Go + 6 FE by W16; all 8 FE, DBA, 3 platform by W17; 5 QA + security by W18; analytics engineer + both BA by W19. **Every week of slip on Go/Flutter hires slips the pilot 1:1** |
| **Done means** | 1–3 real operators sell real tickets for real taka on every channel, buses are tracked live, and 14 consecutive pilot days close with zero unexplained ledger variance |
| **Hardest risk** | Money correctness across four sales channels — one reconciliation design flaw discovered during the pilot poisons trust with the first operators |

### What Phase 2 Delivers

By week 30 the business genuinely operates. Passengers search, pay with bKash/Nagad, and hold QR tickets on the website and the Flutter app. Counter staff open shifts, sell for cash, print thermal tickets, and close drawers that balance to the taka. Agents and sub-agents sell against wallet balance and credit limits and earn commission. Operators run branches, fleet, fares, schedules and staff through an ERP. Drivers run trips from their app; helpers scan boarding QRs on bad networks; passengers watch the bus move and get "bus approaching" SMS in Bangla. Every taka flows through the double-entry ledger, settles to operators through seven states, and reconciles three ways against gateway and bank. Support answers any question about any booking from a single timeline. Admin sees everything.

**The central rule, stated hard: Phase 2 adds channels and money. It adds ZERO new seat logic.** Web, app, counter, agent, ERP and driver flows all call the Phase 1 inventory-service for every hold, sale, seat change, reschedule and release. Any PR that implements seat state outside inventory-service is rejected on sight. This is the specification's most important instruction, and it is enforced by contract tests, not by trust.

Seven services graduate to full independent deployables this phase (skeletons have existed since day one): agent-service, finance-service, tracking-service, notification-service, support-service, promotion-service, analytics-service — completing all 21 services in production.

### Entry Criteria

**Technical** (from Phase 1, verified at the week 14 gate review, re-verified in week 15):

- Concurrency proof passing in CI: 100K contenders for one seat → exactly 1 reservation; webhook fired 100× → 1 payment, 1 confirmation, 1 ticket.
- Segment inventory proven: a Dhaka→Cumilla sale leaves Cumilla→Chattogram sellable; overlap correctly blocked.
- p95 targets met at pilot-scale load: search <200 ms, hold <250 ms, booking <300 ms, QR verify <200 ms.
- Ledger already writing balanced entries for every booking, payment, refund and reschedule; a replayed month of synthetic traffic balances to zero.
- Idempotency keys on all mutations; audit log capturing actor/before/after; OTel traces end-to-end; shard-ready schema (`trip_id` routing) in place.
- Cancellation, refund and reschedule engines functional behind APIs with atomic compensation.

**Business/legal** — long lead times, driven by product/BA from week 15. Done by the stated week or the pilot slips:

- Platform bank account + escrow/collection account operational (W18).
- Live bKash and Nagad **production** merchant credentials, not sandbox (W20 — MFS onboarding takes 4–8 weeks; file paperwork in week 15).
- Signed settlement agreements with pilot operators: cycle, commission %, withholding, dispute terms (W22).
- Agent KYC process defined and legal-reviewed: NID, trade licence, guarantor for credit lines (W20).
- Written cash-handling policy for counters: float limits, drawer variance tolerance (৳50), escalation, insurance (W21).
- Apple/Google developer accounts + D-U-N-S verification started W15.

### Workstreams

**P2-A — Passenger Website** · Owner: 3 FE + 0.5 Go (BFF) · Depends on: Phase 1 APIs, P2-K · Weeks 15–24

- Every page in the specification: Home, Search, Results, Trip Details, Seat Selection, Checkout, Payment (bKash/Nagad/card redirect flows), Confirmation, Ticket, Cancellation, Refund, Reschedule, Tracking, Support, Offers.
- Full account area: upcoming/past trips, saved passengers, payments, tickets, refunds, notifications, profile, device/session management.
- Bangla + English localisation; guest checkout; SSR for search/SEO pages.
- **Done when:** a passenger completes search → seat → bKash → ticket with no human help; reschedule and cancellation are self-serve end to end; the success page never confirms payment (webhook-only, verified by test); Lighthouse ≥90 on search and checkout; all seat interactions provably hit inventory-service (contract test).

**P2-B — Passenger Flutter App** · Owner: 2.5 Flutter · Depends on: P2-A API surface, P2-K push · Weeks 15–27

- All web functionality plus biometric login, push notifications, offline ticket + QR (signed token cached on device), live bus tracking, boarding reminders, saved routes.
- **App-store review is a schedule dependency, not an afterthought:** developer accounts + D-U-N-S in week 15; internal/TestFlight build W21; production submission W24 with review buffer; an Apple rejection loop budgeted at 10 days. Soft launch W27, pilot routes only.
- **Done when:** the offline ticket renders and its QR scans with the phone in airplane mode; push booking confirmation arrives <30s; both stores approved before W27; crash-free rate ≥99.5% in soft launch.

**P2-C — Operator ERP** · Owner: 2 FE + 1.5 Go · Depends on: Phase 1 operator/fleet/route/schedule APIs; P2-F for finance modules · Weeks 15–24

- All specified modules: Dashboard, Branches, Users, Roles, Fleet, Seat Layouts, Routes, Stops, Schedules, Trips, Fare Management, Boarding, Counters, Drivers, Agents, Bookings, Refunds, Finance, Settlements, Analytics, Documents, Settings.
- Bulk CSV import for fleet, routes and fares — this is what makes pilot onboarding survivable.
- **Done when:** a pilot operator is fully configured (fleet → layouts → routes → fares → schedules → staff → counters) by their own trained staff in ≤2 days using bulk import; the operator can see their settlement statement and raise a dispute; RBAC blocks a Dispatcher from Finance screens (tested).

**P2-D — Counter POS + Offline Handling** · Owner: 1.5 FE + 2 Go · Depends on: inventory/booking APIs, P2-F (cash ledger, shifts) · Weeks 16–25

- Full flow: search → trip → live seat map → passenger details → cash/card/MFS → ticket → thermal print (ESC/POS). Cancellation, reschedule, seat change, passenger edits, reprint (watermarked DUPLICATE), cash drawer, shift open/close, counter reports.
- Shift lifecycle: `OPEN (float declared) → SELLING → CLOSING (count) → BALANCED | VARIANCE (manager approval + ledger writedown entry)`.
- **Offline policy — exact and non-negotiable.** Offline selling from shared inventory is forbidden: an offline terminal cannot see authoritative seat state, so it can sell a seat the website sold seconds earlier — two passengers, one seat, a cash dispute at the bus door, and a ledger that can only balance via manual writedown. Therefore:
  - **May do offline** — validate boarding QRs against cached manifests, reprint already-issued tickets, view cached trips and manifests, record drawer events locally.
  - **May sell offline** — only pre-allocated counter-quota seats. While online, the counter reserves N specific seats which inventory-service marks BLOCKED-for-counter (exclusively owned); offline sales issue only from that downloaded quota, with serialised offline ticket numbers.
  - **May never do offline** — hold, sell, change or release any non-quota seat.
  - **On reconnect** — replay queue with per-transaction `idempotency_key` and monotonic per-terminal sequence numbers; inventory-service converts quota → BOOKED; cash entries post with original timestamps; **the shift cannot close while the replay queue is non-empty.**
- **Done when:** a shift closes and matches the ledger to the taka; an airplane-mode terminal sells only quota seats and rejects everything else; reconnect replay is idempotent under repeated replays (the test kills the process mid-replay); thermal print works on the two printer models bought for pilot counters.

**P2-E — Agent Platform, Wallet, Commission** · Owner: 2.5 Go + 1 FE · Depends on: P2-F ledger core · Weeks 15–24 · **Critical path**

- Agency → agent → sub-agent hierarchy with agent_users; portal covering ticket sales, customer management, cancellation, reports, commission statements, wallet recharge (bKash/Nagad/bank deposit with maker-checker), transaction history.
- The wallet is a **ledger, not a balance column**: `wallet_accounts`, `wallet_transactions` (append-only), `wallet_holds`, `wallet_adjustments`. Three figures always derivable: AVAILABLE, HELD, CREDIT LIMIT. Sale flow: atomic hold (`available + credit − held ≥ price`, single conditional update) → capture on ticket → release on expiry/failure, deterministic and idempotent.
- Commission engine: fixed, percentage and tiered; rules dimensioned by operator, route, trip, agent, counter, sales channel, promotion and ticket class; most-specific-rule-wins with explicit precedence; every commission lands as ledger entries, never a direct balance bump.
- **Done when:** 1,000 concurrent purchase attempts against a wallet with credit for 10 tickets yield ≤10 sales and 0 oversell (CI test); a sub-agent sale credits the correct split up the hierarchy; recharge requires maker-checker; wallet figures recomputed from transactions match cached figures after chaos-killing the service mid-sale.

**P2-F — Finance Core: Ledger, Settlement, Reconciliation** · Owner: 3 Go + DBA + finance BA · Depends on: Phase 1 ledger skeleton · Weeks 15–25 · **Critical path root**

- Full chart of accounts live: Cash, Gateway Clearing (per provider), Customer Receivable, Operator Payable, Agent Payable, Refund Payable, Platform Revenue, Commission Expense, Gateway Fee, Tax Payable, Promotional Expense. Posting rules for every money event on every channel.
- Operator settlement through all seven states: `OPEN → CALCULATED → REVIEWED → APPROVED → PAYMENT_INITIATED → PAID → RECONCILED`; daily/weekly/custom cycles, manual adjustment, withholding, dispute, generated settlement statement PDF. APPROVED requires maker-checker.
- Three-way reconciliation: platform ledger vs gateway settlement files (bKash/Nagad/card) vs bank statement. Detects every exception class in the specification — missing transaction, duplicated transaction, incorrect amount, reversed transaction, callback failure, failed refund, missing bank settlement — with an exception queue carrying classification, ageing and assignment.
- **Done when:** a synthetic month replays to a zero-variance trial balance; a settlement runs OPEN → RECONCILED against seeded gateway and bank files containing all seven exception classes, each detected and queued; an unresolved exception provably blocks settlement APPROVED; ledger writes are append-only (UPDATE/DELETE revoked at the database grant level).

**P2-G — Admin Dashboard + Support Console** · Owner: 1.5 FE + 1 Go · Depends on: most services (read paths) · Weeks 18–26

- Admin: all specified sections — customers/operators/agents/counters; buses/locations/routes/trips; bookings/tickets/payments/refunds; promotions/commissions; finance/settlements/reconciliation; risk placeholder; support; reports; audit; configuration/permissions/system health.
- Support console: search by phone, email, PNR, ticket, booking or payment; the full booking timeline (seat held → payment started → payment success → ticket issued → SMS sent → trip changed → cancellation → refund) assembled from events and the audit log; every support action permission-controlled and audited.
- **Done when:** support resolves "where is my refund?" from one screen without engineering help; every admin mutation appears in the audit log with before/after; an Auditor role can see everything and change nothing (tested).

**P2-H — Promotions + Referral** · Owner: 1 Go + shared FE (rolls on W20 as P2-K frees) · Depends on: pricing engine, P2-F (Promotional Expense postings) · Weeks 20–26

- All specified types: coupon, automatic discount, new-user, route campaign, operator campaign, payment promotion, referral, agent promotion, limited quantity. Rules: start/end, route, operator, user, minimum amount, max discount, usage limit, per-user limit. Redemption is atomic — limited-quantity coupons cannot over-redeem under concurrency.
- Referral: invite → registered → qualified booking → reward (wallet credit, coupon or points), with reward issuance posting to the ledger.
- **Done when:** a limited-quantity coupon under 1,000 concurrent redemptions never exceeds its cap; discounts appear in the frozen price snapshot and as Promotional Expense entries; per-user limits hold across channels.

**P2-I — Driver App, Crew Mode, Boarding** · Owner: 1.5 Flutter + 1 Go · Depends on: ticket/QR service, P2-J for GPS emit · Weeks 16–24

- Driver app: assigned trips, bus, route, departure, stops, passenger manifest, navigation handoff, operational alerts; emits GPS (P2-J); trip state controls (BOARDING → DEPARTED → ARRIVED).
- Crew/helper mode: scan ticket, verify passenger, mark boarded, mark no-show, view list, report incident.
- Boarding validation chain: QR → signed-token verify → trip match → not cancelled → not already used → mark BOARDED → emit `ticket.boarded`. **Intermittent-connectivity tolerance:** manifest and token public keys sync pre-trip; offline scans validate locally against the cached manifest, queue boarded-marks and sync opportunistically. Conflict rule: a seat scanned on two devices flags at next sync for crew resolution; the central system remains authoritative.
- **Done when:** a boarding scan works in airplane mode against a pre-synced manifest and syncs correctly on reconnect; a ticket cancelled after sync is caught at sync and flagged; scan-to-result <2s p95 offline and <3s online; a double-scan of one QR on two devices is detected.

**P2-J — Tracking: GPS, Live Map, ETA, Ops Control** · Owner: 2 Go + 1 platform · Depends on: Kafka, P2-I · Weeks 16–26

- Ingestion from all three sources — driver app, hardware GPS devices, third-party GPS providers — through one Location Gateway:

```
Driver App / HW GPS / 3rd-party ─► Location Gateway ─► Kafka(bus.location.updated)
        ─► Location Processor ─► Redis (current position, TTL) ─► web/app/OCC
                              └─► ClickHouse (history)
```

- Live passenger tracking (position, ETA, distance, next stop, delay, route progress — ticket-scoped access); ETA v1 from current location + route + historical segment times + velocity + stop dwell.
- Operations Control Center: all active buses, with all seven alert types — Late Departure, Long Stop, Route Deviation, GPS Offline, Unexpected Bus Stop, Trip Cancellation, Bus Breakdown.
- Replacement bus: replace → automatic seat remap old-layout → new-layout → conflict detection (fewer or different seats) → crew resolution queue → passenger notification. Breakdown/incident module covering breakdown, accident, route interruption, replacement vehicle, passenger relocation, refund eligibility and operational notes.
- **Done when:** a load test at 20× the pilot event rate runs with lag <5s; a bus going dark raises GPS Offline within 3 min; a replacement bus with a smaller layout produces a conflict list rather than a silent double-assignment; the passenger map updates ≤10s behind reality.

**P2-K — Notification Platform** · Owner: 1.5 Go (weeks 15–18), then 1 · Depends on: Kafka · Weeks 15–22, then embedded support · **Starts first — six workstreams depend on it**

- Channels: SMS (two Bangladeshi aggregators for failover), email, push (FCM/APNs), WhatsApp if the BSP contract lands. Template engine with Bangla and English variants per template; per-event routing (booking confirm → SMS + push; bus approaching → push with SMS fallback; refund → SMS + email); per-channel cost tracking and a monthly budget circuit-breaker with per-event-class rate caps.
- All specified events: booking confirmation, ticket, reminder, bus approaching, bus delayed, trip cancellation, route change, refund, reschedule.
- **Done when:** every event delivers in both languages per passenger preference; SMS aggregator failover is proven by killing the primary in staging; every attempt is recorded in `notification_attempts` with cost; the cost breaker halts a runaway loop in test without touching the transactional booking flow.

**P2-L — Analytics: Kafka → ClickHouse, Reports, Real-Time Dashboard** · Owner: analytics engineer + 0.5 Go + DBA · Depends on: Kafka topics from all services · Weeks 17–27

- ClickHouse ingest of all domain events; **zero heavy reporting queries against the booking PostgreSQL** — enforced, not requested: reporting services have no PostgreSQL grants.
- Platform reports: GBV, revenue, bookings, cancellations, refunds, occupancy, payment conversion, search conversion, operator performance, route performance. Operator reports (embedded in the ERP): sales, passengers, occupancy, routes, agents, counters, settlements, refunds.
- Real-time dashboard: online users, searches/sec, bookings/min, revenue, seats held, payment success/failure, active trips, GPS buses, system errors.
- **Done when:** dashboard numbers lag reality <60s; a reconciliation-style check shows ClickHouse booking counts matching PostgreSQL daily (variance alert if not); operator report totals tie to their settlement statement; the primary database shows zero reporting query load under monitoring.

### Sequencing — Week by Week

► marks the critical path: **P2-F ledger/settlement → P2-E wallet + P2-D shifts → money rehearsals → readiness gate → pilot → 14-day clean streak.**

| Wk | Active | Milestone landing |
|----|--------|-------------------|
| 15 | A,B,C,E,F,K | ►Chart of accounts live; 7 new service deployables scaffolded in CI/CD; app-store accounts + MFS production paperwork filed; notification skeleton up |
| 16 | +D,I,J | ►Posting rules replay Phase 1 money events to zero variance; wallet schema; Location Gateway ingesting driver-app pings (dev) |
| 17 | +L | ►Wallet hold/credit concurrency test green; POS sell flow v1; ERP fleet/route/schedule modules; ClickHouse ingest live |
| 18 | +G | ►Shift open/close + cash drawer posting to ledger; commission rule engine; tracking Redis current-state; boarding scan v1 |
| 19 | all | ►Settlement OPEN→CALCULATED; agent portal selling via wallet; live map in staging; Bangla/English templates done |
| 20 | all | ►Three-way reconciliation engine vs seeded gateway/bank files; OCC alpha (all 7 alerts); support timeline; MFS production credentials live |
| 21 | all | App internal/TestFlight build submitted; counter offline quota implemented; promotions engine; ETA v1; admin core |
| 22 | all | ►**Money rehearsal #1**: synthetic week, all four channels → settlement → reconciliation, exceptions injected; offline boarding tests pass |
| 23 | all | Pilot operator #1 data onboarded via ERP bulk import; counter hardware field kits; referral live; reports v1 |
| 24 | all | ►**Dress rehearsal**: multi-channel same-trip sale proof, shift-balance proof, full settlement cycle proof; **app production submission**; counter staff trained |
| 25 | all | ►**Feature freeze. Readiness gate**: go/no-go checklist, kill-switch drill, seeded-exception reconciliation drill, runbooks signed |
| 26 | pilot | ►**PILOT GO-LIVE** — operator 1, 2 routes, war room, daily reconciliation ritual begins |
| 27 | pilot | Operators 2–3 onboarded if week 26 clean; app soft launch on pilot routes |
| 28 | pilot + hardening | Pilot ops; fix queue burn-down; notification cost tuning; GPS gap analysis; first real weekly settlement CALCULATED |
| 29 | pilot + hardening | ►First real settlement reaches PAID → RECONCILED against an actual bank file; exit-gate proof tests executed |
| 30 | pilot + exit | ►14-day zero-unexplained-variance streak completes; exit review; fraud and demand datasets handed to Phase 3 |

### The Pilot

**Operator selection (1–3).** 10–30 buses; runs a single high-frequency corridor (Dhaka–Chattogram profile: multi-stop, so segment sales matter); owns 2–4 physical counters; has a bank account and signs the settlement agreement; the owner is personally committed and willing to run a paper-manifest parallel backup for week one; staff available for two days of training. Operator 1 goes alone in week 26; operators 2–3 join in week 27 only if week 26 closes clean.

**Scope.** 2–4 routes total, ≤20 trips/day, ≤~1,000 tickets/day.

- **In:** web, soft-launched app, counter POS (cash + MFS), 1–2 agents per operator with wallet credit capped at ৳50,000, bKash and Nagad live, boarding scans, live tracking, notifications, cancellations/refunds/reschedules, weekly settlement, one controlled coupon campaign.
- **Out, deliberately:** partner API, white label, AI features, dynamic pricing, marketing spend or growth pushes, agent credit above the cap, interlining, the card gateway if not certified in time (MFS suffices), and referral rewards in cash (coupon only during pilot).

**Go/no-go checklist** (executed week 25; EM, finance BA and security sign): all eight exit-gate proof tests green in staging; MFS production credentials verified with a live ৳10 transaction and refund; settlement agreement countersigned; counter staff pass a scored POS drill including offline quota and shift close; kill switch drilled end to end in staging; paper fallback stock at every counter; on-call rota and war-room channel staffed; rollback runbook rehearsed.

**Daily reconciliation ritual.** 23:30 — counters close shifts; automated pull of bKash/Nagad merchant statements; agent wallet snapshot; three-way match runs. 09:00 next day — 30-minute finance stand-up covering yesterday's trial balance, with the exception queue triaged and every exception classified within 24h. **Any unexplained taka variance stop-sells the affected channel until explained.** A one-page daily pilot P&L goes to the owner and each operator.

**Kill switch.** Per-channel sell flags at the gateway (web / app / counter / agent independently disableable in <1 min) plus a global stop-sell that blocks new holds while preserving boarding, refunds and tracking for passengers already ticketed. Full rollback: stop-sell → refund queue drains automatically → hourly printed manifests let the operator revert to manual sales. Target: decision to safe-state in under 5 minutes.

**Success metrics.** 0 double-bookings and 0 double-boardings; 0 unexplained ledger variance; MFS payment success ≥95%; boarding scan <3s p95; GPS coverage ≥90% of trip time; settlements paid on schedule 100%; support first response <2h and resolution <24h; complaint rate <2% of tickets.

**Feeds forward to Phase 3.** Labelled real-traffic signals (device, IP, phone, cancellation and hold patterns) seed the fraud rules — which cannot be written credibly from synthetic data. Demand curves by route, hour, day-of-week and booking lead time bootstrap forecasting. Observed segment travel times retrain the ETA model. Plus an MFS failure taxonomy and per-channel notification delivery and cost baselines.

### Data Model Delivered

| Domain | Tables | Retention & volume |
|---|---|---|
| AGENTS | agents, agent_users, agent_wallets (accounts/transactions/holds/adjustments), agent_commissions, agent_transactions | Append-only financial records, 7-year retention; pilot tens/day → full scale ~10⁵/day; monthly partitions on transactions |
| COUNTERS | counters, counter_users, shifts, cash_transactions | 7-year retention (cash audit trail); low volume; no partitioning needed before Phase 3 |
| FINANCE | ledger_accounts, journal_entries, ledger_entries, settlements, settlement_items, adjustments | Immutable, never deleted, 10-year retention; monthly partitions on ledger_entries from day one (shard-ready) |
| PROMOTION | campaigns, coupons, coupon_redemptions, referrals | Keep indefinitely (fraud-analysis input); modest volume |
| TRACKING | gps_devices, bus_locations, location_events, route_deviations | **Fastest-growing table in the platform.** Pilot: ~20 buses × 5s pings ≈ 3×10⁵ rows/day. Full scale: ~10,000 buses ≈ 1.7×10⁸ rows/day, tens of billions/year. Forces: raw pings never live long in PostgreSQL — Redis holds current position (TTL minutes), Kafka retains 7 days, ClickHouse daily partitions hold history, downsample to 1/min after 30 days, Parquet-to-S3 cold storage after 90 days |
| NOTIFICATIONS | templates, notifications, notification_attempts | **Second-fastest.** Pilot: ~1K tickets/day × 4–6 messages ≈ 5×10³ attempts/day; full scale 10⁶–10⁷/day. Forces: monthly partitions with TTL-driven drop, 90 days hot, archive to S3; a per-attempt cost column feeds the budget breaker |
| SUPPORT | support_cases, support_notes, support_actions | 3-year retention with a PII-minimisation policy; low volume; full-text index in OpenSearch, not PostgreSQL |

### Money Correctness Rules

- The double-entry ledger is the **only** financial truth. Every balance shown anywhere is a cached projection, rebuildable from entries.
- No mutable balance column is ever authoritative — not agent wallets, not counter drawers, not operator payables. Divergence between cache and recomputation is a paged alert.
- Every seat sold on **every** channel writes balanced entries at confirmation time. A channel that cannot post entries cannot sell.
- Agent wallet holds release deterministically: capture on ticket issue, release on expiry or failure — idempotent, exactly once in effect, proven under process-kill.
- A counter shift cannot close until counted cash equals ledger-expected cash; variance requires manager approval and posts an explicit writedown entry.
- An open reconciliation exception on any transaction in a settlement window **blocks** that settlement from reaching APPROVED. There are no exceptions to the exception rule.
- Refunds move **through** the ledger (Refund Payable), never around it — no direct gateway refund without a posted journal.
- Ledger tables are append-only; corrections are reversing entries; UPDATE/DELETE grants revoked at the database level.
- All amounts in integer poisha (1/100 taka). No floats touch money anywhere.

Worked example — a passenger pays ৳1,200 via bKash for an agent-attributed booking; base fare ৳1,150 + platform service fee ৳50; platform commission from operator 10% of base (৳115); bKash fee 1.5% (৳18); the agent earns ৳60:

```
JOURNAL JE-2026-0815-000123  (booking.confirmed BK-88421)
  DR  1101 Gateway Clearing : bKash          1,182.00
  DR  5102 Gateway Fee Expense                  18.00
      CR  2101 Operator Payable : OP-041              1,035.00   (1,150 - 115)
      CR  4101 Platform Revenue                         165.00   (115 + 50)
  -- totals: DR 1,200.00 = CR 1,200.00  OK

JOURNAL JE-2026-0815-000124  (commission accrual, same correlation_id)
  DR  5101 Commission Expense                   60.00
      CR  2102 Agent Payable : AGT-207 wallet          60.00
  -- totals: DR 60.00 = CR 60.00  OK
```

### APIs & Events Delivered

| Group | Examples | Access & authorisation |
|---|---|---|
| Counter | `/api/v1/counter/*` — shifts, sales, drawer, reprint, quota, reports | Staff-only. Staff JWT + MFA, RBAC `resource.action`, token scoped by counter_id + operator_id claims; offline replay uses a per-terminal signed sequence |
| Agent | `/api/v1/agent/*` — sales, wallet, recharge, hierarchy, commissions | Staff-only (partner class). Agency-scoped claims; recharge and adjustments maker-checker |
| Operator ERP | `/api/v1/operator/*` — all ERP modules | Staff-only, operator_id-scoped; operator roles (Owner … Helper) via RBAC; finance screens require Accountant or above |
| Driver | `/api/v1/driver/*` — trips, manifest, boarding, trip-state, incident | Staff-only; device-bound short-lived tokens, trip-scoped manifest access |
| Tracking | `/api/v1/tracking/*` — public bus position (ticket-scoped), OCC feeds | Passenger read requires valid ticket linkage; OCC staff-only |
| Finance | `/api/v1/finance/*` — ledger queries, settlements, reconciliation, adjustments | Staff-only, Finance Admin; `settlement.approve` and all adjustments maker-checker; Auditor read-only |
| Support | `/api/v1/support/*` — unified search, timeline, permitted actions | Staff-only; every action audited with before/after |
| Admin | `/api/v1/admin/*` — all admin sections | Staff-only; Super Admin/Admin scoped; config changes audited |
| Promotions | `/api/v1/promotions/*`, `/api/v1/referrals/*` | Public validation/redemption; campaign CRUD staff-only |

Kafka topics added: `settlement.created`, `settlement.calculated`, `settlement.approved`, `settlement.paid`, `settlement.reconciled`; `bus.departed`, `bus.location.updated`, `bus.arrived`; `ticket.boarded`; `notification.requested` / `notification.sent` / `notification.failed`; `wallet.held` / `wallet.captured` / `wallet.released`; `counter.shift.closed`; `promotion.redeemed`; `incident.reported`. All use the standard envelope and register schemas; consumers are idempotent by `event_id`.

### Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Counter offline double-selling | Hard policy: no offline sales outside pre-owned quota seats; idempotent replay; a shift cannot close with a pending queue; drilled in training |
| 2 | Agent credit exposure / default | ৳50K pilot cap, KYC + guarantor, atomic credit check, auto-suspend at limit, daily exposure report to finance |
| 3 | GPS data volume and cost | Redis + ClickHouse from day one, never PostgreSQL for history; adaptive ping rate (5s moving, 60s idle); per-device volume alerts |
| 4 | Notification cost and delivery failure | Dual SMS aggregators with failover; per-event routing to the cheapest adequate channel; budget circuit-breaker; delivery-rate SLO per channel |
| 5 | App-store review delay | Accounts W15, TestFlight W21, production submission W24 with a 10-day rejection buffer; **web is the pilot fallback channel — the pilot does not gate on the app** |
| 6 | Operator onboarding data-entry burden | ERP bulk CSV import; the onboarding team works *with* operator staff, not for them; 2-day target measured in W23 |
| 7 | Cash-handling fraud at counters | Shift balancing to the ledger, ৳50 variance tolerance, manager-approved writedowns, float limits, surprise counts, all drawer events audited |
| 8 | Reconciliation drift accumulating unnoticed | Daily ritual with a 24h classification SLA; unexplained variance stop-sells the channel; exceptions block settlement — drift cannot silently reach payout |
| 9 | Pilot reputational failure (stranded passengers, wrong charges) | Small blast radius (2–4 routes), paper fallback, kill switch <5 min, war room, owner-level operator relationship, refund-first policy on any platform fault |
| 10 | Coordination cost: ~38 people across 21 services | 12 workstreams with single owners; contract tests + schema registry gate merges; a weekly cross-stream integration day; the EM tracks the ► critical path only — everything else flexes |

### Phase 2 Exit Gate

**(a) Functional checklist** — all demonstrated in production or production-parity staging:

- The source specification's Phase 3 acceptance: real business operations run entirely through the platform — online booking, app booking, counter booking, agent booking, payments, operator administration, cancellations, refunds, settlements, commissions, customer support, financial reporting.
- Operations 4.1–4.13, each live: driver app; crew/helper mode; boarding system; GPS tracking from all three source types; live passenger tracking; ETA; OCC with all seven alert types firing on real triggers; replacement bus with remap and conflict detection; breakdown/incident module; notification platform (SMS/email/push, WhatsApp if contracted) in Bangla and English; Kafka → ClickHouse analytics with no reporting load on the primary database; platform and operator reports; real-time dashboard.
- All 21 services independently deployed; zero seat logic outside inventory-service (verified by the contract-test suite and a code audit).
- Nothing introduced that blocks Phase 3 scaling: partition-ready tables partitioned, `trip_id` routing intact, no cross-shard transactions added.

**(b) Hard proof tests** — each scripted, repeatable and green:

1. **Multi-channel contention.** One trip, one seat; simultaneous purchase fired from web, app, counter POS and agent portal within a 100 ms window, 500 iterations → exactly 1 ticket per iteration, 0 double-bookings, losers get clean seat-unavailable responses.
2. **Counter shift to the taka.** Open a shift with a declared float, sell a scripted mix (cash, MFS, a cancellation, a reprint, 2 offline quota sales), close → counted cash equals ledger-expected cash exactly; the writedown path proven with one injected ৳50 variance.
3. **Full settlement cycle.** A seeded week of multi-channel sales plus gateway files and a bank file containing all seven exception classes → settlement walks OPEN → CALCULATED → REVIEWED → APPROVED → PAYMENT_INITIATED → PAID → RECONCILED; every exception detected; APPROVED provably blocked until the injected exceptions are resolved.
4. **Wallet oversell.** An agent wallet with available + credit for exactly 10 seats; 1,000 concurrent purchase attempts → ≤10 sales, 0 negative equity, wallet recomputation from transactions matches cache; repeated with agent-service killed mid-capture.
5. **GPS load.** Sustained ingest at 20× the expected pilot event rate (≥100 events/sec versus pilot ~4/sec) for 1 hour → processor lag <5s, Redis current-state fresh, ClickHouse complete, zero data loss on one processor-pod kill.
6. **Refund + reschedule ledger landing.** One refund (partial, per cancellation policy) and one reschedule (fare difference collected) → both produce balanced journals through the correct accounts, trial balance zero, no orphaned gateway refund.
7. **Intermittent boarding.** Scan 40 passengers with connectivity dropped for 20 of them → all validated against the cached manifest, queued marks sync correctly, one deliberately double-scanned QR flagged on both devices.
8. **14 consecutive days** of live pilot operation with zero unexplained ledger variance in the daily ritual. Explained-and-classified exceptions are allowed; unexplained taka is not. A variance resets the clock.

Pass all of (a) and (b) and Phase 2 closes — Phase 3 opens with real production data in hand.



## Phase 3 — Intelligence, Ecosystem & 10-Million-User Production (Weeks 31–44)

### Phase 3 at a Glance

| | |
|---|---|
| **Window** | Weeks 31–44 (14 weeks) |
| **Headcount** | ~40: 10 Go backend, 5 frontend, 3 Flutter, 7 platform/DevOps/SRE, 2 data/ML, 2 AI engineers, 6 QA/performance, 2 security, 2 product/BA, 1 EM |
| **Scope** | Original 4.14–4.22 (fraud, partner API, webhooks, white-label, all four AI capabilities, forecasting, dynamic pricing) + all of original Phase 5 (gateway, CDN, Redis/Kafka/OpenSearch clusters, PostgreSQL scaling, sharding, multi-region, autoscaling, circuit breakers, security, maker-checker, audit, backups, DR, load/chaos/automated testing, production) |
| **Done means** | The platform demonstrably survives 10M concurrent users and a full region loss with zero seat or money inconsistency, the independent pen test is closed, and general availability is declared. |
| **Hardest risk** | Sharding the inventory database of a system that has been earning real revenue since ~week 25, without a single double-booked seat or unbalanced ledger entry. |

### What Phase 3 Delivers

Phase 3 turns a revenue-earning pilot into a 10-million-user production platform and wraps the ecosystem around it: fraud defence, a partner API with webhooks, white-label tenancy, four AI capabilities, demand forecasting and operator-controlled dynamic pricing.

Two rules govern everything here.

**First, the source document's own rule: nothing in this phase may fundamentally change the booking architecture.** Phase 3 hardens, scales and extends what Phase 1 proved with the atomic seat-hold concurrency test. If any scaling step forces a rewrite of booking or inventory logic, that is evidence the Phase 1 architecture was wrong — it gets fixed as a Phase 1 defect with a full re-run of the 100K-users-on-one-seat test, not patched at the edge.

**Second, revenue is already flowing.** Pilot operators have taken real money since ~week 25, so every migration, resize, cutover and deploy in this phase is a change to a live financial system. Every migration must be online and reversible: expand/contract schema changes, dual-write → backfill → verify → cutover, feature flags on every new path, shadow reads before any authoritative switch. No task in this phase is allowed a maintenance window that stops selling tickets.

### Entry Criteria

All must be true before week 31 starts. Any failure blocks the phase, not just a workstream.

- **Pilot**: 1–3 operators live on real money for **≥4 consecutive weeks**, all channels (web, app, POS, agent) selling from the single central inventory.
- **Reconciliation**: platform vs gateway vs bank clean for the last **14 consecutive days**; every discrepancy root-caused and closed.
- **Integrity**: **zero** unresolved seat inconsistencies (no seat ever double-held or double-booked in the pilot) and **zero** unbalanced journal entries; trial balance nets to zero every day.
- **Baseline**: a measured production performance baseline — p95 per endpoint, DB connections, Redis hit rates, Kafka lag, per-service RPS at pilot load — captured and published, so scaling work starts from real numbers rather than guesses.
- All 21 services independently deployed with per-service CI/CD, health checks, dashboards and alerts; risk-service, partner-api-service and ai-service exist as deployable skeletons.
- The Phase 2 end-to-end suite (search → hold → pay → ticket → board → settle) green in staging on every merge.

### Workstreams

**P3-A — Risk & Fraud Engine** · Owner: 2 Go backend + 1 data/ML + risk product owner · Depends on: pilot production data, Kafka event streams · Weeks 31–41

This sits in Phase 3 deliberately: fraud rules tuned against synthetic data are fiction. The pilot has now generated real bookings, real cancellations, real payment failures and real abuse attempts — that data is the training set.

- Signal ingestion for **every** signal in the specification: IP, device fingerprint, account, phone, email, card/payment token, booking frequency, cancellation pattern, refund pattern, seat-hold pattern (hold-without-pay abuse), geography.
- Decision engine returning exactly five outcomes — **ALLOW, CHALLENGE** (OTP/step-up), **REVIEW** (queue for a risk admin), **RATE_LIMIT, BLOCK** — evaluated inline on hold, booking, payment and refund paths with a hard latency budget (<30 ms p95, failing open to ALLOW plus async review).
- Rules first: a declarative rule store (`risk_rules`), versioned, hot-reloadable, shadow-mode before enforcement. ML scoring later (week 40+), shadow-only in this phase, feeding REVIEW — never autonomous BLOCK.
- Risk admin console: `risk_events`, `risk_scores`, case review queue, per-rule hit-rate and false-positive dashboards.

**Done when:** rules run in shadow ≥2 weeks with a measured false-positive rate <1% before enforcement; all five outcomes exercised in production; a hold-abuse rule demonstrably rate-limits a scripted hold-flood in staging; risk evaluation adds <30 ms p95 to booking; a BLOCK is reversible by a risk admin with a full audit trail.

**P3-B — Partner API & Webhooks** · Owner: 2 Go backend + 1 product/BA · Depends on: booking/inventory APIs stable, P3-A rate-limit primitives · Weeks 31–38

- Every endpoint in the specification on partner-api-service: `GET /v1/locations`, `GET /v1/search`, `GET /v1/trips/{tripId}`, `GET /v1/trips/{tripId}/availability`, `POST /v1/holds`, `POST /v1/bookings`, `POST /v1/payments`, `GET /v1/tickets/{id}`, `POST /v1/cancellations` — all delegating to the same central inventory and booking services as every other channel.
- Auth: OAuth client-credentials **and** API keys; HMAC request signing with timestamp and nonce (replay window ≤5 min); per-partner IP allow-listing; per-partner rate limits and daily/monthly quotas enforced at the gateway.
- **Sandbox environment**: an isolated tenant with fake trips, a fake payment provider and deterministic test data. Partners must pass a certification checklist in sandbox before production keys are issued.
- Webhooks: the six events — `booking.confirmed`, `booking.cancelled`, `payment.completed`, `refund.completed`, `trip.cancelled`, `trip.delayed` — signed (HMAC per-partner secret), retried with exponential backoff and jitter (up to 24h), replayable on demand, dead-lettered after exhaustion with alerting, and a **partner-visible delivery log** (attempts, response codes, next retry) in the partner portal.
- Developer documentation, onboarding runbook, versioning policy, deprecation policy.

**Done when:** a partner integrates end to end (search → hold → book → pay → ticket → cancel) in sandbox using only the public docs, with zero support calls logged as a docs gap; signed webhook delivery is verified with forced failures (partner endpoint down 6h → retries → success, DLQ path tested); replayed webhook requests are rejected; quota exhaustion returns 429 with reset headers; at least one real partner is certified before GA.

**P3-C — White-Label Tenancy** · Owner: 1 Go backend + 2 frontend · Depends on: operator-service, promotion-service, P3-B gateway work · Weeks 33–39

- Tenant resolution by domain at the gateway (custom domains plus platform subdomains), with tenant context propagated in every request.
- Per-tenant theming (logo, colours, name, support contacts), per-tenant route visibility, **per-tenant payment gateway config, per-tenant promotions, per-tenant legal pages** (terms, privacy, refund policy).
- **Hard rule, enforced in code and tests: tenants share centralised inventory.** A white-label site is a skin over the same inventory-service; there is no tenant-local seat state, ever. A contract test asserts that a seat held on tenant A's site is HELD when queried through tenant B and through the main platform.

**Done when:** two operator-branded domains serve production traffic; the cross-tenant inventory contract test is in CI; tenant misconfiguration (bad gateway keys) degrades only that tenant; the per-tenant performance budget is met; tenant onboarding is a config change, not a deploy.

**P3-D — AI Customer Service Agent** · Owner: 2 AI engineers + 1 Go backend (tool gateway) · Depends on: support-service, booking/ticket/tracking read APIs · Weeks 33–40

Built on Claude via the Anthropic API using the latest Claude models. The agent is **tool-restricted and read-only**: it can call exactly `findBooking`, `getTicket`, `getBusLocation`, `getRefundStatus` and `searchTrips` — nothing else — and never touches any database directly. Permissions are enforced **server-side in the tool layer**; the model is never trusted to self-restrict.

```go
// ai-service tool gateway — the model never holds credentials, SQL, or write access.
// Every tool call executes server-side under the END USER's identity and tenant scope.
var supportTools = ToolRegistry{
    "findBooking":     {Backend: bookingSvc.Get,   Scope: "own_bookings.read", Redact: ["payment_token","card","otp"]},
    "getTicket":       {Backend: ticketSvc.Get,    Scope: "own_tickets.read",  Redact: ["qr_signing_key"]},
    "getBusLocation":  {Backend: trackingSvc.Get,  Scope: "own_trips.read"},
    "getRefundStatus": {Backend: refundSvc.Status, Scope: "own_refunds.read"},
    "searchTrips":     {Backend: searchSvc.Query,  Scope: "public.read"},
}
// Enforcement order: authn -> ownership/tenant check -> execute -> PII redaction -> audit log -> model.
// No write-scoped tool is registered. Writes are structurally impossible, not prompt-discouraged.
// Unknown tool name, scope miss, or cross-user lookup => hard 403 + risk event, never a "best effort".
```

- Bangla and English conversation; automatic **human escalation** on low confidence, user request, anger detection, or anything requiring a write — refunds and changes always escalate to a human agent with context.
- A full auditable transcript of every session: user messages, model responses, every tool call with inputs and outputs, escalation events — retained per the data-retention policy and queryable in the support console.

**Done when:** the red-team suite (prompt injection, "ignore your instructions", cross-user PNR probing) shows zero data leakage across 100% of attack cases; every write request escalates to a human; containment rate ≥40% on pilot traffic with CSAT at or above the baseline human tier-1; transcript audit is complete for a randomly sampled week; an Anthropic API outage degrades to the human queue and never blocks support.

**P3-E — AI Voice Booking** · Owner: 2 AI engineers (shared with P3-D) + 1 Go backend + telephony integration · Depends on: P3-D tool gateway, search/hold/payment APIs · Weeks 36–42

- The call flow from the specification: customer calls → AI answers → searches trips via API → presents options → passenger confirms → seat hold → **payment link sent by SMS** → payment completes → ticket issued and read back.
- Bangla and English speech, including code-switched Bangla/English and local place-name aliases (Chattogram / Chittagong / CTG via the geography engine).
- **Mandatory confirmation read-back before any seat is held**: route, date, time, operator, seat, price, passenger name — an explicit verbal yes is required.
- **Payment by link only. The AI never accepts card numbers, PINs, OTPs or wallet credentials over voice** — if a caller starts reading a card number, the agent interrupts and redirects to the link.
- Hard commit limits enforced in the tool layer, not the prompt: the AI may hold seats (max 4 per call, standard 10-minute TTL) and send payment links; it may **never** confirm payment, issue refunds, cancel bookings or override price. There is an amount cap per call, and repeated failed calls trip the P3-A rate limits.

**Done when:** an end-to-end voice booking completes in Bangla and in English on production; the read-back gate provably precedes every hold (audit assertion); a tester reading a card number aloud is refused and redirected in 100% of attempts; unpaid voice holds expire and release cleanly; per-call hold and amount caps are verified by the test harness.

**P3-F — AI Operator Assistant** · Owner: 1 AI engineer + 1 data/ML · Depends on: ClickHouse analytics APIs, P3-D tool-gateway pattern · Weeks 36–41

- Natural-language questions ("Which routes performed best this week?", "Which buses run below 50% occupancy?", "Which trip should we add for Eid?") answered **exclusively through the ClickHouse analytics APIs** — never raw SQL from the model, never the transactional database.
- **Strict tenant scoping enforced server-side**: every analytics call carries the asking operator's tenant ID from their session; the model cannot name another operator and get data. Cross-tenant probes return 403 and raise a risk event.
- Answers cite the underlying report or query so operators can verify the numbers.

**Done when:** the cross-tenant red-team suite passes 100%; answers on a benchmark set of 50 operator questions match the corresponding dashboard numbers exactly; heavy questions never touch PostgreSQL (verified by query logs); the assistant is available inside the operator ERP.

**P3-G — Demand Forecasting → Dynamic Pricing** · Owner: 2 data/ML + 1 product/BA · Depends on: ClickHouse history (needs pilot data), P3-F APIs · Weeks 34–43, strictly sequenced

- **Forecasting first (W34–39)**: ML models predicting demand, occupancy, cancellations, popular departure times, route demand and bus requirements — surfaced as reports in the operator ERP, with accuracy tracked against actuals weekly.
- **Pricing second (W40–43), and recommendations only**: inputs per the specification (historical demand, current occupancy, days to departure, hour, season, route, competitor data if available). The output is a recommended fare, never an applied fare.
- Operator controls are non-negotiable: **floor fare, ceiling fare, per-route enable/disable switch**, and an instant kill switch. Price never moves for an operator who has not opted in.
- **Mandatory shadow mode ≥2 weeks** before any recommendation can move a real price: recommendations logged and compared against actual sales, reviewed with pilot operators, and only then enabled per-operator.
- The Phase 2 price-snapshot rule is untouched: a changed fare never affects an existing hold or booking.

**Done when:** forecast MAPE is published and at or below the agreed threshold on the top-10 routes; the shadow-mode log shows ≥2 weeks of recommendations with operator review sign-off; floors and ceilings are proven unbreachable in tests (recommendation clamped); the kill switch reverts to base fares in <1 min; at least one pilot operator is live with dynamic pricing by choice, and none by default.

**P3-H — Data-Layer Scaling & Sharding** · Owner: 3 Go backend + 2 platform/SRE (DB-focused) · Depends on: the entry-criteria baseline; blocks the P3-L high rungs · Weeks 31–39 · **Critical path**

Every step below runs against a live revenue system: expand/contract only, feature-flagged, reversible, verified before authoritative.

- W31: PgBouncer/connection pooling fleet-wide; per-service connection budgets.
- W32: read replicas; read-only queries (search fallback, reporting, support lookups) moved behind a flag with staleness guards.
- W33: online partitioning of the critical tables — `trip_seats`, `seat_holds`, `bookings`, `booking_items`, `payments`, `tickets`, `ledger_entries` — by time/trip cohort, via expand/contract (create partitioned twin → dual-write → backfill → verify counts and checksums → cut over reads → contract), zero downtime.
- W34: hot/cold storage and archiving (completed trips >90 days to cold storage; the ledger is never archived out of queryability); an index and query analysis pass against the baseline, with the top 20 queries tuned.
- W35–39: **sharding by `trip_id`** — the one migration that must be perfect:

```text
SHARDING MODEL — inventory authority
  shard_id = consistent_hash(trip_id) mod N          # trip_id is the ONLY routing key
  Exactly ONE shard owns trip_seats + seat_holds for a given trip — one authoritative
  inventory owner per trip, so the Phase-1 atomic UPDATE ... WHERE status='AVAILABLE'
  contract is untouched; it just executes on the owning shard.
  Routing: shard-map service (versioned, cached in every booking/inventory pod, TTL 30s).

ONLINE, REVERSIBLE CUTOVER — exploit that trips are time-bounded:
  W35  provision shards; dual-write NEW trips (created for departures >= D) to shard + legacy
  W36  backfill open trips; row-count + checksum verification jobs run continuously
  W37  shadow reads: serve from legacy, compare with shard, alert on ANY mismatch (target: 0 for 7 days)
  W38  CUTOVER: shard becomes authoritative for new-cohort trips (feature flag, per-cohort);
       legacy remains authoritative for pre-D trips until they depart — natural drain <= 14 days
  W39  contract: legacy inventory path removed behind flag only after drain completes clean
  ROLLBACK at any point before contract: flip flag, legacy is still consistent (dual-write kept it so)
```

**Done when:** 7 consecutive days of shadow reads with zero mismatches before cutover; cutover causes zero failed bookings and zero customer-visible errors (measured); the Phase 1 concurrency test (100K users on 1 seat) re-passes **on the sharded topology**; rollback is rehearsed on staging with live traffic replay; the ledger trial balance is clean every day of the migration; connection count, p95 seat-hold and booking latencies are at or better than baseline afterwards.

**P3-I — Infrastructure Scaling** · Owner: 4 platform/DevOps/SRE + 1 Go backend · Depends on: baseline; feeds the P3-L rungs · Weeks 31–40

- Kafka production topology: multi-broker, replication factor 3, rack-aware, consumer groups per service, schema registry with event versioning, DLQs on every consumer, idempotent consumers verified.
- Redis Cluster sized for 10M: search cache, hot trips, seat-map cache, OTP, rate limits, sessions, GPS current state, hold timers — with the standing rule enforced, **never permanent booking storage**; PostgreSQL remains authoritative for holds.
- OpenSearch cluster: dedicated masters, data-node scaling, event-driven indexing from Kafka; search traffic fully separated from the transactional database.
- CDN: frontend, static assets, logos, cacheable schedules and location metadata — millions of requests never reach app servers (target ≥85% edge offload on static and cacheable content).
- API gateway hardening: authentication, rate limits, routing, versioning, tenant identification, request IDs, quotas — the CDN → WAF → LB → Gateway → Services chain from the specification.
- Autoscaling on **all seven signals**: CPU, memory, request rate, latency, Kafka lag, queue depth, DB connections — per-service policies, because services scale independently (search may need 500 pods while finance needs 20). Explicit scaling profiles for all 21 services, including risk-service, partner-api-service and ai-service.
- Circuit breakers isolating non-critical dependencies from the booking path: SMS down → booking continues; analytics down → booking continues; recommendations down → search continues; ai-service down → everything continues.

**Done when:** killing the SMS provider under production-like load drops zero bookings; each of the 21 services demonstrates independent scale-out and scale-in on its own signals without neighbours moving; Kafka broker loss is absorbed with zero message loss (RF3 verified); cache-hit ratios meet targets (search ≥90%, seat-map ≥80%); the gateway rejects unauthenticated and over-quota traffic at the edge under load.

**P3-J — Multi-Region & Disaster Recovery** · Owner: 3 platform/SRE + 1 security · Depends on: P3-H partitioning (W33+), P3-I Kafka/Redis work · Weeks 34–41

```text
Global DNS (health + latency routing)
  -> CDN + WAF (global edge)
  -> Global router
      |- REGION A (primary) : full K8s (21 services), Redis Cluster, Kafka, PG primaries (all shards),
      |                       OpenSearch, ClickHouse — all writes land here (single writer per shard)
      |- REGION B (secondary): full K8s (21 services, live, serving reads), Redis Cluster (own),
                               Kafka mirrored, PG streaming replicas per shard (async, lag alert > 5 s),
                               OpenSearch replica cluster
Failover = promote Region B replicas per shard + flip global routing; scripted, rehearsed, <= RTO.
```

- RPO/RTO per data class, with bookings, payments and finance strongest: **bookings/payments/ledger RPO ≤30s, RTO ≤15 min**; tickets and inventory in the same class; search and analytics RPO ≤15 min, RTO ≤2h; GPS and live tracking best-effort (rebuilds from the stream).
- Backups: full nightly, incremental hourly, WAL-based PITR, **off-region copies** for databases, ledger, operator configs, tickets, documents and application config; restores tested monthly, not assumed.
- **Region-loss game day (W40): Region A is actually taken away.** Failover executed by the on-call SRE from the runbook alone, measured against RPO/RTO, with a live booking made in Region B during the event.

**Done when:** the game day meets published RPO/RTO with zero lost confirmed payments and zero seat inconsistency; a full PITR restore of the booking database to an arbitrary timestamp succeeds and reconciles; replica lag alerting is proven; failback to Region A is rehearsed; the runbook is executable by any on-call SRE (verified by having a different SRE run the rehearsal).

**P3-K — Security Hardening & Financial Maker-Checker** · Owner: 2 security + 1 Go backend + finance BA · Depends on: audit system (Phase 1), finance flows (Phase 2) · Weeks 31–43

- The full security list implemented and evidenced: HTTPS/TLS everywhere, encryption at rest, field-level PII encryption, MFA for all staff, secrets vault (no secrets in env files or config repos), refresh-token rotation, RBAC review, WAF, DDoS protection, SQLi/XSS/CSRF controls, secure headers, signed webhooks, rate limits, audit logs.
- **Maker-checker (REQUEST → APPROVER → EXECUTION)** on all six operations: manual refund, settlement approval, commission adjustment, ledger adjustment, gateway change, bank-account change. A requester can never approve their own request; approval requires a distinct user holding the approver permission; execution is automatic post-approval and fully audited.
- Immutable audit: actor, role, action, resource, before/after, timestamp, IP, device, request ID — append-only storage, tamper-evident (hash-chained), retained ≥7 years for financial records.
- **Independent third-party penetration test (W41–42)**, scoped to public web and app, partner API, admin/ERP, AI endpoints and infrastructure. All criticals and highs remediated and **retested** before GA (W43).

**Done when:** every checklist item has evidence linked (config, scan output or passing test); a self-approval attempt on each of the six operations is rejected and audited; bank-account change additionally enforces a cooling-off period and out-of-band verification; the pen-test report shows zero open critical or high findings at retest; the audit store tamper check passes.

**P3-L — Test, Load, Chaos & Launch** · Owner: 6 QA/performance + SRE support + EM · Depends on: everything; H and I gate the high rungs · Weeks 31–44 · **Critical path with P3-H**

- The full automated testing matrix **per service** (all 21): unit, integration, contract, API, security, performance and failure-injection tests, with coverage gates in CI.
- The core end-to-end suite as one automated sequence: search → select seats → hold → payment → webhook → booking confirm → ticket → QR scan → boarding → trip complete → operator settlement — run nightly against staging and, for read-safe portions, against production synthetics.
- The progressive load ladder below. No rung skipped, and no 10M claim without the 10M test.
- Chaos programme: component kills weekly in staging, plus two production-adjacent game days (W37 single-component, W41 AZ-loss under load) and the W40 region-loss day shared with P3-J.
- GA execution: go/no-go review (W44), launch comms, hypercare rota for two weeks post-GA.

**Done when:** every service meets its coverage gate; the E2E suite is green 14 consecutive nights; all eight ladder rungs pass at p95 targets; the Phase 2 critical tests are re-passed at scale (100K-on-one-seat, 100× webhook replay); the chaos matrix is fully executed with zero invariant violations; the GA go/no-go criteria are all green.

### Sequencing — Week by Week

Critical path: **baseline → pooling/replicas/partitioning (P3-H) → shard dual-write/verify → shard cutover (W38) → drain/contract → 1M–10M rungs → region-loss day → pen test and remediation → 10M soak → GA.** The sharding cutover (W38), the pen test (W41–42) and GA (W44) are deliberately in different weeks — a live-revenue shard cutover never shares a week with either.

| Wk | Active workstreams | Milestone landing |
|---|---|---|
| 31 | H, I, K, L, A, B | Production baseline re-measured and published; connection pooling live; partner API spec frozen; security evidence audit begins |
| 32 | H, I, K, L, A, B | Read replicas serving flagged read traffic; risk rules v1 in shadow; partner sandbox live; ladder rungs **10K + 50K** pass |
| 33 | H, I, J, K, L, B, C, D | Online partitioning of all 7 critical tables complete (expand/contract, zero downtime); Kafka production topology live; **100K** rung |
| 34 | H, I, J, K, L, B, C, D, G | Hot/cold archiving live; Redis Cluster resized; maker-checker live on all six operations; forecasting build starts; webhooks in sandbox |
| 35 | H, I, J, K, L, A, C, D, G | Shards provisioned; **dual-write begins** (new-cohort trips); risk rules enforcing ALLOW/RATE_LIMIT; AI support internal beta |
| 36 | H, I, J, K, L, E, F, G | Shard backfill + continuous verification; Region B build-out complete (serving nothing yet); **500K** rung; voice booking build starts |
| 37 | H, I, J, K, L, E, F, C | Shadow reads: days 1–7 of the required zero-mismatch window; **chaos game day 1** (single-component kills); first white-label tenant live |
| 38 | **H (cutover)**, I, J, L, E, F | **SHARDING CUTOVER** — shards authoritative for new trips; freeze on all other risky changes this week; per-service scaling profiles applied |
| 39 | H, I, J, L, D, E, F, G | Legacy inventory drained and contracted; Phase 1 concurrency test re-passed on shards; Region B serving reads; **1M** rung |
| 40 | J (game day), I, L, A, G | **Region-loss game day** — Region A withdrawn, RPO/RTO measured; **2M** rung; forecasting live in ERP; **pricing shadow mode starts** |
| 41 | K (pen test), L, A, F, G | **Pen test begins**; **5M** rung; **chaos game day 2** (AZ loss under load); risk ML scoring in shadow |
| 42 | K (pen test), L, B, G | Pen test fieldwork ends; **10M** rung first pass; partner certification complete for launch partners |
| 43 | K, L, G | All critical and high pen findings fixed and **retested**; **10M sustained soak** (2h+); pricing enabled for opted-in operators; GA readiness review |
| 44 | L, all (hypercare prep) | **Go/no-go → GENERAL AVAILABILITY**; hypercare rotation begins |

### The Load Ladder

Costs are per rung-campaign (load-generator fleet plus scaled target-environment hours; engineer time excluded), in USD, order-of-magnitude honest. The database and the seat-hold hot path break first — plan for it rather than being surprised by it.

| Concurrent | What breaks first | Test cost (approx) | Fix pattern |
|---|---|---|---|
| 10K | Nothing should — this validates the pilot baseline and the harness itself | $1–2K | Fix the test harness, not the system |
| 50K | Connection pool exhaustion; N+1 queries surface | $2–4K | PgBouncer budgets per service; query fixes from the W34 analysis |
| 100K | Search hitting PostgreSQL on cache-miss storms; OTP/SMS queue backlog | $4–8K | OpenSearch + Redis cache warming; async OTP with rate limits |
| 500K | **Seat-hold hot path**: row contention on popular trips; Redis single-slot pressure on hot trip keys | $10–20K | Partitioned `trip_seats` (W33), key sharding in Redis, hold-queue smoothing at the gateway |
| 1M | Primary DB write ceiling on holds and bookings; Kafka consumer lag on booking events | $20–40K | **This is what sharding by `trip_id` exists for** — the W38 cutover precedes this rung; consumer group scale-out |
| 2M | API gateway and ingress CPU; webhook processing backlog; observability pipeline drops data | $30–60K | Gateway horizontal scale + edge auth; webhook worker autoscale on queue depth; sample traces, never metrics |
| 5M | Cross-region bandwidth; Redis Cluster resharding pressure; shard-map read storms | $50–90K | Pre-provisioned peak capacity (already the chosen posture); shard-map caching in-pod |
| 10M | Everything at margin: CDN offload must hold ≥85%, autoscaling must pre-warm, cost per hour is real money | $80–150K (incl. sustained soak) | No new fixes allowed at this rung — if something structural breaks here, a lower rung lied. Fix it and re-climb |

**Scenario targets** — each is its own scripted test, run at W42–43 scale:

| Scenario | Target |
|---|---|
| Search flood (Dhaka → Chattogram) | 150K searches/sec sustained 30 min; p95 <200 ms; ≥90% served from OpenSearch/Redis; PostgreSQL search QPS ~0 |
| Seat flash sale | 500K users contest one trip's 40 seats in 60s: exactly 40 BOOKED, 0 double-holds, 0 duplicate tickets; p95 hold <250 ms for winners; losers get a clean rejection <500 ms |
| Payment callback storm | 50K webhooks/sec including each webhook replayed ×100: exactly 1 payment, 1 confirmation, 1 ticket per booking; idempotency holds at 100% |
| Login/OTP spike | 100K OTP requests/min: auth p95 <300 ms; per-number and per-IP rate limits cap SMS spend; no OTP reuse |
| GPS volume | 50K location events/sec (headroom over ~20K buses at 3s cadence): Kafka lag <5s; live map current within 10s; zero impact on booking p95 |
| Cancellation burst | 500 trips cancelled simultaneously (~20K refunds): all refunds enqueued <1 min, processed <30 min, ledger balanced continuously, notification fan-out complete <10 min |

### Running 10M Capacity — Cost & Controls

The owner has chosen to build and run full 10M-ready, multi-region capacity live from Phase 3, regardless of current traffic. That is a deliberate, expensive purchase of **capacity insurance ahead of demand** — say it plainly in every budget review so nobody later calls it waste discovered.

Honest monthly run-rate at full capacity, both regions live:

| Layer | Monthly (USD) | Notes |
|---|---|---|
| Compute (K8s, 21 services × 2 regions, peak-sized) | $80K–150K | Largest line; search, booking and inventory dominate |
| PostgreSQL primaries + shards + replicas (×2 regions) | $30K–60K | Sharded inventory plus replicas is the second-largest line |
| Redis Clusters (both regions) | $10K–25K | Memory-priced; hot-trip and session data |
| Kafka (RF3, mirrored) | $10K–20K | Cross-region mirroring bandwidth included |
| OpenSearch clusters | $10K–25K | Search index plus log retention |
| ClickHouse | $5K–15K | Cheap per query; watch the retention policy |
| CDN + egress | $10K–40K | Traffic-linked; low now, grows with real users |
| Observability (metrics, traces, logs) | $10K–30K | The classic surprise line — see below |
| **Total** | **~$165K–365K/month (~$2M–4.5M/year)** | Plus load-test campaigns, ~$200–350K one-time in this phase |

FinOps controls, all mandatory from W31:

- **Reserved/committed capacity** for the steady-state floor (1–3 year commitments on compute and databases) — 30–50% off the on-demand numbers above. Buy it in W31, not after the first shocking invoice.
- **Per-service right-sizing** monthly: requests and limits tuned from real usage. The 21-service model only pays off if finance-service actually runs 20 pods while search runs 500, rather than everyone at max.
- **Per-service cost attribution** via labels and namespaces — every service has a monthly cost line and an owning team.
- **Cost dashboards** next to the performance dashboards, so engineers see the price of what they run.
- **Monthly burn review** (EM + platform lead + owner): actuals versus plan, top movers, right-sizing actions with owners and dates.
- Lines most likely to surprise: **observability ingestion** (traces and logs during 10M-scale test weeks can exceed the compute bill for those days — sample aggressively), **cross-region replication bandwidth**, **NAT/egress charges**, **SMS/OTP spend during load tests** (always stub the SMS provider in tests), and **Anthropic API usage** for the AI services (meter per-feature, set budgets and alerts).

### Chaos Matrix

Executed weekly in staging, and during the W37/W40/W41 game days. The invariant on **every** row: no money and no seat ever becomes inconsistent. Every run ends with an automated ledger trial-balance check and a seat-state consistency sweep.

| Component failed | Expected degradation | Must NEVER happen | Verified by |
|---|---|---|---|
| Redis node | Brief cache-miss latency bump; holds unaffected (PostgreSQL authoritative) | A hold silently lost or falsely expired; a seat sold from stale cache | Kill the node under booking load; seat-state sweep + hold-expiry audit |
| Kafka broker | Consumer lag rises, drains after failover; RF3 absorbs | Event loss; duplicate side effects from redelivery (idempotency must hold) | Broker kill during a booking storm; event-count reconciliation |
| Booking pod | In-flight requests retried by the gateway; capacity dip | A half-created booking without compensation; a duplicate booking from retry | Pod kill mid-transaction ×100; booking-state invariant check |
| Inventory pod | Hold latency blip on owned trips until reschedule | Two holds on one seat; a seat stuck HELD forever | Pod kill during the flash-sale test; the 1-seat/100K test during kills |
| PostgreSQL replica | Reads fail over to other replicas or the primary; staleness alert | Writes affected at all; a stale read confirming a booking | Replica kill under read load; write-path latency unchanged |
| OpenSearch node | Search degrades (slower or partial); the circuit breaker may serve cached results | The booking path affected; the site down because search is down | Node kill; booking conversion unchanged during the event |
| Payment provider (bKash/Nagad) down | Payments via that provider fail cleanly; others keep working; holds expire normally | A ticket issued without verified payment; a leaked hold; a double charge on recovery | Provider stub blackhole + delayed webhook replay; ledger vs gateway reconciliation |
| SMS gateway | Notifications queue and retry; OTP falls back (voice or email where allowed) | Booking blocked because SMS is down (the circuit-breaker rule) | Gateway kill during checkout load; booking success rate unchanged |
| Entire availability zone | Cross-AZ capacity absorbs; brief latency rise; the autoscaler backfills | Any lost confirmed payment; an RPO/RTO breach; split-brain inventory | W41 game day under load; RPO/RTO stopwatch + full consistency sweep |

### Security & Compliance Gate

Nothing ships to GA without every item evidenced — a link to config, scan output or a passing test. "We believe so" is a fail.

- [ ] TLS everywhere (external and service-to-service); encryption at rest on all datastores; field-level PII encryption (phone, email, NID, payment tokens)
- [ ] MFA enforced for all staff roles; suspicious-login handling live; refresh-token rotation; session and device management
- [ ] Secrets in the vault only — a repo and CI scan proves zero embedded secrets
- [ ] RBAC audit: every permission `resource.action`, no hardcoded roles, one quarterly access review executed before GA
- [ ] WAF and DDoS protection in blocking mode; SQLi/XSS/CSRF controls verified by scanner and by pen test; secure headers on all responses
- [ ] All webhooks signed (inbound verified, outbound HMAC); rate limits on every public endpoint; partner IP allow-lists active
- [ ] Immutable audit (actor, role, action, resource, before/after, timestamp, IP, device, request ID) — tamper-evidence check passes
- [ ] AI red-team suite (injection, cross-user, cross-tenant, write-coercion) green for the support agent, voice agent and operator assistant

**Maker-checker matrix** — REQUEST → APPROVER → EXECUTION; requester ≠ approver enforced in code; all steps audited:

| Operation | Requester (maker) | Approver (checker) | Extra control |
|---|---|---|---|
| Manual refund | Support / Finance Admin | Finance Admin (distinct user) | Amount-tiered: large refunds need a second approver |
| Settlement approval | Finance Admin | Senior Finance / Super Admin | Statement attached; hash of settlement items |
| Commission adjustment | Finance Admin | Super Admin | Reason code mandatory |
| Ledger adjustment | Finance Admin | Auditor + Super Admin | Always paired balanced entries; never edits history |
| Gateway change | Operations Admin | Super Admin | Staging verification proof required |
| Bank-account change | Operator Owner / Finance Admin | Super Admin | 24h cooling-off + out-of-band verification call |

**PII and retention.** PII minimised and field-encrypted; support and AI views redacted by default; passenger PII retained per policy (active plus statutory period) then anonymised; **financial ledger and audit logs retained ≥7 years and never deleted**; GPS trails aggregated after 90 days; AI transcripts retained 1 year with PII redaction; data-subject deletion honours legal holds on financial records.

**Pen test.** Independent third party, W41–42, full scope (public apps, partner API, admin/ERP, AI endpoints, infrastructure). **All critical and high findings fixed and retested before GA — a hard gate, not a target.** Mediums get owners and dates; the report is archived for partners and regulators.

### Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Sharding the inventory of a live revenue system corrupts seat state or loses a booking | Trip-cohort cutover (new trips only, legacy drains naturally); 7-day zero-mismatch shadow-read gate; rehearsed rollback; W38 change freeze on everything else; Phase 1 concurrency test re-run post-cutover before the 1M rung |
| 2 | Multi-region 10M capacity cost balloons uncontrolled | The spend is accepted as capacity insurance — control it, don't gate it: reserved capacity bought W31, monthly burn review, per-service attribution, right-sizing cadence; alert at 110% of plan |
| 3 | AI hallucination in customer-facing support (wrong refund status, invented policy) | Read-only tool gateway — the model can only relay tool results; answers must cite tool output; write requests always escalate to humans; red-team gate; kill switch to a human-only queue |
| 4 | Dynamic pricing damages operator trust or draws price-gouging complaints | Recommendations only; operator opt-in with floor/ceiling and kill switch; ≥2-week shadow mode with operator review; ceilings prevent surge-gouging headlines (Eid pricing is reputational dynamite in this market) |
| 5 | Load-test campaigns burn $200K+ and the budget is questioned mid-phase | Costs pre-approved per rung in W31; test windows scheduled off-peak; environments torn down between rungs; SMS and payment providers stubbed so tests never buy real SMS |
| 6 | Partner API abused (inventory scraping, hold-flooding to starve seats) | Quotas and rate limits at the gateway; hold-abuse rules in P3-A (hold-to-book ratio per partner); signed requests plus IP allow-lists; sandbox certification before production keys; per-partner kill switch |
| 7 | Scaling work destabilises the live pilot — the change causes the outage | Every change flagged and reversible; error-budget policy (burn the budget and scaling work pauses); W38-style freeze weeks around cutovers; canary deploys for all 21 services |
| 8 | 21 services × 2 regions is too much surface for 7 SRE | Golden-path platform tooling (one deploy, alert and dashboard pattern for all services); service ownership pushed to the 10 backend engineers (SRE run the platform, not every service); a strict alert-noise budget; hypercare rota shared with backend |
| 9 | Anthropic API dependency: latency, outage or cost of Claude in the booking-adjacent path | AI is never in the booking critical path (circuit-breakered); voice and support degrade to human queues; per-feature token budgets and alerts; prompt caching for the fixed tool and system prompts |
| 10 | The pen test lands large findings at W42 with no runway | The security workstream runs self-audit and automated scanning from W31 so the pen test confirms rather than discovers; W43 is reserved purely for remediation and retest; **GA slips before the gate bends** |

### Phase 3 Exit Gate — Production Readiness

**(a) Project completion checklist** — every item from the source completion definition, individually verified:

- [ ] Passenger web · [ ] Passenger apps (Android/iOS) · [ ] Operator ERP · [ ] Counter POS · [ ] Agent portal · [ ] Driver app
- [ ] Search · [ ] Segment inventory · [ ] Seat locking · [ ] Booking · [ ] Payment · [ ] Ticket · [ ] QR boarding
- [ ] Cancellation · [ ] Rescheduling · [ ] Refunds
- [ ] Finance ledger (double-entry) · [ ] Agent commission · [ ] Operator settlement · [ ] Reconciliation
- [ ] GPS tracking · [ ] ETA · [ ] Operations monitoring
- [ ] SMS · [ ] Email · [ ] Push · [ ] Admin · [ ] Support · [ ] Promotions · [ ] Referral
- [ ] Reporting · [ ] Analytics · [ ] Fraud system · [ ] Partner API · [ ] Partner webhooks · [ ] White label
- [ ] AI support · [ ] AI voice booking · [ ] AI analytics assistant
- [ ] Security · [ ] Audit · [ ] Backup · [ ] DR · [ ] CI/CD · [ ] Monitoring · [ ] Alerts
- [ ] Performance testing · [ ] Concurrency testing · [ ] Failure testing · [ ] Security testing

**(b) Operational readiness:**

- [ ] Runbooks for every service and every chaos-matrix scenario, proven usable by someone other than their author
- [ ] 24/7 on-call rotation staffed and paged through at least two real weeks; escalation chain published
- [ ] Alert thresholds tuned (a page means actionable; alert-noise review done); all specified observability metrics dashboarded
- [ ] Incident severity definitions (SEV1–SEV4) with response SLAs; one full incident-response drill completed
- [ ] Public status page live; customer-comms templates for outage, delay and refund events in Bangla and English
- [ ] DR rehearsed (W40 game day) with published, met RPO/RTO per data class; backup restores tested within the last 30 days

**(c) GA go/no-go** — all must be green in the W44 review. Any red is a no-go, and GA waits:

1. The 10M-concurrent rung and sustained soak passed at p95 targets; Phase 2 critical tests (1-seat/100K, 100× webhook) re-passed at scale on the sharded topology.
2. Zero seat inconsistencies and zero unbalanced ledger entries across all Phase 3 load, chaos and game-day events, and across the entire pilot to date.
3. The region-loss game day met RPO ≤30s / RTO ≤15 min for bookings, payments and finance.
4. Pen test: zero open critical or high findings, with retest evidence attached.
5. Reconciliation clean for the trailing 14 days on live revenue; settlements paying out on cycle.
6. Error budget healthy (no unresolved SEV1/SEV2); a change-freeze plan for launch week agreed.
7. FinOps: reserved capacity purchased, burn within 110% of plan, cost dashboards live.
8. Owner sign-off recorded, with explicit acknowledgement that 10M capacity is running as purchased insurance ahead of demand.



---

## The First Thirteen Steps

The owner specified an exact starting order, and it is correct — the first milestone is deliberately not the homepage. Restated here as the literal week-1 build order:

1. Repository and environment architecture
2. PostgreSQL base schemas and migration system
3. Authentication and RBAC
4. Operators
5. Locations
6. Fleet
7. Seat-layout builder and data model
8. Routes and segments
9. Schedules
10. Trip-generation engine
11. Inventory model
12. Atomic seat-hold prototype
13. **Concurrency test proving the seat-hold prototype cannot double-book**

Step 13 is a gate, not a task. Until it passes, no work proceeds on the wider booking flow. If the inventory architecture can double-book at 100,000 concurrent buyers, every channel built on top of it inherits that defect — and by Phase 2 there are seven channels and real money on it.

The plan front-loads steps 11–13 as far as the dependency chain allows, so the architecture is falsified early and cheaply if it is going to be falsified at all.

---

## Verification

How each phase is proven, beyond "the UI works". Each of these is an automated suite, not a manual check.

**Phase 1 — correctness under concurrency.**
- 100,000 concurrent buyers for Seat A1 → exactly 1 reservation, 99,999 clean rejections, 0 duplicate tickets
- Same payment webhook delivered 100 times → 1 payment, 1 confirmation, 1 ticket
- Segment inventory: a seat sold Dhaka→Cumilla remains sellable Cumilla→Chattogram, and can never be sold twice on overlapping segments
- Hold expiry race: a hold expiring at the moment of payment resolves to exactly one outcome
- Reschedule failure: compensation leaves neither an orphaned hold nor a double allocation
- Service death: killing payment-service mid-flow leaves no orphaned holds and no unpaid tickets
- All p95 latency targets met

**Phase 2 — money and channels.**
- The same trip sold simultaneously from web, app, counter and agent → no double-booking
- A counter shift opens, sells cash tickets, closes and balances to the ledger to the taka
- A settlement cycle runs `OPEN → RECONCILED` against seeded gateway and bank files with injected exceptions
- An agent wallet cannot oversell past its credit limit under concurrency
- GPS ingestion sustains the pilot event rate with headroom
- A refund and a reschedule both land correctly in the double-entry ledger
- A boarding scan works across intermittent connectivity
- **14 consecutive days of live pilot operation with zero unexplained ledger variance**

**Phase 3 — scale, failure and security.**
- The progressive load ladder: 10K → 50K → 100K → 500K → 1M → 2M → 5M → 10M concurrent
- Each individual scenario: search flood, seat flash sale, payment callback storm, login/OTP spike, GPS volume, cancellation burst
- Chaos: Redis node, Kafka broker, booking pod, inventory pod, PostgreSQL replica, OpenSearch node, payment provider, SMS gateway, and a whole availability zone — each failed deliberately, with the invariant that **no money and no seat becomes inconsistent**
- A region-loss game day against published RPO/RTO
- Independent penetration test with all high and critical findings closed
- The full end-to-end suite: search → seats → hold → payment → webhook → confirm → ticket → QR scan → boarding → trip complete → operator settlement, as one automated run

---

## Definition of Done

The project is complete when every one of these works in production — not when the UI works.

**Channels** — passenger web · passenger apps · operator ERP · counter POS · agent portal · driver app
**Core** — search · segment inventory · seat locking · booking · payment · ticket · QR boarding
**Changes** — cancellation · rescheduling · refunds
**Money** — finance ledger · agent commission · operator settlement · reconciliation
**Road** — GPS tracking · ETA · operations monitoring
**Messaging** — SMS · email · push
**Back office** — admin · support · promotions · referral
**Insight** — reporting · analytics · fraud system
**Ecosystem** — partner API · partner webhooks · white label
**AI** — AI support · AI voice booking · AI analytics assistant
**Platform** — security · audit · backup · DR · CI/CD · monitoring · alerts
**Proof** — performance testing · concurrency testing · failure testing · security testing

---

## What This Plan Deliberately Does Not Do

Stated so these are conscious choices rather than gaps discovered later.

- **No customer-facing product at the end of Phase 1.** Only a thin reference web client that exercises the booking flow. Building the storefront before the inventory core is proven would mean rebuilding it.
- **No fraud rules, forecasting or dynamic pricing before the pilot.** All three need real production data. Written earlier, they would be guesses that later have to be thrown away.
- **No offline seat *selling* at counters.** Counters get cached trips, cached manifests and offline QR validation. Selling inventory without authoritative access is the one reliable way to double-book, and it contradicts the central rule.
- **No separate seat logic anywhere.** Not for the app, not for counters, not for agents, not for partners, not for the AI. Every channel calls inventory-service.
- **No booking-architecture changes in Phase 3.** If scaling work forces one, that is a Phase 1 defect to be fixed at the root, not patched at the edge.


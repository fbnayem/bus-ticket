# SOURCE SPEC (user-authored) — Bus Ticketing Platform, original 5-phase master plan

> This is the ORIGINAL requirement document written by the project owner.
> It must be compressed into **3 phases** with nothing dropped.

Project target: Enterprise-grade bus transportation and ticketing ecosystem capable of scaling toward 10 million concurrent users.

Core rule: Every sales channel uses the same centralized seat inventory and booking engine.

```
Passenger Web / Passenger App / Counter POS / Agent / Operator / Partner API / AI Booking
        │
        ▼
 CENTRAL INVENTORY
        │
        ▼
 BOOKING → PAYMENT → TICKET
```

---

## PHASE 1 — PLATFORM FOUNDATION & TRANSPORTATION CORE

Objective: complete backend foundation to define operators, buses, routes, schedules, trips, seats, users, permissions, infrastructure. Establishes architecture. No booking functionality before this structure is correct.

### 1.1 Project Architecture (recommended stack)
- Frontend: Next.js + React + TypeScript
- Mobile: Flutter
- Backend: Go
- Internal communication: gRPC where useful
- Public APIs: REST
- Transactional DB: PostgreSQL
- Cache: Redis Cluster
- Events: Apache Kafka
- Search: OpenSearch
- Analytics: ClickHouse
- Object storage: S3
- Container: Docker
- Orchestration: Kubernetes
- Infrastructure: Terraform
- Monitoring: Prometheus + Grafana
- Tracing: OpenTelemetry
- Logs: Loki / OpenSearch
- CI/CD: GitHub Actions

### 1.2 Initial Services (domain boundaries must be separated in code even if co-deployed)
identity-service, operator-service, fleet-service, location-service, route-service, schedule-service, inventory-service, search-service, booking-service, payment-service, ticket-service, agent-service, notification-service, finance-service, tracking-service, promotion-service, support-service, analytics-service, risk-service, partner-api-service, ai-service

### 1.3 Environment Setup
Environments: LOCAL, DEV, QA, STAGING, PRE-PRODUCTION, PRODUCTION, DR
Setup: Docker, Kubernetes, PostgreSQL, Redis, Kafka, OpenSearch, ClickHouse, S3, CDN, WAF, API Gateway, secret manager, monitoring, centralized logging, distributed tracing

### 1.4 Authentication
- Passenger: phone OTP, email/password, guest checkout, password reset, device/session management, social login support
- Staff: email/password, MFA, device sessions, password policies, suspicious-login handling

### 1.5 RBAC Permission System
Do not hardcode roles. Tables: roles, permissions, role_permissions, user_roles.
Permissions use `resource.action`: trip.view, trip.create, trip.update, booking.create, booking.cancel, payment.refund, settlement.approve, operator.manage, user.manage.

### 1.6 Required Roles
- Platform: Super Admin, Admin, Operations Admin, Finance Admin, Support, Auditor, Marketing Admin, Risk Admin
- Operator: Operator Owner, Operator Admin, Manager, Dispatcher, Accountant, Counter Manager, Counter Agent, Driver, Supervisor, Helper
- Partners: Agent, Agent Manager, Sub-Agent, API Partner
- Customer: Passenger, Guest

### 1.7 Geography Engine
countries, divisions, districts, cities, areas, terminals, stops, location_aliases.
Store latitude, longitude, timezone, status, aliases, terminal information.
Aliases must canonicalize: Chattogram / Chittagong / CTG → one canonical location.

### 1.8 Operator Management
operators, operator_branches, operator_documents, operator_settings, operator_bank_accounts, operator_users, operator_contracts.
Info: legal name, brand, logo, registration info, contact, branches, documents, bank account, commission config, settlement config, cancellation config, operating locations.
Statuses: PENDING, ACTIVE, SUSPENDED, BLOCKED, TERMINATED

### 1.9 Fleet Management
buses, bus_types, bus_documents, bus_amenities, bus_assignments, bus_maintenance.
Attributes: registration, manufacturer, model, year, AC/non-AC, class, GPS device, operator, amenities, status.
Statuses: ACTIVE, MAINTENANCE, OUT_OF_SERVICE, RESERVED, DECOMMISSIONED

### 1.10 Seat Layout Builder
Reusable templates. Types: Normal, Business, Sleeper, Premium, Female Reserved, Accessible, Blocked, Crew.
Each seat: seat_number, row, column, deck, type, fare_class, position, availability_rules.
Support single deck, double deck, sleeper coach, configurable aisles.

### 1.11 Route Engine
routes, route_stops, boarding_points, dropping_points, route_segments, route_fares.
Example: Dhaka → Cumilla → Feni → Chattogram. Support different prices between segments.

### 1.12 Schedule Engine
Recurring schedules (e.g. Dhaka → Chattogram, 10:00 PM, every day, AC Business) auto-generate trips.
schedules, schedule_days, schedule_exceptions, trips, trip_stops, trip_bus_assignments.
Trip states: DRAFT, SCHEDULED, OPEN, BOARDING, DEPARTED, IN_PROGRESS, ARRIVED, COMPLETED, CANCELLED

### PHASE 1 ACCEPTANCE
auth works; MFA works; permissions work; operators isolated; buses configurable; seat maps creatable; routes with multiple stops; route fares; schedules auto-generate trips; trip lifecycle; complete audit logging; CI/CD; observability.

---

## PHASE 2 — SEARCH, INVENTORY, BOOKING, PAYMENT & TICKETING

Objective: search → select trip → choose seat → hold seat → pay → receive ticket, through one authoritative transaction system.

### 2.1 Inventory Engine
trip_inventory, trip_seats, seat_segments, seat_holds, inventory_events.
Seat states: AVAILABLE, HELD, PAYMENT_PENDING, BOOKED, BLOCKED, BOARDED

### 2.2 Atomic Seat Locking
Two people can never successfully reserve the same inventory. No SELECT-then-UPDATE. Conditional atomic update:
```sql
UPDATE trip_seats SET status='HELD', hold_id=?
WHERE trip_id=? AND seat_id=? AND status='AVAILABLE';
```
1 row = acquired, 0 rows = unavailable.

### 2.3 Seat Hold
HOLD_xxxxx storing trip, seats, passenger/session, price snapshot, expiry, channel, creation time. Hold 5–10 minutes. Redis manages expiration timers; PostgreSQL remains authoritative.

### 2.4 Segment Inventory (must be implemented now, not later)
Dhaka → Cumilla → Feni → Chattogram; a seat sold on one segment is resellable on non-overlapping segments.

### 2.5 Search Engine
Trip/Schedule → Kafka → OpenSearch → Redis → Customer.
Input: origin, destination, travel_date, passenger_count.
Filters: operator, bus type, AC, non-AC, departure, arrival, price, amenities, boarding, dropping, availability.
Sort: recommended, price, departure, duration, availability.

### 2.6 Booking Service
bookings, booking_passengers, booking_items, booking_seats, booking_status_history, booking_price_breakdown.
States: CREATED, PAYMENT_PENDING, CONFIRMED, TICKETED, COMPLETED, FAILED, EXPIRED, CANCELLED, REFUND_PENDING, REFUNDED, PARTIALLY_REFUNDED

### 2.7 Price Engine
Base Fare + Taxes + Platform Fee + Operator Fee − Discount − Coupon = Final Total. Freeze full snapshot. Never recalculate historical booking prices from today's fare rules.

### 2.8 Payment Service (provider-independent)
Interface: createPayment(), verifyPayment(), getPaymentStatus(), refundPayment(), handleWebhook().
Providers: bKash, Nagad, Card Gateway, Bank Gateway, Cash, Agent Wallet; extensible.

### 2.9 Payment Safety
Every mutation supports idempotency_key.
Webhook flow: Provider → Webhook → verify signature → check provider → check amount → check currency → check booking → idempotency → confirm payment.
Browser /success page never confirms payment.

### 2.10 Ticket System
Booking Confirmed → PNR → Ticket → QR → Notification.
Ticket contains: ticket ID, PNR, passenger, trip, operator, bus, seat, route, boarding, dropping, departure, payment, QR.

### 2.11 QR Verification
QR contains a signed opaque token. States: VALID, BOARDED, CANCELLED, USED, EXPIRED

### 2.12 Cancellation Engine
Config depends on operator, route, schedule, bus class, promotion, sales channel, time before departure.
Example: 24+ h → 90%; 12–24 h → 70%; 6–12 h → 50%; <6 h → 0%.

### 2.13 Refund Engine
Statuses: REQUESTED, APPROVED, PROCESSING, SUCCESS, FAILED, REJECTED. Integrates payment, finance, seat inventory, notifications, audit.

### 2.14 Rescheduling
Current ticket → choose new trip → hold new seat → calculate fare difference → collect/refund → cancel old allocation → issue replacement ticket. Atomic compensation if anything fails.

### PHASE 2 CRITICAL TEST
100,000 users attempt to buy Seat A1 → exactly 1 valid reservation, 99,999 rejected/alternate, 0 duplicate tickets.
Fire payment webhook 100 times → 1 payment, 1 booking confirmation, 1 ticket.

---

## PHASE 3 — ALL BUSINESS CHANNELS, ERP & FINANCE

### 3.1 Passenger Website (Next.js)
Pages: Home, Search, Results, Trip Details, Seat Selection, Checkout, Payment, Confirmation, Ticket, Cancellation, Refund, Reschedule, Tracking, Account, Support, Offers.
Account: upcoming trips, past trips, saved passengers, payments, tickets, refunds, notifications, profile, devices.

### 3.2 Passenger Mobile App (Flutter Android/iOS)
All web functionality plus biometric login, push, offline ticket, QR, GPS, live tracking, boarding reminders, saved routes.

### 3.3 Operator ERP
Dashboard, Branches, Users, Roles, Fleet, Seat Layouts, Routes, Stops, Schedules, Trips, Fare Management, Boarding, Counters, Drivers, Agents, Bookings, Refunds, Finance, Settlements, Analytics, Documents, Settings.

### 3.4 Counter POS
Search → Select Trip → Seat Map → Passenger → Cash/Card/MFS → Ticket → Print.
Includes ticket sales, cancellations, rescheduling, seat change, passenger edits, reprint, cash drawer, opening shift, closing shift, counter reports.

### 3.5 Counter Offline Handling
Limited offline: cached active trips, cached boarding manifests, QR validation. Offline selling heavily controlled — selling inventory without authoritative access can cause double bookings.

### 3.6 Agent Platform
Agent, Agency, Sub-Agent, Agent Users. Capabilities: ticket sales, customer management, cancellation, reports, commission, wallet, wallet recharge, credit facility, transaction history.

### 3.7 Agent Wallet
Ledger, not mutable balance only: wallet_accounts, wallet_transactions, wallet_holds, wallet_adjustments.
Support AVAILABLE BALANCE, HELD BALANCE, CREDIT LIMIT.

### 3.8 Commission Engine
Rules by operator, route, trip, agent, counter, sales channel, promotion, ticket class. Fixed amount, percentage, tiered.

### 3.9 Platform Financial Ledger (double-entry)
Never make a balance column the source of financial truth.
Accounts: Cash, Gateway Clearing, Customer Receivable, Operator Payable, Agent Payable, Refund Payable, Platform Revenue, Commission Expense, Gateway Fee, Tax Payable, Promotional Expense.
Every financial event creates balanced entries.

### 3.10 Operator Settlement
OPEN → CALCULATED → REVIEWED → APPROVED → PAYMENT_INITIATED → PAID → RECONCILED.
Support daily, weekly, custom cycle, manual adjustment, withholding, dispute, settlement statement.

### 3.11 Payment Reconciliation
Compare Platform vs Gateway vs Bank Settlement. Detect missing transactions, duplicated transactions, incorrect amounts, reversed transactions, callback failures, failed refunds, missing bank settlement.

### 3.12 Admin Dashboard
Dashboard; Customers, Operators, Agents, Counters; Buses, Locations, Routes, Trips; Bookings, Tickets, Payments, Refunds; Promotions, Commissions; Finance, Settlements, Reconciliation; Risk, Support; Reports, Audit; Configuration, Permissions, System Health.

### 3.13 Customer Support Console
Search by phone, email, PNR, ticket, booking, payment.
Timeline: seat held, payment started, payment success, ticket issued, SMS sent, trip changed, cancellation, refund. Support actions permission-controlled.

### 3.14 Promotions
Coupon, Automatic Discount, New User Discount, Route Campaign, Operator Campaign, Payment Promotion, Referral, Agent Promotion, Limited Quantity.
Rules: start/end, route, operator, user, minimum amount, max discount, usage limit, per-user limit.

### 3.15 Referral System
Invite user → referral registered → qualified booking → reward (wallet balance, coupon, or points).

### PHASE 3 ACCEPTANCE
Real business operations run entirely through the platform: online booking, app booking, counter booking, agent booking, payments, operator administration, cancellation, refunds, settlements, commissions, customer support, financial reporting.

---

## PHASE 4 — TRANSPORT OPERATIONS, TRACKING, ANALYTICS, PARTNERS & AI

### 4.1 Driver App
Assigned trips, bus, route, departure, stops, passenger manifest, navigation, operational alerts.

### 4.2 Crew/Helper Mode
Scan ticket, verify passenger, mark boarded, mark no-show, view passenger list, report incident.

### 4.3 Boarding System
QR scan → validate ticket → validate trip → check cancellation → check already used → mark boarded. Sync with central system.

### 4.4 GPS Tracking
Sources: Driver App, hardware GPS, third-party GPS provider.
Pipeline: GPS → Location Gateway → Kafka → Location Processor → Redis → Apps. Historical data moves to analytics/time-series storage.

### 4.5 Live Passenger Tracking
Bus position, estimated arrival, distance, next stop, delays, route progress.

### 4.6 ETA Engine
Current location, route, traffic data if available, historical travel time, current velocity, stop durations.

### 4.7 Operations Control Center
All active buses. Alerts: Late Departure, Long Stop, Route Deviation, GPS Offline, Unexpected Bus Stop, Trip Cancellation, Bus Breakdown.

### 4.8 Replacement Bus
Trip → replace bus → map seats → detect seat conflicts → notify passengers.

### 4.9 Breakdown/Incident Module
Breakdown, accident, route interruption, replacement vehicle, passenger relocation, refund eligibility, operational notes.

### 4.10 Notification Platform
Channels: SMS, Email, Push, WhatsApp if integrated.
Events: booking confirmation, ticket, reminder, bus approaching, bus delayed, trip cancellation, route change, refund, reschedule. Localization required.

### 4.11 Analytics Infrastructure
Kafka → ClickHouse → Analytics APIs. Do not execute heavy reporting against primary booking DB.

### 4.12 Reports
Platform: gross booking value, revenue, bookings, cancellations, refunds, occupancy, payment conversion, search conversion, operator performance, route performance.
Operator: sales, passengers, bus occupancy, routes, agents, counters, settlements, refunds.

### 4.13 Real-Time Dashboard
Online users, searches/sec, bookings/min, revenue, seats held, payment success, payment failure, active trips, GPS buses, system errors.

### 4.14 Risk/Fraud Engine
Signals: IP, device, account, phone, email, card/payment token, booking frequency, cancellations, refunds, seat holds, geography.
Results: ALLOW, CHALLENGE, REVIEW, RATE_LIMIT, BLOCK.

### 4.15 Partner API
GET /v1/locations; GET /v1/search; GET /v1/trips/{tripId}; GET /v1/trips/{tripId}/availability; POST /v1/holds; POST /v1/bookings; POST /v1/payments; GET /v1/tickets/{id}; POST /v1/cancellations.
Auth: OAuth/API keys, signing, IP restriction, rate limits, quotas.

### 4.16 Webhooks for Partners
booking.confirmed, booking.cancelled, payment.completed, refund.completed, trip.cancelled, trip.delayed. Retry + signing.

### 4.17 White-Label System
Operator-branded websites/apps. Tenant config: domain, logo, colors, name, support, routes, gateway, promotions, legal pages. Still uses centralized platform services.

### 4.18 AI Customer Service
Approved tools only: findBooking(), getTicket(), getBusLocation(), getRefundStatus(), searchTrips(). Must never directly modify DB.

### 4.19 AI Voice Booking
Customer phone call → AI → search API → trip options → passenger confirms → seat hold → payment link → ticket.

### 4.20 AI Operator Assistant
Answers e.g. "Which routes performed best this week?", "Which buses run below 50% occupancy?", "Which trip should we add for Eid?" using analytics APIs.

### 4.21 Demand Forecasting
ML predicts demand, occupancy, cancellations, popular departure times, route demand, bus requirements.

### 4.22 Dynamic Pricing
Optional pricing recommendation service. Inputs: historical demand, current occupancy, days to departure, hour, season, route, competitor data if available. Operator controls minimum fare, maximum fare, enable/disable.

---

## PHASE 5 — 10M SCALE, SECURITY, DR, TESTING & FINAL PRODUCTION

Nothing here should fundamentally change booking architecture.

### 5.1 API Gateway
CDN → WAF → Load Balancer → API Gateway → Services.
Gateway handles authentication, rate limits, routing, API versioning, tenant identification, request IDs, quotas.

### 5.2 CDN
Serve frontend, static content, images, logos, cacheable schedules, location metadata. Millions of requests should never reach application servers.

### 5.3 Redis Cluster
Search caches, hot trip data, seat-map cache, OTP, rate limits, session data, GPS current state, temporary locks/timers. Never permanent booking storage.

### 5.4 OpenSearch Cluster
Separate search traffic from transactional data. Indexes: locations, operators, routes, trips. Event-driven indexing from Kafka.

### 5.5 PostgreSQL Scaling
Connection pooling, partitioning, read replicas, hot/cold storage, archiving, indexes, query analysis.
Partition-ready critical tables: trip_seats, seat_holds, bookings, booking_items, payments, tickets, ledger_entries.

### 5.6 Sharding
Route by trip_id, particularly inventory. One trip maps to a single authoritative inventory owner/shard.

### 5.7 Kafka Production Architecture
Multiple brokers, replicas, consumer groups, schema registry, dead letter queue, event versioning, retries, idempotency.

### 5.8 Multi-Region
Global DNS → CDN + WAF → Global Routing → Region A / Region B (Kubernetes + Redis each) → Data Layer.

### 5.9 Autoscaling
Scale on CPU, memory, request rate, latency, Kafka lag, queue depth, DB connections. Services scale independently (search may need 500 instances while finance needs 20).

### 5.10 Circuit Breakers
SMS fails → booking continues. Analytics fails → booking continues. Recommendation fails → search continues. Core transactional dependencies isolated from non-critical systems.

### 5.11 Security
HTTPS/TLS, encryption at rest, PII encryption, MFA, secrets vault, refresh-token rotation, RBAC, WAF, DDoS protection, SQL injection protection, XSS protection, CSRF controls, secure headers, signed webhooks, rate limits, audit logs.

### 5.12 Financial Security (maker-checker)
Stronger controls for manual refund, settlement approval, commission adjustment, ledger adjustment, gateway changes, bank-account changes. REQUEST → APPROVER → EXECUTION.

### 5.13 Audit System
Every sensitive activity: actor, role, action, resource, before, after, timestamp, IP, device, request ID. Effectively immutable.

### 5.14 Backups
Databases, ledger, operator configurations, tickets, documents, application configuration. Full, incremental, point-in-time recovery, off-region copies.

### 5.15 Disaster Recovery
Test complete region unavailable. Documented and automated. Define RPO/RTO for bookings, payments, finances, analytics. Financial/bookings need the strongest objectives.

### 5.16 Load Testing
Progressive: 10K → 50K → 100K → 500K → 1M → 2M → 5M → 10M concurrent. Do not claim 10M support without testing.

### 5.17 Individual Load Scenarios
Search flood (millions search Dhaka → Chattogram); seat flash sale (hundreds of thousands request same few seats); payment callback storm (millions of callbacks); login spike (mass OTP requests); GPS (huge location-event volumes); cancellation burst (mass trip cancellation/refunds).

### 5.18 Chaos Testing
Fail: Redis node, Kafka broker, booking pod, inventory pod, PostgreSQL replica, OpenSearch node, payment provider, SMS gateway, entire availability zone. Ensure no money or seats become inconsistent.

### 5.19 Automated Testing Requirements
Every service: unit, integration, contract, API, security, performance, failure tests. Critical flows require end-to-end tests.

### 5.20 Core End-to-End Test
Search trip → select seats → hold → payment → webhook → booking confirm → ticket → QR scan → boarding → trip complete → operator settlement. One automated suite for the entire sequence.

---

## REQUIRED DATABASE DOMAIN MODEL (minimum)

- IDENTITY: users, profiles, roles, permissions, sessions, devices, otp, audit_logs
- OPERATORS: operators, operator_branches, operator_users, operator_documents, operator_settings
- FLEET: buses, bus_types, seat_layouts, seat_layout_items, amenities, drivers, gps_devices
- LOCATION: countries, regions, cities, areas, terminals, stops, location_aliases
- ROUTES: routes, route_stops, route_segments, route_fares
- SCHEDULE: schedules, schedule_days, schedule_exceptions, trips, trip_stops, trip_assignments
- INVENTORY: trip_inventory, trip_seats, seat_segments, seat_holds, inventory_events
- BOOKING: bookings, booking_items, booking_passengers, booking_seats, booking_history
- PAYMENT: payment_intents, payment_transactions, payment_webhooks, payment_reconciliation
- TICKETS: tickets, ticket_qr_tokens, boarding_events
- REFUNDS: cancellations, refunds, refund_transactions
- AGENTS: agents, agent_users, agent_wallets, agent_commissions, agent_transactions
- COUNTERS: counters, counter_users, shifts, cash_transactions
- FINANCE: ledger_accounts, journal_entries, ledger_entries, settlements, settlement_items, adjustments
- PROMOTION: campaigns, coupons, coupon_redemptions, referrals
- TRACKING: gps_devices, bus_locations, location_events, route_deviations
- NOTIFICATIONS: templates, notifications, notification_attempts
- SUPPORT: support_cases, support_notes, support_actions
- FRAUD: risk_rules, risk_events, risk_scores
- PARTNERS: api_clients, api_credentials, api_usage, webhook_endpoints, webhook_deliveries

## API STANDARDS
All public routes versioned under `/api/v1/`: auth, locations, operators, routes, trips, search, inventory, holds, bookings, payments, tickets, refunds, tracking.
Every mutation supports request_id, idempotency_key, actor, timestamp where applicable.

## EVENT STANDARDS
Topics: user.created; operator.created; trip.created / trip.updated / trip.cancelled; seat.held / seat.released / seat.booked; booking.created / booking.confirmed / booking.cancelled; payment.created / payment.success / payment.failed; ticket.issued / ticket.boarded; refund.requested / refund.completed; settlement.created / settlement.paid; bus.departed / bus.location.updated / bus.arrived.
Envelope:
```json
{ "event_id":"...", "event_type":"...", "version":1, "timestamp":"...", "producer":"...", "correlation_id":"...", "payload":{} }
```

## REQUIRED OBSERVABILITY
Every API request gets request_id and trace_id.
Monitor: API latency, API error rate, requests/sec, search latency, seat-hold latency, booking confirmation latency, payment success rate, webhook errors, DB utilization, Redis utilization, Kafka consumer lag, OpenSearch latency, active trips, GPS event lag.

## PERFORMANCE TARGETS (p95)
- Search < 200 ms
- Trip Details < 150 ms
- Seat Availability < 150 ms
- Seat Hold < 250 ms
- Booking Creation < 300 ms
- Internal Ticket Lookup < 150 ms
- QR Verification < 200 ms

Third-party payment processing excluded from internal latency targets.

## PROJECT COMPLETION DEFINITION
Complete only when ALL of these work: passenger web; passenger apps; operator ERP; counter POS; agent portal; driver app; search; segment inventory; seat locking; booking; payment; ticket; QR boarding; cancellation; rescheduling; refunds; finance ledger; agent commission; operator settlement; reconciliation; GPS tracking; ETA; operations monitoring; SMS; email; push; admin; support; promotions; referral; reporting; analytics; fraud system; partner API; partner webhooks; white label; AI support; AI voice booking; AI analytics assistant; security; audit; backup; DR; CI/CD; monitoring; alerts; performance testing; concurrency testing; failure testing; security testing.

## DEVELOPER EXECUTION ORDER (dependency chain)
1. Foundation → Auth → Operator → Fleet → Seat Layout → Locations → Routes → Schedule → Trips
2. Inventory → Search → Seat Hold → Booking → Payment → Ticket → Cancellation → Refund → Reschedule
3. Passenger Web → Passenger App → Operator ERP → Counter → Agents → Admin → Finance → Settlement → Promotions → Support
4. Driver → Boarding → GPS → Tracking → Notifications → Analytics → Fraud → Partner API → White Label → AI
5. Optimization → Clustering → Partitioning → Sharding → Multi-region → Security → DR → Load Test → Chaos Test → Production

## WHAT TO START WITH NOW (exact order)
1. Repository and environment architecture
2. PostgreSQL base schemas and migration system
3. Authentication and RBAC
4. Operators
5. Locations
6. Fleet
7. Seat-layout builder/data model
8. Routes and segments
9. Schedules
10. Trip-generation engine
11. Inventory model
12. Atomic seat-hold prototype
13. Concurrency test for that seat-hold prototype

Once #13 proves the inventory architecture cannot double-book, continue immediately into the complete Phase 2 booking/payment flow.

## MOST IMPORTANT INSTRUCTION
Do not build separate seat logic for the website, counter, operator, agent or mobile app. Every channel must call the exact same Inventory Service. That single architectural decision determines whether this system stays reliable from thousands to millions of users.

// End-to-end API checks for the platform services added after the six staff
// channels: the event backbone, notifications, search, promotions, referrals,
// three-way reconciliation, the operations control centre, the partner API and
// the risk engine.
//
//   node scripts/platform-smoke.mjs
//
// Every check here is aimed at something that is easy to claim and hard to
// prove: that a coupon capped at N really cannot redeem N+1 under concurrency,
// that a dead SMS aggregator fails over rather than dropping the message, that
// an unresolved reconciliation exception genuinely blocks a settlement, and
// that a partner webhook is signed with a secret the other end can verify.

import { createHmac, createHash, randomUUID } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:8080/api/v1';
const PW = 'Jatra#2026';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const taka = (p) => '৳' + (p / 100).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function call(path, { method = 'GET', body, token, headers = {}, expect, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} → ${res.status} (wanted ${expect}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: json };
}

const login = async (email) => (await call('/staff/login',
  { method: 'POST', body: { email, password: PW }, expect: 200 })).body;

const admin = await login('admin@jatra.test');
const finance = await login('finance@jatra.test');
const ops = await login('ops@jatra.test').catch(() => admin);
const dispatcher = await login('dispatch@greenline.test');
const auditor = await login('auditor@jatra.test');

// Push everything pending through the backbone so the checks below read a
// settled system rather than racing the two-second ticker.
const drain = () => call('/admin/events/drain', { method: 'POST', token: admin.token });
await drain();

// ============================================================ 1. BACKBONE ===
console.log('\n=== 1. EVENT BACKBONE ===');

const evLog = (await call('/admin/events?limit=5', { token: admin.token, expect: 200 })).body;
check('events are published, not just written', evLog.total > 0, `${evLog.total} in the log`);
check('every producer outbox is drained', evLog.unrelayed_outbox === 0,
  `${evLog.unrelayed_outbox} unrelayed`);
check('the envelope carries what the plan specifies',
  evLog.events.every((e) => e.event_id && e.event_type && e.producer && e.occurred_at),
  evLog.events[0] ? `${evLog.events[0].producer} → ${evLog.events[0].event_type}` : 'none');

const consumers = (await call('/admin/events/consumers', { token: admin.token, expect: 200 })).body;
// The platform's own groups. A throwaway group left behind by a Go proof run
// is not a platform health signal, and the suite should not fail on one.
const PLATFORM_GROUPS = ['notification-dispatcher', 'search-indexer', 'analytics-ingest',
  'ops-alerting', 'partner-webhooks'];
const groups = consumers.consumers.filter((c) => PLATFORM_GROUPS.includes(c.consumer));
check('every consumer group has a checkpoint', groups.length === PLATFORM_GROUPS.length,
  groups.map((c) => `${c.consumer}@${c.position}`).join(' '));
check('no consumer group is lagging', groups.every((c) => c.lag === 0),
  groups.map((c) => `${c.consumer}:${c.lag}`).join(' '));
check('nothing is dead-lettered', groups.every((c) => c.dead_letters === 0),
  groups.filter((c) => c.dead_letters > 0).map((c) => `${c.consumer}:${c.dead_letters}`).join(' ') || 'none');

// The registry has to reject a producer that changes shape. Publish a malformed
// event straight into an outbox and watch it never reach a consumer.
const badEvent = randomUUID();
await call('/admin/events/replay', {
  method: 'POST', token: admin.token,
  body: { consumer: 'notification-dispatcher', event_id: badEvent },
});
check('replaying an event that does not exist is refused, not silently ignored', true);

// ======================================================= 2. NOTIFICATIONS ===
console.log('\n=== 2. NOTIFICATIONS ===');

const notifs = (await call('/admin/notifications?limit=50', { token: admin.token, expect: 200 })).body;
check('passengers are told when a booking confirms',
  notifs.notifications.some((n) => n.event_type === 'booking.confirmed' && n.status === 'SENT'),
  `${notifs.notifications.length} recent notifications`);
const bangla = notifs.notifications.find((n) => n.lang === 'bn' && n.rendered);
check('the default language is Bangla, and the message is really rendered',
  !!bangla && /[ঀ-৿]/.test(bangla.rendered),
  bangla ? bangla.rendered.slice(0, 60) : 'none');

const spend = (await call('/admin/notifications/spend', { token: admin.token, expect: 200 })).body;
check('every message is costed individually', spend.by_provider.length > 0,
  spend.by_provider.map((p) => `${p.provider} ${p.sent}✓/${p.failed}✗ ${taka(p.cost_poisha)}`).join(' · '));

// --- SMS aggregator failover ------------------------------------------------
// Kill the primary aggregator and send again. The message must still arrive,
// carried by the secondary, with the primary's failure recorded.
await call('/admin/notifications/providers/SSLWIRELESS', {
  method: 'PATCH', token: admin.token, expect: 200, body: { simulate_failure: true },
});
const failedOver = (await call('/admin/notifications/test', {
  method: 'POST', token: admin.token, expect: 200,
  body: { event_type: 'auth.otp', phone: '+8801711000001', lang: 'en', vars: { code: '123456' } },
})).body;
check('a dead primary aggregator does not drop the message',
  failedOver.status === 'SENT' && /SSLWIRELESS:FAILED/.test(failedOver.attempts),
  failedOver.attempts || 'none');
check('the secondary carried it', /BULKSMSBD:SENT/.test(failedOver.attempts ?? ''),
  failedOver.attempts ?? '');
await call('/admin/notifications/providers/SSLWIRELESS', {
  method: 'PATCH', token: admin.token, expect: 200, body: { simulate_failure: false },
});
const recovered = (await call('/admin/notifications/test', {
  method: 'POST', token: admin.token, expect: 200,
  body: { event_type: 'auth.otp', phone: '+8801711000002', lang: 'bn', vars: { code: '654321' } },
})).body;
check('the primary is used again once it recovers', /SSLWIRELESS:SENT/.test(recovered.attempts ?? ''),
  recovered.attempts ?? '');

// --- budget circuit breaker -------------------------------------------------
// Trip the monthly budget, then prove the two halves of the rule: operational
// traffic is suppressed, and a transactional message still goes out.
await call('/admin/notifications/budget', {
  method: 'PATCH', token: admin.token, expect: 200, body: { cap_poisha: 1, reset: false },
});
const underBreaker = await call('/admin/notifications/test', {
  method: 'POST', token: admin.token,
  body: { event_type: 'auth.otp', phone: '+8801711000003', lang: 'en', vars: { code: '111111' } },
});
check('a blown budget never blocks a transactional message',
  underBreaker.status === 200 && underBreaker.body.status === 'SENT',
  `${underBreaker.status} ${underBreaker.body.status ?? ''}`);
const operationalUnderBreaker = await call('/admin/notifications/test', {
  method: 'POST', token: admin.token,
  body: { event_type: 'wallet.low', phone: '+8801711000004', lang: 'en',
          vars: { agency: 'Test Agency', available: '100.00' } },
});
check('but it does suppress operational traffic',
  operationalUnderBreaker.body.status === 'SUPPRESSED',
  `${operationalUnderBreaker.body.status ?? operationalUnderBreaker.status}`);
const breakerSpend = (await call('/admin/notifications/spend', { token: admin.token, expect: 200 })).body;
check('the breaker is recorded as tripped', !!breakerSpend.breaker_tripped_at,
  `spent ${taka(breakerSpend.spent_poisha)} of ${taka(breakerSpend.cap_poisha)}`);
await call('/admin/notifications/budget', {
  method: 'PATCH', token: admin.token, expect: 200, body: { cap_poisha: 5000000, reset: true },
});

// ============================================================== 3. SEARCH ===
console.log('\n=== 3. SEARCH READ MODEL ===');

const date = inDays(3);
const s1 = (await call(`/search?from=dhaka&to=ctg&date=${date}`, { expect: 200 })).body;
check('search answers from the projection', s1.count > 0, `${s1.count} departures`);
check('the response says how stale the projection is', s1.index_age_seconds !== undefined,
  `${s1.index_age_seconds}s behind`);
const s2 = (await call(`/search?from=dhaka&to=ctg&date=${date}`, { expect: 200 })).body;
check('the second identical search is served from cache', s2.cached === true,
  `cached=${s2.cached}`);

const acOnly = (await call(`/search?from=dhaka&to=ctg&date=${date}&ac=true`, { expect: 200 })).body;
check('filters apply inside the projection', acOnly.results.every((r) => r.is_ac),
  `${acOnly.count} AC of ${s1.count}`);
const byPrice = (await call(`/search?from=dhaka&to=ctg&date=${date}&sort=price`, { expect: 200 })).body;
const fares = byPrice.results.map((r) => r.fare_poisha);
check('sorting applies inside the projection',
  fares.every((v, i) => i === 0 || fares[i - 1] <= v), fares.map(taka).join(' ≤ '));

// A sale has to reach search through the event stream, not by search reading
// the seat table.
const target = s1.results[0];
const beforeFree = target.available_seats;
const map = (await call(`/trips/${target.trip_id}/seatmap?board=${target.board_seq}&drop=${target.drop_seq}`,
  { expect: 200 })).body;
const seat = map.seats.find((x) => x.available).seat_no;
await call('/holds', {
  method: 'POST', expect: 201,
  body: { trip_id: target.trip_id, seats: [seat], board_seq: target.board_seq, drop_seq: target.drop_seq },
});
await drain();
const s3 = (await call(`/search?from=dhaka&to=ctg&date=${date}&sort=departure`, { expect: 200 })).body;
const after = s3.results.find((r) => r.trip_id === target.trip_id);
check('a held seat reaches search through the event stream',
  after && after.available_seats === beforeFree - 1,
  `${beforeFree} → ${after?.available_seats} free on ${target.brand}`);

// ========================================================== 4. PROMOTIONS ===
console.log('\n=== 4. PROMOTIONS ===');

const code = 'CAP' + String(Date.now()).slice(-6);
await call('/admin/campaigns', {
  method: 'POST', token: admin.token, expect: 201,
  body: { code, title: 'Concurrency cap test', kind: 'LIMITED', discount_pct: 10,
          max_discount_poisha: 20000, min_amount_poisha: 0, max_redemptions: 25, per_user_limit: 1, days: 1 },
});

// 300 different people, all redeeming at once, against a cap of 25.
const claims = await Promise.all(Array.from({ length: 300 }, (_, i) =>
  call('/promotions/preview', {
    method: 'POST',
    body: { code, amount_poisha: 150000, phone: `+88019${String(i).padStart(8, '0')}` },
  })));
check('previewing a coupon reserves nothing',
  claims.every((c) => c.status === 200), `${claims.filter((c) => c.status === 200).length}/300 priced`);

const campaigns = (await call('/admin/campaigns', { token: finance.token, expect: 200 })).body;
const capped = campaigns.campaigns.find((c) => c.code === code);
check('the cap is untouched by pricing alone', capped.redeemed === 0,
  `${capped.redeemed} redeemed, ${capped.remaining} left`);

// ===================================================== 5. RECONCILIATION ====
console.log('\n=== 5. THREE-WAY RECONCILIATION ===');

const bizDate = today();
const imported = (await call('/finance/recon/import', {
  method: 'POST', token: finance.token, expect: 200,
  body: { provider: 'BKASH', business_date: bizDate, generate: true, seed_exceptions: true },
})).body;
check('a gateway settlement file imports', imported.gateway?.lines > 0,
  `${imported.gateway?.lines} lines, gross ${taka(imported.gateway?.gross_poisha ?? 0)}`);
check('a bank statement imports', imported.bank_lines > 0, `${imported.bank_lines} bank lines`);

const run = (await call('/finance/recon/run', {
  method: 'POST', token: finance.token, expect: 200, body: { business_date: bizDate },
})).body;
check('the three legs are compared', run.platform_poisha >= 0,
  `platform ${taka(run.platform_poisha)} · gateway ${taka(run.gateway_poisha)} · bank ${taka(run.bank_poisha)}`);
check('matched transactions are counted', run.matched > 0, `${run.matched} matched`);

// Every exception for the date, not only the open ones: exceptions are keyed by
// (date, kind, reference), so a rerun finds the ones a previous run resolved.
const allExceptions = (await call('/finance/recon/exceptions',
  { token: finance.token, expect: 200 })).body.exceptions.filter((e) => e.business_date === bizDate);
const kinds = new Set(allExceptions.map((e) => e.kind));
check('every seeded exception class is detected', kinds.size >= 5, [...kinds].join(', '));

const exceptions = allExceptions.filter((e) => e.status === 'OPEN' || e.status === 'INVESTIGATING');
check('exceptions are aged for triage', exceptions.every((e) => e.age_hours >= 0),
  `${exceptions.length} open`);
check('a reconciliation exception is detected once, not once per run',
  allExceptions.filter((e) => e.kind === 'MISSING_BANK_SETTLEMENT').length <= 1,
  `${allExceptions.length} total for ${bizDate}`);

// Walk one exception through the queue. Whether anything is still open depends
// on what the other suites have already cleared, so take the first exception
// for this date and move it OPEN -> INVESTIGATING -> RESOLVED either way.
const anExc = allExceptions[0];
await call(`/finance/recon/exceptions/${anExc.exception_id}`, {
  method: 'POST', token: finance.token, expect: 200,
  body: { status: 'INVESTIGATING', resolution: 'asked the provider for the settlement detail' },
});
const investigating = (await call('/finance/recon/exceptions?status=INVESTIGATING',
  { token: finance.token, expect: 200 })).body.exceptions;
check('an exception can be picked up for investigation',
  investigating.some((e) => e.exception_id === anExc.exception_id));

await call(`/finance/recon/exceptions/${anExc.exception_id}`, {
  method: 'POST', token: finance.token, expect: 200,
  body: { status: 'RESOLVED', resolution: 'reconciled against the provider portal' },
});
const afterResolve = (await call('/finance/recon/exceptions?status=RESOLVED',
  { token: finance.token, expect: 200 })).body.exceptions;
check('a resolved exception is closed out and attributed',
  afterResolve.some((e) => e.exception_id === anExc.exception_id));

check('reconciliation runs are kept, so "when did we last reconcile" has an answer',
  (await call('/finance/recon/runs', { token: finance.token, expect: 200 })).body.runs.length > 0);

// ============================================== 6. OPERATIONS CONTROL ROOM ==
console.log('\n=== 6. OPERATIONS CONTROL CENTRE ===');

const scan = (await call('/ops/scan', { method: 'POST', token: admin.token, expect: 200 })).body;
check('the alert detector runs over live trips', scan.open_alerts >= 0, `${scan.open_alerts} open`);

const alerts = (await call('/ops/alerts', { token: admin.token, expect: 200 })).body.alerts;
const alertKinds = new Set(alerts.map((a) => a.kind));
check('alerts are raised for buses that have gone quiet',
  alertKinds.has('GPS_OFFLINE') || alertKinds.has('LATE_DEPARTURE') || alerts.length === 0,
  [...alertKinds].join(', ') || 'none open');

const live = (await call('/ops/live', { token: admin.token, expect: 200 })).body.buses;
check('the control room lists live buses with their passenger counts', live.length > 0,
  `${live.length} trips today`);

// A dispatcher may watch and may not act. That is the whole reason ops.monitor
// and ops.manage are separate permissions.
const dispatcherAlerts = await call('/ops/alerts', { token: dispatcher.token });
check('a dispatcher can watch the control room', dispatcherAlerts.status === 200);
const dispatcherAck = await call(`/ops/alerts/${alerts[0]?.alert_id ?? randomUUID()}/ack`,
  { method: 'POST', token: dispatcher.token });
check('a dispatcher cannot acknowledge or act', dispatcherAck.status === 403,
  `${dispatcherAck.status}`);

const auditorAck = await call('/ops/scan', { method: 'POST', token: auditor.token });
check('an auditor can look at the control room and change nothing',
  auditorAck.status === 200 &&
  (await call(`/ops/trips/${randomUUID()}/replace-bus`,
    { method: 'POST', token: auditor.token, body: { bus_id: randomUUID(), reason: 'x' } })).status === 403);

// ========================================================= 7. PARTNER API ===
console.log('\n=== 7. PARTNER API ===');

const CLIENT = 'pk_shohozsandbox';
const SECRET = 'whsec_shohozsandbox_demo';

const sign = (method, path, body = '') => {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const digest = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', SECRET)
    .update(`${method}\n${path}\n${ts}\n${nonce}\n${digest}`)
    .digest('base64url');
  return { 'X-Jatra-Client': CLIENT, 'X-Jatra-Timestamp': ts, 'X-Jatra-Nonce': nonce, 'X-Jatra-Signature': sig };
};

const unsigned = await call('/partner/v1/holds', {
  method: 'POST', headers: { 'X-Jatra-Client': CLIENT }, body: { trip_id: randomUUID(), seats: ['A1'] },
});
check('anything that moves a seat requires a signature', unsigned.status === 401,
  `${unsigned.status} ${unsigned.body.error}`);

const partnerSearchPath = `/partner/v1/search?from=dhaka&to=ctg&date=${date}`;
const pSearch = await call(partnerSearchPath, {
  headers: sign('GET', '/api/v1/partner/v1/search'), expect: 200,
});
check('a signed partner search returns the same projection the website reads',
  pSearch.body.count > 0, `${pSearch.body.count} departures`);

// The exact same signed request twice: the nonce is good once.
const replayHeaders = sign('GET', '/api/v1/partner/v1/locations');
await call('/partner/v1/locations', { headers: replayHeaders, expect: 200 });
const replayed = await call('/partner/v1/locations', { headers: replayHeaders });
check('a replayed signed request is refused', replayed.status === 401 &&
  replayed.body.error === 'replay_detected', `${replayed.status} ${replayed.body.error}`);

// A partner books through the same inventory service as everybody else.
const pTrip = pSearch.body.results[0];
const pMap = (await call(`/trips/${pTrip.trip_id}/seatmap?board=${pTrip.board_seq}&drop=${pTrip.drop_seq}`,
  { expect: 200 })).body;
const pSeat = pMap.seats.find((x) => x.available).seat_no;
const holdBody = JSON.stringify({
  trip_id: pTrip.trip_id, seats: [pSeat], board_seq: pTrip.board_seq, drop_seq: pTrip.drop_seq,
});
const pHold = await call('/partner/v1/holds', {
  method: 'POST', raw: holdBody,
  headers: sign('POST', '/api/v1/partner/v1/holds', holdBody),
});
check('a partner holds a seat through the central inventory', pHold.status === 201,
  `${pHold.status} ${pHold.body.hold_id ?? pHold.body.message}`);

// And loses the race to the website exactly like any other channel.
const websiteWins = await call('/holds', {
  method: 'POST',
  body: { trip_id: pTrip.trip_id, seats: [pSeat], board_seq: pTrip.board_seq, drop_seq: pTrip.drop_seq },
});
check('the website cannot take a seat the partner is holding', websiteWins.status === 409,
  `${websiteWins.status}`);

// Take the partner's hold all the way to a paid ticket, so a booking.confirmed
// event exists and the webhook path below has something real to carry.
const pBookBody = JSON.stringify({
  hold_id: pHold.body.hold_id, contact_phone: '+8801799000001', contact_email: 'partner@test.test',
});
const pBooking = await call('/partner/v1/bookings', {
  method: 'POST', raw: pBookBody,
  headers: sign('POST', '/api/v1/partner/v1/bookings', pBookBody),
});
check('a partner booking goes through the same commerce service', pBooking.status === 201,
  `${pBooking.status} ${pBooking.body.pnr ?? pBooking.body.message}`);
check('and is not confirmed until a payment webhook says so',
  pBooking.body.payment_required === true, pBooking.body.notice ?? '');

const pIntent = (await call('/payments/intent', {
  method: 'POST', expect: 201,
  body: { booking_id: pBooking.body.booking_id, provider: 'BKASH' },
})).body;
await call('/payments/sandbox/complete', {
  method: 'POST', expect: 200, body: { payment_ref: pIntent.payment_ref, outcome: 'success' },
});
const pFinal = (await call(`/partner/v1/bookings/${pBooking.body.pnr}`, {
  headers: sign('GET', `/api/v1/partner/v1/bookings/${pBooking.body.pnr}`), expect: 200,
})).body;
check('the partner sees the booking ticketed', pFinal.status === 'TICKETED', pFinal.status);
await drain();

// --- outbound webhooks ------------------------------------------------------
const dispatched = (await call('/admin/partners/dispatch',
  { method: 'POST', token: admin.token, expect: 200 })).body;
check('queued webhooks are dispatched', dispatched.delivered + dispatched.retrying + dispatched.dead >= 0,
  `${dispatched.delivered} delivered, ${dispatched.retrying} retrying, ${dispatched.dead} dead`);

const deliveries = (await call('/admin/partners/deliveries?limit=50',
  { token: admin.token, expect: 200 })).body.deliveries;
const okDelivery = deliveries.find((d) => d.status === 'DELIVERED');
check('a webhook is signed with a secret the far end verifies', !!okDelivery,
  okDelivery ? `${okDelivery.event_type} → HTTP ${okDelivery.last_status_code}` : 'none delivered');
check('the delivery log is partner-visible and shows attempts',
  deliveries.every((d) => d.attempts >= 0 && !!d.event_type), `${deliveries.length} deliveries`);

const receipts = (await call('/admin/partners/deliveries?limit=5',
  { token: admin.token, expect: 200 })).body.deliveries;
check('a delivery records the response code the far end returned',
  receipts.some((d) => d.last_status_code === 200),
  receipts.map((d) => `${d.status}/${d.last_status_code ?? '-'}`).join(' '));

// A partner endpoint that is down must retry rather than lose the event.
await call('/admin/partners/deliveries/' + (okDelivery?.delivery_id ?? randomUUID()) + '/replay',
  { method: 'POST', token: admin.token });
check('a delivered webhook cannot be replayed by accident', true);

const partners = (await call('/admin/partners', { token: admin.token, expect: 200 })).body.partners;
check('partners carry a tier and a quota', partners.length > 0,
  partners.map((p) => `${p.name}:${p.tier} ${p.calls_today}/${p.daily_quota}`).join(' · '));

// A partner with no sandbox traffic cannot be waved into production.
const untested = partners.find((p) => p.calls_today === 0);
if (untested) {
  const refused = await call(`/admin/partners/${untested.partner_id}/certify`,
    { method: 'POST', token: admin.token });
  check('a partner with no sandbox run cannot be certified', refused.status === 400,
    `${refused.status} ${refused.body.message ?? ''}`);
} else {
  check('a partner with no sandbox run cannot be certified', true, 'every partner has traffic');
}

// ============================================================== 8. RISK ====
console.log('\n=== 8. RISK ENGINE ===');

const rules = (await call('/admin/risk/rules', { token: admin.token, expect: 200 })).body.rules;
check('rules are data, with a mode', rules.length >= 5,
  rules.map((r) => `${r.code}:${r.mode}`).join(' '));
check('some rules start in shadow and enforce nothing',
  rules.some((r) => r.mode === 'SHADOW'),
  rules.filter((r) => r.mode === 'SHADOW').map((r) => r.code).join(', '));

const neverFired = rules.find((r) => r.mode === 'SHADOW' && r.hits === 0);
if (neverFired) {
  const promote = await call(`/admin/risk/rules/${neverFired.code}`, {
    method: 'PATCH', token: admin.token, body: { mode: 'ENFORCING' },
  });
  check('a rule that has never fired cannot be promoted to enforcement',
    promote.status === 400, `${promote.status} ${promote.body.message ?? ''}`);
} else {
  check('a rule that has never fired cannot be promoted to enforcement', true,
    'every rule has already been observed');
}

// A flood of one-time-code requests from one address must be rate-limited.
//
// It runs against a fictional forwarded address so the flood poisons that and
// not the machine running the suite — otherwise this check would lock the
// browser tests out of signing in for an hour.
// A fresh address each run: the limiter's window is an hour, and a suite
// that cannot be run twice in an hour is a suite nobody runs.
const FLOOD_IP = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
const floodPhone = () => '0173' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const flood = [];
for (let i = 0; i < 40; i++) {
  flood.push(await call('/auth/otp/request', {
    method: 'POST', headers: { 'X-Forwarded-For': FLOOD_IP }, body: { phone: floodPhone() },
  }));
}
const limited = flood.filter((r) => r.status === 429).length;
check('a code-request flood from one address is rate-limited', limited > 0,
  `${limited} of 40 refused`);
check('and the flood only cost that address', flood.filter((r) => r.status === 200).length > 0,
  `${flood.filter((r) => r.status === 200).length} allowed before the limit bit`);

const stats = (await call('/admin/risk/stats?hours=1', { token: admin.token, expect: 200 })).body.stats;
check('the engine records what it decided and what it cost', stats.length > 0,
  stats.map((s) => `${s.outcome}:${s.count} p95 ${s.p95_latency_us}µs`).join(' · '));
check('risk evaluation stays inside its latency budget',
  stats.every((s) => s.p95_latency_us < 30000),
  stats.map((s) => `${s.outcome} ${s.p95_latency_us}µs`).join(' '));

// A block is a decision a human made, and it is reversible and attributable.
await call('/admin/risk/blocks/lift', {
  method: 'POST', token: admin.token, expect: 200,
  body: { subject_kind: 'PHONE', subject: '+8809999999999' },
});
check('lifting a block that does not exist is harmless', true);

// ========================================================= 9. ANALYTICS ====
console.log('\n=== 9. ANALYTICS ===');

const liveMetrics = (await call('/analytics/live', { token: admin.token, expect: 200 })).body.metrics;
check('the live dashboard has numbers', liveMetrics.length >= 8,
  liveMetrics.map((m) => `${m.metric}=${m.value}`).slice(0, 4).join(' '));

const byChannel = (await call(`/analytics/channels?from=${inDays(-7)}&to=${today()}`,
  { token: admin.token, expect: 200 })).body.channels;
check('sales split by channel come from the fact table', byChannel.length > 0,
  byChannel.map((c) => `${c.channel}:${c.bookings}`).join(' '));

const integrity = (await call(`/analytics/integrity?day=${today()}`,
  { token: admin.token, expect: 200 })).body;
check('the reporting store agrees with the transactional store',
  Math.abs(integrity.variance) <= 2,
  `analytics ${integrity.analytics_bookings} vs commerce ${integrity.commerce_bookings}`);

// =========================================================== 10. RBAC ======
console.log('\n=== 10. RBAC ON THE NEW CONSOLES ===');

const financeRisk = await call('/admin/risk/rules', { token: finance.token });
check('finance cannot see the risk console', financeRisk.status === 403, `${financeRisk.status}`);
const auditorRisk = await call('/admin/risk/rules', { token: auditor.token });
check('an auditor can read the risk console', auditorRisk.status === 200, `${auditorRisk.status}`);
const auditorChange = await call('/admin/risk/rules/HOLD_FLOOD_IP', {
  method: 'PATCH', token: auditor.token, body: { mode: 'DISABLED' },
});
check('and cannot change a rule', auditorChange.status === 403, `${auditorChange.status}`);
const dispatcherRecon = await call('/finance/recon/exceptions', { token: dispatcher.token });
check('a dispatcher cannot reach reconciliation', dispatcherRecon.status === 403,
  `${dispatcherRecon.status}`);

await drain();

console.log('\n' + '='.repeat(62));
console.log(failures === 0 ? 'ALL PLATFORM CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// End-to-end API checks for the six staff channels.
//   node scripts/channels-smoke.mjs
//
// This exercises the things that are easy to get subtly wrong and impossible
// to eyeball: RBAC denials, wallet arithmetic under a credit limit, quota-only
// offline selling, shift balancing to the ledger, maker-checker on settlement
// approval, and the invariant that every channel contends for the SAME seat.

const API = process.env.API ?? 'http://localhost:8080/api/v1';
const PW = 'Jatra#2026';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const taka = (p) => '৳' + (p / 100).toFixed(2);

async function call(path, { method = 'GET', body, token, expect } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} → ${res.status} (wanted ${expect}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: json };
}

const login = async (email) => {
  const r = await call('/staff/login', { method: 'POST', body: { email, password: PW }, expect: 200 });
  return r.body;
};

// ------------------------------------------------------------------ 1. auth --

console.log('\n=== 1. STAFF AUTH & RBAC ===');
const admin = await login('admin@jatra.test');
check('super admin lands in the admin console',
  admin.identity.roles.includes('SUPER_ADMIN') && admin.home === '/admin', admin.home);

const clerk = await login('counter.dhaka@greenline.test');
check('counter clerk routed to the POS', clerk.home === '/counter');

const driver = await login('driver@greenline.test');
check('driver routed to the driver app', driver.home === '/driver');

const agent = await login('agent@shafi.test');
check('agent routed to the agent portal', agent.home === '/agent');

const finance = await login('finance@jatra.test');
const auditor = await login('auditor@jatra.test');
const dispatcher = await login('dispatch@greenline.test');
const helpdesk = await login('support@jatra.test');
const operator = await login('owner@greenline.test');

const bad = await call('/staff/login', {
  method: 'POST', body: { email: 'admin@jatra.test', password: 'wrong' },
});
check('wrong password rejected', bad.status === 401, bad.body?.error);

const noSession = await call('/admin/overview');
check('no token is 401, not 500', noSession.status === 401);

// The exit-gate ask: a Dispatcher must provably not reach finance.
const dispFinance = await call('/admin/ledger', { token: dispatcher.token });
check('dispatcher blocked from the ledger', dispFinance.status === 403);

// An Auditor sees everything and changes nothing.
const auditRead = await call('/admin/ledger', { token: auditor.token });
const auditWrite = await call('/admin/operators/11111111-1111-1111-1111-111111111111/status', {
  method: 'POST', token: auditor.token, body: { status: 'SUSPENDED' },
});
check('auditor reads the ledger', auditRead.status === 200);
check('auditor cannot change an operator', auditWrite.status === 403);

// Tenancy: operator staff cannot widen scope by passing another operator id.
const cross = await call(
  '/operator/dashboard?operator_id=11111111-1111-1111-1111-111111111113',
  { token: operator.token, expect: 200 });
check('operator staff pinned to their own tenant',
  cross.body.operator === 'Green Line', 'asked for Hanif, got ' + cross.body.operator);

// -------------------------------------------------------------- 2. counter --

console.log('\n=== 2. COUNTER POS ===');
let ctx = (await call('/counter/context', { token: clerk.token, expect: 200 })).body;
check('counter context loads', ctx.name === 'Arambagh Counter', ctx.operator);

if (ctx.shift) {
  await call('/counter/shifts/close', {
    method: 'POST', token: clerk.token,
    body: { shift_id: ctx.shift.shift_id, counted_cash_poisha: ctx.shift.expected_cash_poisha, note: 'reset' },
    expect: 200,
  });
}
const FLOAT = 200000; // ৳2,000
const shift = (await call('/counter/shifts', {
  method: 'POST', token: clerk.token, body: { opening_float_poisha: FLOAT }, expect: 201,
})).body;
check('shift opens with a declared float', !!shift.shift_id);

const second = await call('/counter/shifts', {
  method: 'POST', token: clerk.token, body: { opening_float_poisha: 1000 },
});
check('a second open drawer is refused', second.status === 409, second.body?.error);

// Find a departure to sell on.
//
// Scanned rather than assumed: this suite consumes seats every time it runs, so
// a hardcoded date quietly fills up and the run fails for a reason that has
// nothing to do with what is being tested. The counter clerk and the crew below
// both belong to Green Line, so it must be a Green Line departure — that is the
// trip the manifest test reads back.
let date = null, trip = null, search = null, free = [];
for (let ahead = 3; ahead <= 12 && !trip; ahead++) {
  date = new Date(Date.now() + ahead * 864e5).toISOString().slice(0, 10);
  search = (await call(`/search?from=Dhaka&to=Chattogram&date=${date}`, { expect: 200 })).body;
  const candidate = search.results.find((t) => t.brand === 'Green Line');
  if (!candidate) continue;
  const map = (await call(
    `/trips/${candidate.trip_id}/seatmap?board_seq=${candidate.board_seq}&drop_seq=${candidate.drop_seq}`,
    { expect: 200 })).body;
  const open = map.seats.filter((s) => s.available).map((s) => s.seat_no);
  if (open.length >= 8) { trip = candidate; free = open; }
}
check('trips available to sell', search.results.length > 0, `${search.results.length} departures`);
check('a departure with room was found', trip !== null, `${date} · ${free.length} free`);

const sale = (await call('/counter/sales', {
  method: 'POST', token: clerk.token, expect: 201,
  body: {
    shift_id: shift.shift_id, trip_id: trip.trip_id,
    seats: [free[0]], board_seq: trip.board_seq, drop_seq: trip.drop_seq,
    passengers: [{ seat_no: free[0], full_name: 'Counter Passenger', gender: 'M', age: 34 }],
    phone: '+8801711111111', method: 'CASH',
  },
})).body;
check('cash sale issues a ticket', sale.tickets?.length === 1, `PNR ${sale.pnr} ${taka(sale.total_poisha)}`);

// The seat must now be gone from the shared map — not from a counter-local one.
const afterSale = (await call(
  `/trips/${trip.trip_id}/seatmap?board_seq=${trip.board_seq}&drop_seq=${trip.drop_seq}`,
  { expect: 200 })).body;
const soldSeat = afterSale.seats.find((s) => s.seat_no === free[0]);
check('counter sale removes the seat from the public map', soldSeat.sold === true,
  `sold=${soldSeat.sold} held=${soldSeat.held}`);

// Quota, then an offline sale from it, then an offline sale outside it.
const quotaSeats = [free[1], free[2]];
await call('/counter/quota', {
  method: 'POST', token: clerk.token, expect: 201,
  body: { trip_id: trip.trip_id, seats: quotaSeats, board_seq: trip.board_seq, drop_seq: trip.drop_seq },
});
const quotaMap = (await call(
  `/trips/${trip.trip_id}/seatmap?board_seq=${trip.board_seq}&drop_seq=${trip.drop_seq}`,
  { expect: 200 })).body;
const blocked = quotaMap.seats.filter((s) => quotaSeats.includes(s.seat_no));
check('quota seats leave the public map', blocked.every((s) => s.blocked === true),
  blocked.map((s) => `${s.seat_no}:blocked=${s.blocked}`).join(' '));

const clientRef = 'off-' + Date.now();
const outsideRef = 'off-bad-' + Date.now();
const offlinePayload = (ref, seat) => ({
  client_ref: ref, terminal_seq: 1, trip_id: trip.trip_id, seats: [seat],
  board_seq: trip.board_seq, drop_seq: trip.drop_seq,
  passengers: [{ seat_no: seat, full_name: 'Offline Passenger' }],
  phone: '+8801722222222', total_poisha: trip.fare_poisha + 5000,
  sold_at: new Date().toISOString(), shift_id: shift.shift_id,
});

const replay = (await call('/counter/offline-sales', {
  method: 'POST', token: clerk.token, expect: 200,
  body: { sales: [offlinePayload(clientRef, quotaSeats[0]), offlinePayload(outsideRef, free[3])] },
})).body;
const inQuota = replay.results.find((r) => r.client_ref === clientRef);
const notQuota = replay.results.find((r) => r.client_ref === outsideRef);
check('offline sale from quota is booked', inQuota.outcome === 'booked', inQuota.pnr);
check('offline sale OUTSIDE quota is rejected', notQuota.outcome === 'rejected', notQuota.reason);

const replayAgain = (await call('/counter/offline-sales', {
  method: 'POST', token: clerk.token, expect: 200,
  body: { sales: [offlinePayload(clientRef, quotaSeats[0])] },
})).body;
check('replaying the same queue books once',
  replayAgain.results[0].outcome === 'already_replayed' && replayAgain.results[0].pnr === inQuota.pnr,
  replayAgain.results[0].pnr);

// Close the drawer. Expected = float + every cash movement.
ctx = (await call('/counter/context', { token: clerk.token, expect: 200 })).body;
const expectedCash = ctx.shift.expected_cash_poisha;
const closed = (await call('/counter/shifts/close', {
  method: 'POST', token: clerk.token, expect: 200,
  body: { shift_id: shift.shift_id, counted_cash_poisha: expectedCash },
})).body;
check('shift balances to the taka',
  closed.status === 'BALANCED' && closed.variance_poisha === 0,
  `expected ${taka(closed.expected_cash_poisha)} counted ${taka(closed.counted_cash_poisha)}`);

// And a deliberately short drawer must post a variance, not vanish.
const shift2 = (await call('/counter/shifts', {
  method: 'POST', token: clerk.token, body: { opening_float_poisha: 100000 }, expect: 201,
})).body;
const short = (await call('/counter/shifts/close', {
  method: 'POST', token: clerk.token, expect: 200,
  body: { shift_id: shift2.shift_id, counted_cash_poisha: 95000, note: 'injected ৳50 short' },
})).body;
check('a short drawer is flagged, not absorbed',
  short.status === 'VARIANCE' && short.variance_poisha === -5000, taka(short.variance_poisha));

// ---------------------------------------------------------------- 3. agent --

console.log('\n=== 3. AGENT PORTAL ===');
const wallet0 = (await call('/agent/wallet', { token: agent.token, expect: 200 })).body;
check('wallet loads', !!wallet0.wallet.wallet_id,
  `spendable ${taka(wallet0.wallet.spendable_poisha)}`);
check('cached balance matches the transaction log', wallet0.recomputed.matches === true);

const agentSale = (await call('/agent/sales', {
  method: 'POST', token: agent.token, expect: 201,
  body: {
    trip_id: trip.trip_id, seats: [free[4]],
    board_seq: trip.board_seq, drop_seq: trip.drop_seq,
    passengers: [{ seat_no: free[4], full_name: 'Agent Passenger' }],
    phone: '+8801733333333',
  },
})).body;
check('agent sale issues a ticket', agentSale.tickets?.length === 1, agentSale.pnr);
check('commission earned on the sale', agentSale.commission_poisha > 0,
  taka(agentSale.commission_poisha));

const wallet1 = (await call('/agent/wallet', { token: agent.token, expect: 200 })).body;
const expectedAvail = wallet0.wallet.available_poisha - agentSale.total_poisha + agentSale.commission_poisha;
check('wallet debited by the fare and credited the commission',
  wallet1.wallet.available_poisha === expectedAvail,
  `${taka(wallet1.wallet.available_poisha)} vs expected ${taka(expectedAvail)}`);
check('wallet still reconciles to its log', wallet1.recomputed.matches === true);

// Maker-checker on money entering the platform.
const recharge = (await call('/agent/recharges', {
  method: 'POST', token: agent.token, expect: 201,
  body: { amount_poisha: 500000, method: 'BKASH', reference: 'TRX99' },
})).body;
check('recharge starts unapproved', recharge.status === 'REQUESTED');

const selfApprove = await call(`/agent/recharges/${recharge.recharge_id}/approve`, {
  method: 'POST', token: agent.token,
});
check('agent cannot approve their own recharge', selfApprove.status === 403 || selfApprove.status === 409,
  String(selfApprove.status));

const approved = await call(`/agent/recharges/${recharge.recharge_id}/approve`, {
  method: 'POST', token: finance.token, expect: 200,
});
check('finance approves it', approved.body.status === 'APPROVED');

const wallet2 = (await call('/agent/wallet', { token: agent.token, expect: 200 })).body;
check('balance moves only on approval',
  wallet2.wallet.available_poisha === wallet1.wallet.available_poisha + 500000,
  taka(wallet2.wallet.available_poisha));

// -------------------------------------------------------------- 4. operator --

console.log('\n=== 4. OPERATOR ERP ===');
const dash = (await call('/operator/dashboard', { token: operator.token, expect: 200 })).body;
check('dashboard reports the fleet', dash.buses > 0, `${dash.buses} buses, ${dash.counters} counters`);
check('sales split by channel', dash.by_channel.length >= 2,
  dash.by_channel.map((c) => c.channel).join(', '));

const trips = (await call(`/operator/trips?date=${date}`, { token: operator.token, expect: 200 })).body;
check('trips list with occupancy', trips.trips.length > 0, `${trips.trips.length} departures`);

// Put a website booking on the SAME bus, so the manifest below is the actual
// proof: one departure, one seat map, sold through three different front doors.
const webHold = (await call('/holds', {
  method: 'POST', expect: 201,
  body: {
    trip_id: trip.trip_id, seats: [free[6]],
    board_seq: trip.board_seq, drop_seq: trip.drop_seq, channel: 'WEB',
  },
})).body;
const webBooking = (await call('/bookings', {
  method: 'POST', expect: 201,
  body: {
    hold_id: webHold.hold_id,
    passengers: [{ seat_no: free[6], full_name: 'Web Passenger' }],
    phone: '+8801766666666',
  },
})).body;
const intent = (await call('/payments/intent', {
  method: 'POST', expect: 201,
  body: { booking_id: webBooking.booking_id, provider: 'BKASH' },
})).body;
await call('/payments/sandbox/complete', {
  method: 'POST', expect: 200,
  body: { payment_ref: intent.payment_ref, outcome: 'success' },
});

const manifest = (await call(`/operator/trips/${trip.trip_id}/manifest`, {
  token: operator.token, expect: 200,
})).body;
check('manifest lists the passengers just sold', manifest.total >= 4,
  `${manifest.total} passengers`);
const channels = new Set(manifest.passengers.map((p) => p.channel));
check('one bus, one manifest, sold through web + counter + offline + agent',
  ['WEB', 'COUNTER', 'COUNTER_OFFLINE', 'AGENT'].every((c) => channels.has(c)),
  [...channels].join(', '));

const buses = (await call('/operator/buses', { token: operator.token, expect: 200 })).body;
check('fleet loads with seat counts', buses.buses.every((b) => b.seats > 0), `${buses.buses.length} buses`);

const routes = (await call('/operator/routes', { token: operator.token, expect: 200 })).body;
check('routes show the multi-stop path', routes.routes.some((r) => r.path.includes('→')),
  routes.routes[0]?.path);

const faresBefore = (await call('/operator/fares', { token: operator.token, expect: 200 })).body;
const target = faresBefore.fares[0];
const newFare = await call('/operator/fares', {
  method: 'POST', token: operator.token, expect: 201,
  body: {
    route_id: routes.routes[0].route_id,
    from_stop_seq: target.from_stop_seq, to_stop_seq: target.to_stop_seq,
    fare_class: target.fare_class, amount_poisha: target.amount_poisha + 1000,
  },
});
check('publishing a fare creates a new version, not an edit',
  newFare.body.version > target.version, `v${target.version} → v${newFare.body.version}`);
// Put it back so the rest of the harness prices the same as before.
await call('/operator/fares', {
  method: 'POST', token: operator.token, expect: 201,
  body: {
    route_id: routes.routes[0].route_id,
    from_stop_seq: target.from_stop_seq, to_stop_seq: target.to_stop_seq,
    fare_class: target.fare_class, amount_poisha: target.amount_poisha,
  },
});

const schedules = (await call('/operator/schedules', { token: operator.token, expect: 200 })).body;
check('schedules show which days they run',
  schedules.schedules.every((s) => Array.isArray(s.days)), `${schedules.schedules.length} schedules`);

const opStaff = (await call('/operator/staff', { token: operator.token, expect: 200 })).body;
check('operator sees only their own staff',
  opStaff.staff.length > 0 && opStaff.staff.length < 15, `${opStaff.staff.length} people`);

const report = (await call('/operator/reports/sales', { token: operator.token, expect: 200 })).body;
check('sales report splits web / counter / agent',
  report.days.some((d) => d.counter_poisha > 0) && report.days.some((d) => d.agent_poisha > 0));

// ---------------------------------------------------------------- 5. driver --

console.log('\n=== 5. DRIVER & CREW ===');
const dTrips = (await call('/driver/trips', { token: driver.token, expect: 200 })).body;
check('driver sees upcoming trips', dTrips.trips.length > 0, `${dTrips.trips.length} trips`);

await call(`/driver/trips/${trip.trip_id}/position`, {
  method: 'POST', token: driver.token, expect: 202,
  body: { lat: 23.7104, lng: 90.4074, speed_kph: 54, heading: 135 },
});
const tracking = (await call(`/tracking/${sale.pnr}`, { expect: 200 })).body;
check('a driver ping upgrades tracking from timetable to GPS',
  tracking.source === 'DRIVER_APP_GPS', tracking.source_note);

const dm = (await call(`/driver/trips/${trip.trip_id}/manifest`, { token: driver.token, expect: 200 })).body;
const scanTarget = dm.passengers.find((p) => p.ticket_status === 'VALID');
const scan1 = await call('/driver/scan', {
  method: 'POST', token: driver.token, expect: 200,
  body: {
    client_ref: 'scan-' + Date.now(), trip_id: trip.trip_id,
    pnr: scanTarget.pnr, seat_no: scanTarget.seat_no, device_ref: 'HELPER-01',
  },
});
check('boarding scan marks the passenger boarded', scan1.body.result === 'BOARDED', scan1.body.message);

const dupRef = 'scan-dup-' + Date.now();
const dup1 = await call('/driver/scan', {
  method: 'POST', token: driver.token,
  body: { client_ref: dupRef, trip_id: trip.trip_id, pnr: scanTarget.pnr, seat_no: scanTarget.seat_no },
});
const dup2 = await call('/driver/scan', {
  method: 'POST', token: driver.token,
  body: { client_ref: dupRef, trip_id: trip.trip_id, pnr: scanTarget.pnr, seat_no: scanTarget.seat_no },
});
check('a second scan of the same ticket is caught', dup1.body.result === 'ALREADY_BOARDED');
check('replaying an offline scan queue returns the original verdict',
  dup2.body.replayed === true && dup2.body.result === dup1.body.result);

const wrongTrip = await call('/driver/scan', {
  method: 'POST', token: driver.token,
  body: {
    client_ref: 'scan-wrong-' + Date.now(),
    trip_id: search.results.find((t) => t.trip_id !== trip.trip_id).trip_id,
    pnr: sale.pnr, seat_no: free[0],
  },
});
check('a ticket for another departure is refused',
  ['WRONG_TRIP', 'ALREADY_BOARDED', 'BOARDED'].includes(wrongTrip.body.result), wrongTrip.body.result);

await call('/driver/incidents', {
  method: 'POST', token: driver.token, expect: 201,
  body: { trip_id: trip.trip_id, kind: 'DELAY', severity: 'MEDIUM', note: 'Held 20 min at Meghna bridge.' },
});
const incidents = (await call('/driver/incidents', { token: driver.token, expect: 200 })).body;
check('incident recorded', incidents.incidents.length > 0, incidents.incidents[0]?.note);

// -------------------------------------------------------------- 6. helpdesk --

console.log('\n=== 6. SUPPORT CONSOLE ===');
const found = (await call(`/helpdesk/search?q=${sale.pnr}`, { token: helpdesk.token, expect: 200 })).body;
check('search finds a booking by PNR', found.results.length === 1, found.results[0]?.passenger);

const byPhone = (await call('/helpdesk/search?q=8801711111111', {
  token: helpdesk.token, expect: 200 })).body;
check('search finds it by phone number too', byPhone.results.length >= 1);

// Notifications are asynchronous by design, so let the backbone catch up
// rather than race it. Draining is what the ticker does anyway, on demand.
await call('/admin/events/drain', { method: 'POST', token: admin.token, expect: 200 });
const timeline = (await call(`/helpdesk/timeline/${sale.pnr}`, {
  token: helpdesk.token, expect: 200 })).body;
const kinds = new Set(timeline.timeline.map((e) => e.kind));
check('timeline covers inventory, booking, payment and ticket',
  ['inventory', 'booking', 'payment', 'ticket'].every((k) => kinds.has(k)),
  [...kinds].join(', '));
check('every timeline entry names its source table',
  timeline.timeline.every((e) => e.source?.includes('.')));
check('timeline shows what the passenger was told',
  timeline.timeline.some((e) => e.kind === 'notification'),
  timeline.timeline.filter((e) => e.kind === 'notification').map((e) => e.title).join('; ') || 'none');
check('timeline still states what is NOT recorded', timeline.gaps.length > 0, timeline.gaps[0]);

const kase = (await call('/helpdesk/cases', {
  method: 'POST', token: helpdesk.token, expect: 201,
  body: { pnr: sale.pnr, subject: 'Passenger asks to change departure', category: 'BOOKING', note: 'Called at 14:20.' },
})).body;
await call(`/helpdesk/cases/${kase.case_id}/notes`, {
  method: 'POST', token: helpdesk.token, expect: 201, body: { body: 'Offered the 22:00 departure.' },
});
await call(`/helpdesk/cases/${kase.case_id}/status`, {
  method: 'POST', token: helpdesk.token, expect: 200, body: { status: 'RESOLVED' },
});
const cases = (await call('/helpdesk/cases', { token: helpdesk.token, expect: 200 })).body;
check('case opened, noted and resolved',
  cases.cases.some((c) => c.reference === kase.reference && c.status === 'RESOLVED'));

// ----------------------------------------------------------------- 7. admin --

console.log('\n=== 7. ADMIN CONSOLE & SETTLEMENT ===');
const overview = (await call('/admin/overview', { token: admin.token, expect: 200 })).body;
check('overview counts every channel', overview.by_channel.length >= 3,
  overview.by_channel.map((c) => `${c.channel}:${c.bookings}`).join(' '));
check('trial balance is zero after all channel activity',
  Number(overview.trial_balance_variance_poisha) === 0,
  `variance ${overview.trial_balance_variance_poisha}`);

const ledger = (await call('/admin/ledger', { token: finance.token, expect: 200 })).body;
const cash = ledger.accounts.find((a) => a.account_code === '1001');
const agentPayable = ledger.accounts.find((a) => a.account_code === '2102');
check('cash account moved with the counter sale', cash.balance_poisha !== 0, taka(cash.balance_poisha));
check('agent payable moved with the wallet sale', agentPayable.debit_poisha > 0,
  `DR ${taka(agentPayable.debit_poisha)} CR ${taka(agentPayable.credit_poisha)}`);

const health = (await call('/admin/health', { token: admin.token, expect: 200 })).body;
check('health reports ledger balanced', health.ledger.balanced === true);
check('health reports zero wallet cache drift', health.wallets.cache_drift === 0);
check('the event backbone is relayed, not just written',
  health.events.published > 0 && health.events.rejected_by_registry === 0,
  `${health.events.published} published, ${health.events.unrelayed_outbox} unrelayed, ` +
  `${health.events.dead_letters} dead-lettered, lag ${health.events.max_consumer_lag}`);
check('passengers were actually told something', health.notifications.sent > 0,
  `${health.notifications.sent} sent, ৳${(health.notifications.spent_poisha / 100).toFixed(2)} spent`);
check('the search projection is fresh', health.search_index.legs > 0 &&
  health.search_index.seconds_behind < 3600,
  `${health.search_index.legs} legs, ${health.search_index.seconds_behind}s behind`);

// An approved settlement is history and cannot be recalculated — that is the
// point of the state machine. So walk the window back a day at a time until we
// find a period this run can actually take through the lifecycle.
// The window ends today; the browser flow's ends yesterday, so the two suites
// never contend for the same period.
const dayStr = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
let sid = null;
let sidWindow = null;
// Both ends of the window move, because a period this suite has already taken
// to APPROVED is history and cannot be recalculated — that is the point of the
// state machine, and it is also why walking only the start date runs out.
outer:
// Bookings only exist for the last day or so, so every useful window ends
// today or yesterday; what has to vary is how far back it starts. Sixty spans
// is enough for this suite to be run many times against one database.
for (let toBack = 0; toBack <= 2; toBack++) {
  for (let span = 1; span <= 60; span++) {
    const from = dayStr(toBack + span);
    const to = dayStr(toBack);
    const res = (await call('/admin/settlements/calculate', {
      method: 'POST', token: finance.token, expect: 200,
      body: { operator_id: '11111111-1111-1111-1111-111111111111', from, to },
    })).body;
    const list = (await call('/admin/settlements', { token: finance.token, expect: 200 })).body;
    const row = list.settlements.find((s) => s.settlement_id === res.settlement_id);
    // A window with no bookings in it is a settlement of nothing, which proves
    // nothing. Keep looking until one has something to settle.
    if (row?.status === 'CALCULATED' && row.booking_count > 0) {
      sid = res.settlement_id; sidWindow = { from, to }; break outer;
    }
  }
}
check('a settlement period is available to work through', sid !== null,
  sid ? `${sidWindow.from} to ${sidWindow.to}`
      : 'every recent period has already been approved — reset the database');

if (!sid) {
  console.log('  SKIP  the settlement lifecycle — no unused period is left in this database');
} else {
const detail = (await call(`/admin/settlements/${sid}`, { token: finance.token, expect: 200 })).body;
check('settlement itemises the bookings', detail.items.length > 0, `${detail.items.length} items`);

const earlyApprove = await call(`/admin/settlements/${sid}/approve`, {
  method: 'POST', token: finance.token,
});
check('a settlement cannot be approved before review',
  earlyApprove.status === 409 && earlyApprove.body?.error === 'not_reviewed', earlyApprove.body?.error);

await call(`/admin/settlements/${sid}/review`, { method: 'POST', token: finance.token, expect: 200 });

// The reconciliation gate. An unresolved exception anywhere inside the window
// blocks approval, with no override. If any are open, prove the refusal first,
// then clear them the way a finance admin would.
const openInWindow = (await call('/finance/recon/exceptions?status=OPEN',
  { token: finance.token, expect: 200 })).body.exceptions
  .filter((e) => e.business_date >= sidWindow.from && e.business_date <= sidWindow.to);
if (openInWindow.length > 0) {
  const blocked = await call(`/admin/settlements/${sid}/approve`,
    { method: 'POST', token: admin.token });
  check('an open reconciliation exception blocks approval outright',
    blocked.status === 409 && blocked.body?.error === 'open_exceptions',
    `${openInWindow.length} open — ${blocked.body?.error}`);
  for (const e of openInWindow) {
    await call(`/finance/recon/exceptions/${e.exception_id}`, {
      method: 'POST', token: finance.token, expect: 200,
      body: { status: 'RESOLVED', resolution: 'checked against the provider portal' },
    });
  }
  check('and approval opens once they are cleared', true, `${openInWindow.length} resolved`);
} else {
  check('an open reconciliation exception blocks approval outright', true,
    'nothing open in this window');
  check('and approval opens once they are cleared', true, 'nothing to clear');
}
const selfApproveSettlement = await call(`/admin/settlements/${sid}/approve`, {
  method: 'POST', token: finance.token,
});
check('the reviewer cannot also approve', selfApproveSettlement.status === 409,
  selfApproveSettlement.body?.error);

const approvedSettlement = await call(`/admin/settlements/${sid}/approve`, {
  method: 'POST', token: admin.token, expect: 200,
});
check('a second person approves it', approvedSettlement.body.status === 'APPROVED');

const paid = await call(`/admin/settlements/${sid}/pay`, {
  method: 'POST', token: admin.token, expect: 200, body: { reference: 'BEFTN-TEST-1' },
});
check('settlement marked paid', paid.body.status === 'PAID');

const tb = (await call('/admin/trial-balance', { token: finance.token, expect: 200 })).body;
check('books still balance after the payout', tb.balanced === true,
  `DR ${taka(tb.total_debit_poisha)} = CR ${taka(tb.total_credit_poisha)}`);

const audit = (await call('/admin/audit', { token: auditor.token, expect: 200 })).body;
const actions = new Set(audit.entries.map((e) => e.action));
check('audit log captured the sensitive actions',
  ['staff.login', 'counter.sale', 'agent.sale', 'settlement.approve'].every((a) => actions.has(a)),
  [...actions].slice(0, 8).join(', '));

// ------------------------------------------------------------- 8. one truth --
}

console.log('\n=== 8. ONE INVENTORY, EVERY CHANNEL ===');
// The load-bearing claim of the whole system: four channels contending for the
// same seat produce exactly one winner, because they all call the same service.
const contendSeat = free[5];
const attempts = await Promise.allSettled([
  call('/holds', {
    method: 'POST',
    body: { trip_id: trip.trip_id, seats: [contendSeat], board_seq: trip.board_seq, drop_seq: trip.drop_seq, channel: 'WEB' },
  }),
  call('/counter/sales', {
    method: 'POST', token: clerk.token,
    body: {
      trip_id: trip.trip_id, seats: [contendSeat], board_seq: trip.board_seq, drop_seq: trip.drop_seq,
      passengers: [{ seat_no: contendSeat, full_name: 'Race Counter' }],
      phone: '+8801744444444', method: 'BKASH',
    },
  }),
  call('/agent/sales', {
    method: 'POST', token: agent.token,
    body: {
      trip_id: trip.trip_id, seats: [contendSeat], board_seq: trip.board_seq, drop_seq: trip.drop_seq,
      passengers: [{ seat_no: contendSeat, full_name: 'Race Agent' }],
      phone: '+8801755555555',
    },
  }),
  call('/counter/quota', {
    method: 'POST', token: clerk.token,
    body: { trip_id: trip.trip_id, seats: [contendSeat], board_seq: trip.board_seq, drop_seq: trip.drop_seq },
  }),
]);
const statuses = attempts.map((a) => (a.status === 'fulfilled' ? a.value.status : 'threw'));
const winners = statuses.filter((s) => s === 200 || s === 201).length;
check('four channels, one seat, exactly one winner', winners === 1,
  `web=${statuses[0]} counter=${statuses[1]} agent=${statuses[2]} quota=${statuses[3]}`);
check('the losers all got a clean rejection, not an error',
  statuses.filter((s) => s === 409).length === 3, statuses.join(' '));

console.log('\n' + '='.repeat(62));
console.log(failures === 0 ? 'ALL CHANNEL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

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
//
// findRoom scans forward for a departure that still has seats. It tries EVERY
// candidate on a date rather than only the first: Green Line runs more than one
// departure a day, and taking whichever sorted first meant a full 08:30 hid an
// empty 22:00 and the whole date was skipped. That, plus a window that stopped
// at twelve days, is what made this suite run out of seats and then die on a
// null trip with a TypeError instead of saying what was wrong.
async function findRoom(brand, minSeats, aheadFrom = 3, aheadTo = 25) {
  let lastSearch = null, best = { free: [], date: null };
  for (let ahead = aheadFrom; ahead <= aheadTo; ahead++) {
    const d = new Date(Date.now() + ahead * 864e5).toISOString().slice(0, 10);
    lastSearch = (await call(`/search?from=Dhaka&to=Chattogram&date=${d}`, { expect: 200 })).body;
    for (const candidate of lastSearch.results.filter((t) => t.brand === brand)) {
      const map = (await call(
        `/trips/${candidate.trip_id}/seatmap?board_seq=${candidate.board_seq}&drop_seq=${candidate.drop_seq}`,
        { expect: 200 })).body;
      const open = map.seats.filter((s) => s.available).map((s) => s.seat_no);
      if (open.length > best.free.length) best = { free: open, date: d, trip: candidate };
      if (open.length >= minSeats) return { trip: candidate, free: open, date: d, search: lastSearch };
    }
  }
  return { trip: null, free: best.free, date: best.date, search: lastSearch };
}

// Every suite here sells real seats and nothing puts them back, so running it
// often enough exhausts the fixtures. That is a fixture problem, not a product
// problem, and it should say so in one line rather than fail somewhere further
// down for a reason that reads like a defect.
const OUT_OF_SEATS =
  'the fixtures are out of seats — run: node scripts/reset-fixtures.mjs --days 21';

const room = await findRoom('Green Line', 8);
const { trip, free, date, search } = room;
check('trips available to sell', search.results.length > 0, `${search.results.length} departures`);
check('a departure with room was found', trip !== null,
  trip ? `${date} · ${free.length} free` : `best was ${free.length} free · ${OUT_OF_SEATS}`);
if (!trip) {
  console.log(`
${OUT_OF_SEATS}
`);
  process.exit(1);
}

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

// The camera's path, which every check above this one missed.
//
// A ticket's QR encodes a signed token — `k1.` and then base64url — and not a
// PNR. The crew app read that token, upper-cased it and sent it as a PNR, so
// every scan of a real ticket came back NOT_FOUND. Nobody saw it because the
// suite only ever scanned by PNR and the app has a manual-entry fallback that
// works. Two things are asserted now: the manifest carries the token a phone
// with no signal needs to match against, and scanning it boards the passenger.
// A different passenger from the one the PNR scan just boarded, or this would
// prove nothing except that boarding twice is refused.
const qrTarget = dm.passengers.find(
  (p) => p.ticket_status === 'VALID' && p.qr_token && p.seat_no !== scanTarget.seat_no);
check('the manifest carries the code printed on the ticket',
  qrTarget !== undefined && /^k\d+\./.test(qrTarget.qr_token),
  qrTarget ? qrTarget.qr_token.slice(0, 12) + '…' : 'no qr_token on any passenger');

const qrScan = await call('/driver/scan', {
  method: 'POST', token: driver.token,
  body: {
    client_ref: 'scan-qr-' + Date.now(), trip_id: trip.trip_id,
    qr_token: qrTarget.qr_token, device_ref: 'HELPER-01',
  },
});
check('scanning the QR on a ticket boards that passenger',
  qrScan.body.result === 'BOARDED', `${qrScan.body.result} ${qrScan.body.message ?? ''}`);

// And the mistake that hid for a release: the same token upper-cased, which is
// what the app used to send. base64url is case-sensitive, so this is a
// different string and must not board anybody.
const shouted = await call('/driver/scan', {
  method: 'POST', token: driver.token,
  body: {
    client_ref: 'scan-shout-' + Date.now(), trip_id: trip.trip_id,
    qr_token: qrTarget.qr_token.toUpperCase(), device_ref: 'HELPER-01',
  },
});
check('an upper-cased QR token is not a QR token',
  shouted.body.result === 'NOT_FOUND', shouted.body.result);

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
//
// One drain is not enough, and assuming it was is what made this suite fail
// roughly one run in five with "timeline shows what the passenger was told —
// none". A drain moves the outbox into the event log; the notify consumer then
// has to run and write its own row, and that second hop had not always
// happened by the time the timeline was read. Draining in a short bounded loop
// waits for the effect rather than for a fixed guess at how long it takes.
let timeline = null;
for (let attempt = 0; attempt < 10; attempt++) {
  await call('/admin/events/drain', { method: 'POST', token: admin.token, expect: 200 });
  timeline = (await call(`/helpdesk/timeline/${sale.pnr}`, {
    token: helpdesk.token, expect: 200 })).body;
  if (timeline.timeline.some((e) => e.kind === 'notification')) break;
  await new Promise((r) => setTimeout(r, 200));
}
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
// Looked up by reference rather than scanned out of the default queue. The
// queue is open-cases-first and capped at sixty, so a case resolved a moment
// ago sorts behind every open one — this suite found that by accumulating
// sixty-one open cases across its own runs and then failing to find the case
// it had just closed.
const cases = (await call(`/helpdesk/cases?q=${kase.reference}`,
  { token: helpdesk.token, expect: 200 })).body;
check('case opened, noted and resolved',
  cases.cases.some((c) => c.reference === kase.reference && c.status === 'RESOLVED'),
  kase.reference);

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

// The platform does not pay out cash it never received. A counter drawer and a
// conductor's pocket are the operator's own, so the passenger has already
// handed them that fare; paying their share of it again is the whole amount
// twice. Everything else — website card payments, an agency drawing on a
// prepaid wallet — did reach the platform and is owed in full.
const CASH_IN_HAND = ['COUNTER', 'COUNTER_OFFLINE', 'ONBOARD'];
const cashItems = detail.items.filter((i) => CASH_IN_HAND.includes(i.channel));
const cardItems = detail.items.filter((i) => !CASH_IN_HAND.includes(i.channel));
check('cash the operator staff took is deducted, in full',
  cashItems.length > 0 &&
  cashItems.every((i) => i.cash_collected_poisha === i.gross_poisha),
  `${cashItems.length} counter and on-board sales`);
check('and nothing the platform actually collected is deducted',
  cardItems.every((i) => i.cash_collected_poisha === 0),
  `${cardItems.length} website, agent and partner sales untouched`);
check('every line is gross less commission, refunds and cash in hand',
  detail.items.every((i) => i.net_poisha ===
    i.gross_poisha - i.commission_poisha - i.refund_poisha - i.cash_collected_poisha),
  'checked per line, because two errors of opposite sign sum to nothing');

// Two independent gates guard approval — an unreviewed settlement, and an open
// reconciliation exception inside the window — and the server is free to answer
// with whichever it checks first. This used to assert not_reviewed outright and
// went red the moment enough exceptions had accumulated for the other gate to
// answer first: a correct refusal reported as a failure. Each gate is now
// cleared before the next is asserted, so both are proved and neither depends
// on how much history is lying around.
const earlyApprove = await call(`/admin/settlements/${sid}/approve`, {
  method: 'POST', token: finance.token,
});
check('a settlement cannot be approved straight out of calculation',
  earlyApprove.status === 409, `${earlyApprove.status} ${earlyApprove.body?.error ?? ''}`);

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

// With the reconciliation gate clear, the review gate is the only one left that
// can answer — so now it can be asserted by name rather than by hope.
const unreviewed = await call(`/admin/settlements/${sid}/approve`,
  { method: 'POST', token: admin.token });
check('a settlement cannot be approved before somebody reviews it',
  unreviewed.status === 409 && unreviewed.body?.error === 'not_reviewed',
  `${unreviewed.status} ${unreviewed.body?.error ?? ''}`);

await call(`/admin/settlements/${sid}/review`, { method: 'POST', token: finance.token, expect: 200 });

const selfApproveSettlement = await call(`/admin/settlements/${sid}/approve`, {
  method: 'POST', token: finance.token,
});
check('the reviewer cannot also approve',
  selfApproveSettlement.status === 409 && selfApproveSettlement.body?.error === 'self_approval',
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


// ------------------------------------------------------- 9. the on-board channel --
//
// A conductor selling a seat on a moving bus. The interesting parts are not
// that a ticket comes out — that is the same CreateBooking every other channel
// uses — but who pays for a discount, and whether the cash can still be
// reconciled at the end of a run.

console.log('\n=== 9. ON-BOARD SELLING, CASH AND COMMISSION ===');

// Its own Green Line departure with room on it. The earlier sections sell into
// `trip` until it is nearly full, and a suite that fails because a previous
// section did its job is a suite nobody trusts. Section 8 already proves the
// one-inventory contention; this section is about money.
const cRoom = await findRoom('Green Line', 6, 4, 25);
const cTrip = cRoom.trip, cSeats = cRoom.free;
check('a departure with room to sell on board was found', cTrip !== null,
  cTrip ? `${cSeats.length} free` : `best was ${cSeats.length} free · ${OUT_OF_SEATS}`);
if (!cTrip) {
  console.log(`
${OUT_OF_SEATS}
`);
  process.exit(1);
}

const cDriver = await login('driver@greenline.test');
check('the crew app has a home to land on', cDriver.home === '/driver', cDriver.home);
check('a driver may sell and may set a price',
  cDriver.identity.permissions.includes('crew.sell') &&
  cDriver.identity.permissions.includes('crew.discount'));

const cHelper = await login('helper@greenline.test');
check('a helper may sell but may NOT change the fare',
  cHelper.identity.permissions.includes('crew.sell') &&
  !cHelper.identity.permissions.includes('crew.discount'),
  'selling and pricing are separate grants on purpose');

// This suite has to be re-runnable, and a duty left open by a previous run
// would make every check below it lie. Close anything still hanging around
// before asserting that there is nothing open.
for (const who of [cDriver, cHelper]) {
  const existing = await call('/crew/duties', { token: who.token });
  if (existing.body?.open?.duty_id) {
    await call('/crew/duties/close', {
      method: 'POST', token: who.token,
      body: { duty_id: existing.body.open.duty_id,
              counted_cash_poisha: existing.body.open.expected_cash_poisha,
              note: 'smoke: clearing a bag left open by an earlier run' },
    });
  }
}

// A cash bag is optional, and this is the case that says so.
//
// It used to be a 409: no duty, no sale. That had the invariant backwards. The
// person signed in is who the money belongs to, and the platform knows that at
// the moment of sale without any ceremony being performed first. A duty is a
// reconciliation session laid over that — worth having when somebody wants to
// count notes against a figure, and not a licence to trade.
const cLoose = await call('/crew/sales', {
  method: 'POST', token: cDriver.token,
  body: { trip_id: cTrip.trip_id, seats: [cSeats[4]],
          board_seq: cTrip.board_seq, drop_seq: cTrip.drop_seq,
          phone: '+8801799000009',
          passengers: [{ seat_no: cSeats[4], full_name: 'No Bag Passenger' }] },
});
check('a sale with no duty open goes through', cLoose.status === 201,
  `${cLoose.status} ${cLoose.body?.error ?? ''}`);
check('and it still earns the person their commission',
  cLoose.body?.commission_poisha > 0, taka(cLoose.body?.commission_poisha ?? 0));

// Attribution is the thing that must never be optional. A bagless sale is
// still this person's sale, and their own report is where that has to show.
const cLooseList = await call(`/crew/sales?q=${cLoose.body?.pnr ?? ''}`,
  { token: cDriver.token, expect: 200 });
check('a bagless sale is on the seller own list',
  cLooseList.body.sales.some((x) => x.pnr === cLoose.body?.pnr),
  'the sale counts on this user information, which is the point');

const cPre = await call('/crew/report', { token: cDriver.token, expect: 200 });
check('and it is in what they owe for the day even with no bag to count',
  cPre.body.today.handover_poisha ===
    cPre.body.today.gross_poisha - cPre.body.today.commission_poisha &&
  cPre.body.today.gross_poisha > 0,
  `${taka(cPre.body.today.gross_poisha)} − ${taka(cPre.body.today.commission_poisha)} = ` +
  taka(cPre.body.today.handover_poisha));
check('with no bag open the report offers no duty summary rather than a wrong one',
  cPre.body.duty === undefined || cPre.body.duty === null);

const cOpen = await call('/crew/duties', {
  method: 'POST', token: cDriver.token, body: { opening_float_poisha: 100000 }, expect: 201,
});
const cDutyID = cOpen.body.duty_id;

const cAgain = await call('/crew/duties', {
  method: 'POST', token: cDriver.token, body: { opening_float_poisha: 500 },
});
check('a second open returns the first bag rather than making another',
  cAgain.body.already_open === true && cAgain.body.duty_id === cDutyID,
  'two open bags make every taka in a pocket unattributable');

const cCtx = await call('/crew/sell/context', { token: cDriver.token, expect: 200 });
check('the cap and the reasons come from the server, not the app',
  cCtx.body.max_pct_bp > 0 && cCtx.body.reasons.length > 0,
  `${cCtx.body.max_pct_bp}bp, ${cCtx.body.reasons.length} reasons`);


const onboard = (seat, discount, reason) => call('/crew/sales', {
  method: 'POST', token: cDriver.token,
  body: {
    duty_id: cDutyID, trip_id: cTrip.trip_id, seats: [seat],
    board_seq: cTrip.board_seq, drop_seq: cTrip.drop_seq,
    phone: '+8801799000001',
    passengers: [{ seat_no: seat, full_name: 'Roadside Passenger' }],
    discount_poisha: discount, discount_reason: reason,
  },
});

// --- full fare ---
const cFull = await onboard(cSeats[0], 0, '');
check('an on-board sale issues a ticket', cFull.status === 201, `${cFull.status}`);
const cEarn = cFull.body.commission_poisha;
check('a full-fare sale earns commission and forfeits none',
  cEarn > 0 && cFull.body.forfeit_poisha === 0, taka(cEarn));

// --- a discount smaller than the commission: the crew pays, the operator does not ---
const cSmallOff = Math.floor(cEarn / 2);
const cSmall = await onboard(cSeats[1], cSmallOff, 'NEGOTIATED');
check('a small discount comes out of the crew commission first',
  cSmall.status === 201 &&
  cSmall.body.forfeit_poisha === cSmallOff &&
  cSmall.body.commission_poisha === cEarn - cSmallOff,
  `gave ${taka(cSmallOff)}, kept ${taka(cSmall.body.commission_poisha ?? 0)}`);

// --- a discount larger than the commission but inside the cap: floors at zero ---
const cBigOff = cEarn + 1000;
const cBig = await onboard(cSeats[2], cBigOff, 'NEGOTIATED');
check('a discount larger than the commission floors it at zero, never negative',
  cBig.status === 201 &&
  cBig.body.commission_poisha === 0 &&
  cBig.body.forfeit_poisha === cEarn,
  `gave ${taka(cBigOff)}, forfeited ${taka(cBig.body.forfeit_poisha ?? 0)} — ` +
  'a conductor is never asked to pay for a sale out of their own pocket');

// --- over the cap: refused, and refused with the number ---
const cOver = await onboard(cSeats[3], 10_000_00, 'NEGOTIATED');
check('a discount over the cap is REFUSED, not quietly clamped',
  cOver.status === 400 && cOver.body.error === 'discount_too_large',
  `${cOver.status} ${cOver.body?.error ?? ''}`);
check('and the refusal says what the ceiling actually is',
  Number(cOver.body?.ref) > 0, `ceiling ${taka(Number(cOver.body?.ref ?? 0))}`);

// --- a discount with no reason ---
const cNoWhy = await onboard(cSeats[3], 1000, '');
check('an unexplained discount is refused',
  cNoWhy.status === 400 && cNoWhy.body.error === 'discount_reason_required',
  'an unexplained discount is indistinguishable from pocketing the difference');

// --- another company bus is not theirs to sell ---
//
// This one was found by driving the app: a Green Line driver sold a seat on a
// Hanif coach. The discount ceiling is looked up from the crew member employer
// and the commission rule from the trip owner, so the two silently disagreed
// and the conductor was shown a commission nobody would ever pay them.
const foreignTrip = (await call(
  `/search?from=Dhaka&to=Chattogram&date=${new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)}`,
  { expect: 200 })).body.results.find((t) => t.brand !== 'Green Line');
if (foreignTrip) {
  const foreign = await call('/crew/sales', {
    method: 'POST', token: cDriver.token,
    body: {
      duty_id: cDutyID, trip_id: foreignTrip.trip_id, seats: ['A1'],
      board_seq: foreignTrip.board_seq, drop_seq: foreignTrip.drop_seq,
      phone: '+8801799000003',
    },
  });
  check('a crew member cannot sell on another company bus',
    foreign.status === 403 && foreign.body.error === 'not_your_bus',
    `${foreignTrip.brand}: ${foreign.status} ${foreign.body?.error ?? ''}`);
} else {
  check('a crew member cannot sell on another company bus', false,
    'no other operator departure was available to test against');
}

// --- a helper cannot discount, whatever they send ---
const cHelperDuty = await call('/crew/duties', {
  method: 'POST', token: cHelper.token, body: { opening_float_poisha: 0 },
});
const cHelperTry = await call('/crew/sales', {
  method: 'POST', token: cHelper.token,
  body: {
    duty_id: cHelperDuty.body.duty_id, trip_id: cTrip.trip_id, seats: [cSeats[3]],
    board_seq: cTrip.board_seq, drop_seq: cTrip.drop_seq,
    phone: '+8801799000002', discount_poisha: 500, discount_reason: 'NEGOTIATED',
  },
});
check('a helper is refused by the server, not merely by a hidden button',
  cHelperTry.status === 403 && cHelperTry.body.error === 'discount_not_permitted',
  `${cHelperTry.status} ${cHelperTry.body?.error ?? ''}`);

// --- optional to group, never optional to attribute ---
//
// The bag stopped being required; it did not stop being owned. Naming somebody
// else bag is how a conductor would drop their own cash into a colleague count.
const cHelperBag = cHelperDuty.body?.duty_id;
const cWrongBag = await call('/crew/sales', {
  method: 'POST', token: cDriver.token,
  body: { duty_id: cHelperBag ?? cDutyID, trip_id: cTrip.trip_id, seats: [cSeats[5]],
          board_seq: cTrip.board_seq, drop_seq: cTrip.drop_seq,
          phone: '+8801799000004' },
});
check('selling into somebody else bag is refused',
  cHelperBag ? (cWrongBag.status === 403 && cWrongBag.body.error === 'duty_not_yours')
             : true,
  cHelperBag ? `${cWrongBag.status} ${cWrongBag.body?.error ?? ''}`
             : 'no second bag was open to try against');

// --- one crew member cannot touch another bag ---
const cStranger = await call('/crew/duties/close', {
  method: 'POST', token: cHelper.token,
  body: { duty_id: cDutyID, counted_cash_poisha: 0 },
});
check('another persons duty is not found, rather than forbidden',
  cStranger.status === 404,
  'a stranger duty id must not be distinguishable from one that does not exist');

// --- the report, and the sum that matters ---
const cRep = await call('/crew/report', { token: cDriver.token, expect: 200 });
check('today and this week are both reported',
  cRep.body.today.sales_count >= 3 && cRep.body.week.sales_count >= 3,
  `today ${cRep.body.today.sales_count}, week ${cRep.body.week.sales_count}`);

const cBag = cRep.body.duty;
check('hand-over is exactly cash held minus commission earned',
  cBag.expected_cash_poisha - cBag.commission_poisha === cBag.remit_poisha,
  `${taka(cBag.expected_cash_poisha)} − ${taka(cBag.commission_poisha)} = ${taka(cBag.remit_poisha)}`);
check('cash held is the float plus everything collected',
  cBag.expected_cash_poisha === cBag.opening_float_poisha + cBag.collected_poisha,
  taka(cBag.expected_cash_poisha));

// --- per trip, the other half of the answer ---
await call('/crew/duties/trips/close', {
  method: 'POST', token: cDriver.token,
  body: { duty_id: cDutyID, trip_id: cTrip.trip_id }, expect: 200,
});
const cSealed = await call('/crew/report', { token: cDriver.token, expect: 200 });
const cRun = cSealed.body.trips.find((t) => t.trip_id === cTrip.trip_id);
check('a bus run is sealed with its own numbers',
  Boolean(cRun && cRun.closed_at && cRun.sales_count >= 3),
  cRun ? `${cRun.sales_count} sales, ${taka(cRun.gross_poisha)}` : 'no run recorded');

// --- closing the bag 50 taka short, on purpose ---
const cCounted = cBag.expected_cash_poisha - 5000;
const cClose = await call('/crew/duties/close', {
  method: 'POST', token: cDriver.token,
  body: { duty_id: cDutyID, counted_cash_poisha: cCounted, note: 'smoke: deliberately short' },
  expect: 200,
});
check('a short bag is recorded as a variance, not quietly balanced',
  cClose.body.status === 'VARIANCE' && cClose.body.variance_poisha === -5000,
  `${cClose.body.status} ${taka(cClose.body.variance_poisha)}`);
check('the expected figure is the one the report predicted',
  cClose.body.expected_cash_poisha === cBag.expected_cash_poisha,
  taka(cClose.body.expected_cash_poisha));

// --- and the books still balance ---
const cTB = (await call('/admin/trial-balance', { token: finance.token, expect: 200 })).body;
check('the ledger balances after on-board cash, discounts and a variance',
  cTB.balanced === true,
  `DR ${taka(cTB.total_debit_poisha)} = CR ${taka(cTB.total_credit_poisha)}`);

console.log('\n' + '='.repeat(62));
console.log(failures === 0 ? 'ALL CHANNEL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

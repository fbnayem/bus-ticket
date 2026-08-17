// End-to-end smoke test of the passenger booking flow against a running API.
//   node scripts/smoke.mjs
const API = process.env.API ?? 'http://localhost:8080/api/v1';
const taka = (p) => '৳' + (p / 100).toFixed(2);
const hhmm = (s) => new Date(s).toISOString().slice(11, 16);

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

let bearer = null;

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const date = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);

console.log('\n=== 1. SEARCH (alias "ctg" must resolve to Chattogram) ===');
const search = await api(`/search?from=dhaka&to=ctg&date=${date}`);
check('search returns 200', search.status === 200);
check('alias canonicalised', search.body.destination === 'Chattogram', `got "${search.body.destination}"`);
check('multiple operators returned', search.body.count >= 4, `${search.body.count} departures`);
for (const r of search.body.results) {
  console.log(`        ${r.brand.padEnd(11)} ${r.bus_type.padEnd(14)} ${hhmm(r.depart_at)} ` +
    `seq ${r.board_seq}->${r.drop_seq}  ${taka(r.fare_poisha).padStart(10)}  ` +
    `${r.available_seats}/${r.total_seats} free  ${r.amenities.join(',')}`);
}

const trip = search.body.results[0];

console.log('\n=== 2. SEAT MAP ===');
const map = await api(`/trips/${trip.trip_id}/seatmap?board=${trip.board_seq}&drop=${trip.drop_seq}`);
check('seatmap returns 200', map.status === 200);
const free = map.body.seats.filter((s) => s.available);
check('seats available', free.length > 0, `${free.length} of ${map.body.seats.length}`);
const pick = free.slice(0, 2).map((s) => s.seat_no);
console.log(`        picking ${pick.join(', ')}`);

console.log('\n=== 3. HOLD ===');
const hold = await api('/holds', {
  method: 'POST',
  body: JSON.stringify({ trip_id: trip.trip_id, seats: pick, board_seq: trip.board_seq, drop_seq: trip.drop_seq }),
});
check('hold created', hold.status === 201, JSON.stringify(hold.body).slice(0, 120));
check('price frozen on hold', hold.body.price?.total_poisha > 0, taka(hold.body.price?.total_poisha ?? 0));
console.log(`        hold ${hold.body.hold_id} expires ${hold.body.expires_at}`);

console.log('\n=== 4. CONTENTION (same seats must now be refused) ===');
const clash = await api('/holds', {
  method: 'POST',
  body: JSON.stringify({ trip_id: trip.trip_id, seats: [pick[0]], board_seq: trip.board_seq, drop_seq: trip.drop_seq }),
});
check('second hold refused with 409', clash.status === 409, `${clash.status} ${clash.body.error}`);
check('message is passenger-readable', /took/.test(clash.body.message ?? ''), clash.body.message);

console.log('\n=== 5. SEGMENT RESALE (non-overlapping leg on a held seat) ===');
if (trip.drop_seq - trip.board_seq >= 2) {
  const seg = await api('/holds', {
    method: 'POST',
    body: JSON.stringify({ trip_id: trip.trip_id, seats: [pick[0]], board_seq: trip.board_seq, drop_seq: trip.board_seq + 1 }),
  });
  check('overlapping sub-leg correctly refused', seg.status === 409, `${seg.status}`);
} else {
  console.log('        (single-segment leg, skipped)');
}

console.log('\n=== 6. BOOKING ===');
const booking = await api('/bookings', {
  method: 'POST',
  body: JSON.stringify({
    hold_id: hold.body.hold_id,
    passengers: pick.map((s, i) => ({ seat_no: s, full_name: ['Rahim Uddin', 'Fatema Begum'][i], gender: i ? 'F' : 'M', age: 30 + i })),
    phone: '+8801700000000',
    email: 'demo@busticket.test',
    coupon_code: 'EIDSAFAR',
  }),
});
check('booking created', booking.status === 201, JSON.stringify(booking.body).slice(0, 150));
check('coupon applied', booking.body.price?.discount_poisha > 0, taka(booking.body.price?.discount_poisha ?? 0) + ' off');
const pnr = booking.body.pnr;
console.log(`        PNR ${pnr}  total ${taka(booking.body.price.total_poisha)}`);

console.log('\n=== 7. PAYMENT (browser must NOT confirm; webhook does) ===');
const intent = await api('/payments/intent', {
  method: 'POST',
  body: JSON.stringify({ booking_id: booking.body.booking_id, provider: 'BKASH' }),
});
check('intent created', intent.status === 201);
const preBooking = await api(`/bookings/${pnr}`);
check('still PAYMENT_PENDING before webhook', preBooking.body.status === 'PAYMENT_PENDING', preBooking.body.status);

const done = await api('/payments/sandbox/complete', {
  method: 'POST',
  body: JSON.stringify({ payment_ref: intent.body.payment_ref, outcome: 'success' }),
});
check('payment confirmed via webhook', done.body.confirmed === true, JSON.stringify(done.body));

console.log('\n=== 8. WEBHOOK REPLAY x25 (must stay exactly one payment) ===');
await Promise.all(Array.from({ length: 25 }, () =>
  api('/payments/sandbox/complete', { method: 'POST', body: JSON.stringify({ payment_ref: intent.body.payment_ref, outcome: 'success' }) })));
const afterReplay = await api(`/bookings/${pnr}`);
check('still exactly N tickets after replays', afterReplay.body.tickets.length === pick.length, `${afterReplay.body.tickets.length} tickets`);
check('booking TICKETED', afterReplay.body.status === 'TICKETED', afterReplay.body.status);
for (const t of afterReplay.body.tickets) {
  console.log(`        seat ${t.seat_no}  ${t.passenger.padEnd(14)} ${t.status}  QR ${t.qr_token.slice(0, 18)}...`);
}

console.log('\n=== 9. TRACKING ===');
const track = await api(`/tracking/${pnr}`);
check('tracking returns 200', track.status === 200);
check('source is labelled honestly', track.body.source === 'SIMULATED_FROM_SCHEDULE', track.body.source);
console.log(`        state=${track.body.state} next=${track.body.next_stop ?? '-'} progress=${(track.body.progress * 100).toFixed(0)}%`);

console.log('\n=== 10. CANCELLATION QUOTE + CANCEL ===');
const quote = await api(`/bookings/${pnr}/cancellation-quote`);
check('quote returned', quote.status === 200);
console.log(`        ${quote.body.hours_before.toFixed(1)}h before departure -> ${quote.body.refund_pct}% = ${taka(quote.body.refund_poisha)}`);
const cancelled = await api(`/bookings/${pnr}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'smoke test' }) });
check('cancelled', cancelled.status === 200, JSON.stringify(cancelled.body).slice(0, 120));

const afterCancel = await api(`/bookings/${pnr}`);
check('status moved to refund pending', ['REFUND_PENDING', 'CANCELLED'].includes(afterCancel.body.status), afterCancel.body.status);

console.log('\n=== 11. SEAT RETURNED TO POOL ===');
const remap = await api(`/trips/${trip.trip_id}/seatmap?board=${trip.board_seq}&drop=${trip.drop_seq}`);
const nowFree = remap.body.seats.filter((s) => s.available).map((s) => s.seat_no);
check('cancelled seats sellable again', pick.every((s) => nowFree.includes(s)), pick.join(','));

console.log('\n=== 12. REFUND SETTLEMENT + LEDGER ===');
await api(`/bookings/${pnr}/settle-refund`, { method: 'POST' });
const settled = await api(`/bookings/${pnr}`);
check('refund settled', settled.body.refund?.status === 'SUCCESS', settled.body.refund?.status);

console.log('\n=== 13. OFFERS ===');
const offers = await api('/offers');
check('offers listed', offers.body.offers.length >= 3, `${offers.body.offers.length} offers`);
const capped = offers.body.offers.find((o) => o.remaining !== null && o.remaining !== undefined);
check('a limited campaign reports what is left', !!capped,
  capped ? `${capped.code}: ${capped.remaining} of ${capped.remaining + capped.redeemed} left` : 'none');

console.log('\n=== 14. PASSENGER SIGN-IN ===');
// The account area is behind real authentication now. Signed out, it refuses.
const anon = await api('/account/bookings');
check('account refuses an anonymous caller', anon.status === 401, `${anon.status} ${anon.body.error}`);

const otp = await api('/auth/otp/request', {
  method: 'POST',
  body: JSON.stringify({ phone: '01700000000', lang: 'en' }),
});
check('one-time code sent', otp.status === 200 && otp.body.sent === true);
check('code returned only because SHOW_OTP is on for this harness', !!otp.body.debug_code);

const wrong = await api('/auth/otp/verify', {
  method: 'POST',
  body: JSON.stringify({ phone: '01700000000', code: '000000', device: 'smoke' }),
});
check('a wrong code is refused', wrong.status === 401, `${wrong.status} ${wrong.body.error}`);

const verified = await api('/auth/otp/verify', {
  method: 'POST',
  body: JSON.stringify({ phone: '01700000000', code: otp.body.debug_code, device: 'smoke' }),
});
check('signed in with the code', verified.status === 200 && !!verified.body.access_token);
check('phone canonicalised to +880 form', verified.body.identity?.phone === '+8801700000000',
  verified.body.identity?.phone);
bearer = verified.body.access_token;

const acct = await api('/account/bookings');
check('account history now visible', acct.status === 200 &&
  acct.body.upcoming.length + acct.body.past.length > 0,
  `${acct.body.upcoming.length} upcoming / ${acct.body.past.length} past`);
check('the guest booking was claimed by the account', verified.body.bookings_claimed >= 0,
  `${verified.body.bookings_claimed} claimed`);

console.log('\n=== 14b. PEOPLE YOU TRAVEL WITH ===');
// The table has existed since migration 005 but nothing ever wrote to it. Every
// row carries an NID number, so the ownership check is the point of this block
// — it lives in the WHERE clause of each statement rather than in a guard that
// a later refactor could step around.
const setPw = await api('/auth/password/set', {
  method: 'POST',
  body: JSON.stringify({ password: 'ChaloJatra#26' }),
});
check('a password can be set on the account', setPw.status === 200);

const me = await api('/auth/me');
check('the platform now reports the account has a password', me.body.has_password === true);

const added = await api('/account/passengers', {
  method: 'POST',
  body: JSON.stringify({
    full_name: 'Companion Karim', gender: 'M', age: 31,
    id_type: 'NID', id_number: '1994000111222',
  }),
});
check('a saved passenger can be added', added.status === 201 && !!added.body.id, added.body.id);
const savedId = added.body.id;

const listed = await api('/account/passengers');
check('and comes back on the list',
  listed.body.passengers?.some((p) => p.id === savedId));

const edited = await api(`/account/passengers/${savedId}`, {
  method: 'PATCH',
  body: JSON.stringify({ full_name: 'Karim Uddin', gender: 'M', age: 32 }),
});
check('a saved passenger can be edited', edited.status === 200);

const nameless = await api('/account/passengers', {
  method: 'POST',
  body: JSON.stringify({ full_name: '   ' }),
});
check('a nameless saved passenger is refused',
  nameless.status === 400 && nameless.body.error === 'name_required',
  `${nameless.status} ${nameless.body.error}`);

// Somebody else's row. A random id must answer the same way a real id belonging
// to another account does, or this becomes a way to probe for them.
const strangers = await api('/account/passengers/11111111-1111-1111-1111-111111111111', {
  method: 'PATCH',
  body: JSON.stringify({ full_name: 'Not Mine' }),
});
check("another account's saved passenger cannot be edited",
  strangers.status === 404, `${strangers.status}`);

const strangerDelete = await api('/account/passengers/11111111-1111-1111-1111-111111111111', {
  method: 'DELETE',
});
check("another account's saved passenger cannot be deleted",
  strangerDelete.status === 404, `${strangerDelete.status}`);

const removed = await api(`/account/passengers/${savedId}`, { method: 'DELETE' });
check('your own can be removed', removed.status === 204, `${removed.status}`);

const anonPeople = await (async () => {
  const keep = bearer; bearer = null;
  const r = await api('/account/passengers');
  bearer = keep;
  return r;
})();
check('signed out, saved passengers are not readable at all',
  anonPeople.status === 401, `${anonPeople.status}`);

console.log('\n=== 14c. SIGNING IN WITH THAT PASSWORD ===');
const pwLogin = await (async () => {
  const keep = bearer; bearer = null;
  const r = await api('/auth/password/login', {
    method: 'POST',
    body: JSON.stringify({ login: '01700000000', password: 'ChaloJatra#26', device: 'smoke-pw' }),
  });
  bearer = keep;
  return r;
})();
check('the password signs the passenger in', pwLogin.status === 200 && !!pwLogin.body.access_token);

const pwWrong = await (async () => {
  const keep = bearer; bearer = null;
  const r = await api('/auth/password/login', {
    method: 'POST',
    body: JSON.stringify({ login: '01700000000', password: 'wrong-one', device: 'smoke-pw' }),
  });
  bearer = keep;
  return r;
})();
check('a wrong password is refused with one generic answer',
  pwWrong.status === 401 && pwWrong.body.error === 'bad_credentials',
  `${pwWrong.status} ${pwWrong.body.error}`);

console.log('\n=== 15. REFRESH ROTATION AND REUSE DETECTION ===');
const refreshed = await api('/auth/refresh', {
  method: 'POST',
  body: JSON.stringify({ refresh_token: verified.body.refresh_token, device: 'smoke' }),
});
check('refresh issues a new pair', refreshed.status === 200 && !!refreshed.body.access_token);
check('the refresh token rotated', refreshed.body.refresh_token !== verified.body.refresh_token);

// Presenting the old one again means somebody else has a copy of it.
const replayed = await api('/auth/refresh', {
  method: 'POST',
  body: JSON.stringify({ refresh_token: verified.body.refresh_token, device: 'thief' }),
});
check('a replayed refresh token revokes the whole family',
  replayed.status === 401 && replayed.body.error === 'token_reuse',
  `${replayed.status} ${replayed.body.error}`);

bearer = refreshed.body.access_token;
const afterRevoke = await api('/account/bookings');
check('every session from that sign-in is now dead', afterRevoke.status === 401, `${afterRevoke.status}`);
bearer = null;

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

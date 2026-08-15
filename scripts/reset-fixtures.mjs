// Give the test fixtures their seats back.
//   node scripts/reset-fixtures.mjs [--days 3] [--operator "Green Line"]
//
// The browser suites sell real tickets on real trips, and the corridor fixture
// has one departure per operator per day. Run them enough times and the near
// departures fill up, at which point the suites are failing on a fixture
// shortage rather than on anything about the platform.
//
// This gives the seats back the only way the platform allows: by cancelling the
// bookings through the same endpoint a passenger uses. That means refunds are
// quoted by policy, seats are released by inventory-service, and the ledger
// stays balanced — which is the point. There is no back door that reaches into
// trip_seats, because there is no back door anywhere.

const API = process.env.API ?? 'http://localhost:8080/api/v1';
const PW = process.env.STAFF_PASSWORD ?? 'Jatra#2026';

const args = process.argv.slice(2);
const argOf = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DAYS = Number(argOf('--days', '3'));
const OPERATOR = argOf('--operator', 'Green Line');

async function call(path, { method = 'GET', body, token } = {}) {
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
  return { status: res.status, body: json };
}

const login = await call('/staff/login', {
  method: 'POST', body: { email: 'admin@jatra.test', password: PW },
});
if (login.status !== 200) {
  console.error('Could not sign in as admin:', login.body?.message ?? login.status);
  process.exit(1);
}
const token = login.body.token;

const horizon = new Date(Date.now() + DAYS * 864e5);
const list = (await call('/admin/bookings?limit=500', { token })).body.bookings ?? [];

const candidates = list.filter((b) =>
  b.status === 'TICKETED' &&
  b.operator === OPERATOR &&
  new Date(b.depart_at) > new Date() &&
  new Date(b.depart_at) <= horizon);

if (candidates.length === 0) {
  console.log(`Nothing to release: no ticketed ${OPERATOR} bookings depart in the next ${DAYS} days.`);
  process.exit(0);
}

console.log(`Releasing ${candidates.length} ticketed ${OPERATOR} booking(s) departing in the next ${DAYS} days.`);

let cancelled = 0, refused = 0;
for (const b of candidates) {
  const res = await call(`/bookings/${b.pnr}/cancel`, {
    method: 'POST', body: { reason: 'fixture reset' },
  });
  if (res.status === 200) {
    cancelled++;
  } else {
    refused++;
    console.log(`  ${b.pnr}: ${res.body?.message ?? res.status}`);
  }
}

// Settle the refunds so the books do not sit on a pile of Refund Payable that
// nobody ever discharges.
for (const b of candidates) {
  await call(`/bookings/${b.pnr}/settle-refund`, { method: 'POST' });
}

const tb = (await call('/admin/trial-balance', { token })).body;
console.log(`\n${cancelled} cancelled, ${refused} refused.`);
console.log(`Trial balance after: ${tb?.balanced ? 'balanced' : 'OUT BY ' + tb?.variance_poisha}`);

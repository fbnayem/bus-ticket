# The two mobile applications

Flutter, Android and iOS, against the same platform every other channel uses.

```
apps/mobile/
  jatra_core/   the shared spine: API client, models, catalogue, palette, stores
  passenger/    Jatra — search, seat, pay, and a ticket that opens with no signal
  crew/         Jatra Crew — trips, the passenger list, boarding, the road
```

## The rule these apps exist under

**Every sales channel calls the same inventory service.** Neither app holds seat
state, decides availability, or reserves anything locally. `createHold` posts to
the same service the website, the counter POS, the agent portal and the partner
API post to, and the answer it returns is the only truth about that seat. If two
people tap the same seat in the same second, exactly one hold is granted, and it
is granted by one conditional `UPDATE` in the inventory service — not by
whichever phone is faster.

Three consequences you will see throughout the code:

- **The app never confirms a payment.** Tapping *approve* tells the provider the
  customer finished. What issues a ticket is the platform's own verified webhook
  chain, and the app finds out by asking the platform what happened.
- **Money is an integer count of poisha.** No double touches a fare anywhere.
- **Every mutation carries an idempotency key** minted on the device before the
  request leaves it, and reused on retry. A tap that times out and is repeated
  cannot take two sets of seats or board one passenger twice.

## What is on the device, and why

The device holds *copies* and *intentions*, never a fact the platform does not
already have or is not about to be told.

| Held | Because |
|---|---|
| The ticket and its signed QR token | A ticket is needed at a bus door, which is exactly where there are no bars. This is the whole argument for an app over a web page. |
| The passenger list, fetched before departure | It is what an offline boarding check is decided against. |
| Boarding checks taken without a line | Each carries the `client_ref` it was minted with, so flushing the queue twice boards nobody twice. |
| Departure reminders | The phone already knows when the bus leaves; no push credentials are involved and a guest who never signed in still gets reminded. |

Two rules the offline path keeps, and they are the interesting ones:

- **A provisional yes says it is provisional.** An offline check shows the crew,
  in words, that the office has not confirmed it. A green tick that might be
  wrong is how somebody rides on a cancelled ticket and nobody finds out until
  reconciliation.
- **An unknown ticket queues nothing at all.** With no line and no matching row
  in the cached list, the device has no basis for saying this person may travel,
  so it says so and writes nothing. Guessing *yes* is the one mistake that
  cannot be taken back once the bus has left.

## Running them

```bash
# The platform first — see the root README.
#   :8080 API, :3000 web

cd apps/mobile/passenger
flutter run --dart-define=JATRA_API=http://10.0.2.2:8080/api/v1     # emulator
flutter run --dart-define=JATRA_API=http://192.168.1.20:8080/api/v1 # real phone
```

`10.0.2.2` is the host machine as seen from the Android emulator. A phone on the
same wifi needs the machine's LAN address. The default baked into
`jatra_core` is the emulator one.

Crew sign-in uses the same staff accounts as the web workplaces —
`driver@greenline.test`, password in the root README. Passengers sign in with a
mobile number and a six-digit code, or skip it entirely: guest checkout is the
default path here as it is on the website.

## Verifying

```bash
flutter analyze                     # in each of the three packages
flutter test                        # 26 tests; the live ones are skipped
flutter test --tags live            # 8 more, against a running platform
flutter build apk --release
```

The live tests are the ones worth understanding. Everything else proves the app
agrees with itself; only these prove it agrees with the server. The passenger
one walks a whole journey — search, seat map, hold, a second hold on the same
seat refused with a 409, booking, payment, the wait for the webhook, the QR
token, the offline copy, tracking, the cancellation quote, the cancellation, and
the seat going back on sale. They are excluded from an ordinary `flutter test`
run so the suite passes on a machine with nothing in front of it.

They earn their keep: they caught the client returning an empty map for an empty
`400`, because it shortcut on an empty body before it looked at the status. Every
caller read that as a successful, empty answer — a search with no buses, a
booking with no tickets.

## What these builds are not

- **Not signed for a store.** The release APKs use the debug key, so they install
  and run and are deliberately not upload-ready. A real key belongs in a keystore
  this repository does not hold.
- **No server-sent push.** Departure reminders are scheduled on the device and
  need no credentials. News only the platform can know — a trip cancelled at
  short notice, a bus running late — needs FCM, and that is a project and a set
  of credentials this build does not have. The seam is left open in
  `reminders.dart` rather than faked.
- **iOS is scaffolded, not built.** The passenger project has its `ios/` folder
  and its `Info.plist` usage strings; building it needs a Mac.

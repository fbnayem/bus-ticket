# Passenger app: a shell that stays, a device that knows you, a profile worth opening, and a voice

This document describes everything in the three commits on
`feature/passenger-shell-identity-profile-voice`, which is the whole of the
passenger-facing work done after `81228fc`.

| Commit | Subject |
|---|---|
| `a07abf2` | A field that suggests where you are going, over the place names of Bangladesh |
| `11a45ab` | Tell a sold seat from a free one, and stop demanding four names to sell four seats |
| `988655b` | A shell that stays put, a device that knows you, a profile worth opening, and a voice |

They are one story: a passenger could not reliably say *where* they were going,
could not see *which* seats were free, had to name four people to buy four
tickets, lost the navigation the moment they went anywhere, and was a stranger
to the app the day after paying it money. Each commit closes one of those.

The architectural rule that governs the platform is untouched by all of it:

> **Every sales channel calls the exact same Inventory Service. No channel gets
> its own seat logic.**

Voice is a channel like any other. It holds seats through `POST /holds` and
books through `POST /bookings`, the same two calls the web checkout makes. There
is no voice-only path into inventory, and there is deliberately no code in the
voice flow that knows what a seat is.

---

## 1 · Finding a place (`a07abf2`)

### The problem

Origin and destination were free-text fields. A passenger who typed `Chittagong`
— the spelling on every bus ticket printed before 2018 — got nothing, because
the catalogue says `Chattogram`. Someone typing in Bangla got nothing at all.
The field accepted whatever was typed and failed at search time, which is the
worst possible moment to tell somebody they spelled a city wrong.

### The gazetteer

`db/migrations/019_gazetteer.sql` gives the system the place names of the
country rather than the handful the seed data happened to contain:

- **8 divisions**, **64 districts** — the complete administrative set
- **9 towns** that matter to bus travel without being district seats: Kuakata,
  Sreemangal, Benapole, Teknaf, Burimari, Jaflong, Chowmuhani, Elenga,
  Hatikumrul
- **40 terminals** — Gabtoli, Sayedabad, Mohakhali, Kalabagan, AK Khan,
  Damparaand the rest
- **289 aliases**, including every pre-2018 spelling (Chittagong, Dacca,
  Comilla, Jessore, Barisal, Bogra, Noakhali…), common misspellings, and the
  short forms people actually type

Three columns carry it: `name_bn` on `catalog.locations`, and
`name_bn` / `parent_name` / `trips_to` on `search.location_index`.

### The ranking

`Suggest()` in `services/searchidx/searchidx/searchidx.go` ranks in four tiers
and only falls back to fuzzy matching when the tiers miss:

| Tier | Meaning |
|---|---|
| 0 | Exact — the name, the Bangla name, or a listed alias |
| 1 | Prefix — what you get while still typing |
| 2 | Contains — anywhere in the search blob |
| 3 | Trigram similarity ≥ 0.28 (`pg_trgm`, `gin_trgm_ops`) |

Two details in that query were bugs before they were features:

- **Empty query returns something useful.** The filter was `tier < 3`, and an
  empty query scored everything at tier 4 — so focusing the field showed
  nothing. An empty query is now tier 0, and the result is the places that
  actually have buses today (`trips > 0`), with a `NOT EXISTS` fallback so a
  fresh database still shows a list rather than a blank.
- **"Chattogram · Chattogram"** — eight divisions share a name with their main
  district, so the parent label repeated the place. `COALESCE(NULLIF(p.name,
  l.name), '')` drops the parent when it is the same word.

### The controls

`apps/web/components/LocationPicker.tsx` is a **combobox, not a `<datalist>`**.
That distinction is the whole point: a datalist is a *hint* — the browser
happily submits whatever was typed, so `Chittagong` would still reach the API.
A combobox constrains the value. What is shown and what is submitted are split:
the passenger sees `চট্টগ্রাম`, the form submits `Chattogram`.

Debounced 140 ms, with a sequence guard so a slow response for `dha` cannot
overwrite a fast one for `dhaka`. Focus selects the existing text, because the
common case for touching a filled field is replacing it. Selection fires on
`mousedown` rather than `click` — by `click` the blur has already closed the
list.

`apps/mobile/jatra_core/lib/src/place_picker.dart` is the same idea as a
full-height sheet, falling back to `store.recentPlaces()` with no network.

**Verified by** `apps/web/scripts/place-picker.mjs` — 18 checks, including the
one that matters: typing a valid old spelling and submitting sends the
canonical name.

---

## 2 · Seats you can tell apart, and one name instead of four (`11a45ab`)

### Seat colour

The sold seat was filled `rgba(…, .05)`. In the stylesheet that reads like a
real colour. Composited against the panel it measured **3 of 255** away from a
free seat — indistinguishable at arm's length in daylight, which is where bus
tickets are bought.

Worse, **blocked seats were `background: transparent`** and therefore *lighter*
than free ones, so the seats a passenger can never have looked like the most
available thing on the map.

Both now use solid tokens with a real gap, in both themes:

```css
--seat-sold: #D5DBD3;  --seat-sold-line: #AEB9AA;  --seat-sold-ink: #5C6961;
/* dark */
--seat-sold: #37443C;  --seat-sold-line: #4C5A52;  --seat-sold-ink: #93A29A;
```

Sold is struck through; blocked shares the fill with a dashed border, so the two
unavailable states are distinguishable from each other as well as from free.
`J.seatSold` / `seatSoldLine` / `seatSoldInk` mirror them in Flutter.

The guard in `apps/web/scripts/browser-flow.mjs` **measures composited
luminance** and requires a gap of at least 18. It does not assert on the hex
value — a hex assertion would have passed on the broken version, which is
exactly how the broken version survived.

### One mandatory name

Buying four seats demanded four full names. It is not how anybody buys a
family's tickets, and the operator only needs to reach one person.

Only the lead passenger is required now — web (`apps/web/app/checkout/page.tsx`,
`required={i === 0}`) and app (`apps/mobile/passenger/lib/screens/passengers.dart`).
The rest are optional and can be filled from saved travellers (see §5).

---

## 3 · A bottom bar that stays on screen (`988655b`)

The four tabs were an `IndexedStack` under a `NavigationBar`. Every push went to
the **root** navigator, above the `Scaffold` that paints the bar — so results,
seats, passengers, payment and the ticket all covered it. The app lost its
navigation exactly when somebody was deepest inside it, which is when they are
most likely to want out.

Each tab now owns a `Navigator`, nested inside the shell
(`apps/mobile/passenger/lib/main.dart`):

```dart
Widget _tabNavigator(int i, Widget root) => Navigator(
      key: _navs[i],
      onGenerateRoute: (settings) =>
          MaterialPageRoute(settings: settings, builder: (_) => root),
    );
```

`Navigator.of(context)` resolves to the nearest navigator, which is now the
tab's own — **so not one screen needed changing.** Around it:

- `PopScope(canPop: false, …)` — back pops the active tab first, then returns to
  the first tab, and only then leaves the app. Backing out of the seat map no
  longer closes everything.
- Re-tapping the tab you are on pops it to its root: the way out of a deep flow
  that is not pressing back five times.
- `showPlacePicker` passes `useRootNavigator: true`, so the full-height sheet
  still covers the bar instead of being boxed into one tab.

This is also what makes the mic button possible: it lives in the shell, so voice
is reachable from every screen.

---

## 4 · The purchase makes the device know you (`988655b`)

A typed phone number is not proof of owning it, and `catalog.saved_passengers`
holds NID numbers. Signing somebody in on a typed number would let anyone type a
stranger's number, pay ৳805, and read that person's travel history and identity
documents.

So the purchase creates **device knowledge, which carries no authority**:

- `Store.rememberTraveller(name, phone)` / `traveller`, over `jatra.me.name` and
  `jatra.me.phone` (`jatra_core/lib/src/store.dart`)
- `AppState.known`, `phone`, `displayName`, `forgetMe`

What it buys, none of which needs a server session: the home screen greets by
name, checkout pre-fills, and the account tab reads *"Travelling as Rahim Uddin
/ Saved on this phone only."* with one action — **one tap and a code** — which
runs the existing `verifyOtp` → `signedInAs` path. That already calls
`ident.Promote`, which claims every guest booking on that number.

### Password or code

Both endpoints already existed and neither had ever been called from the app:
`POST /api/v1/auth/password/login` and `POST /api/v1/auth/password/set`.

The sign-in card now has two modes (`_SignInWith { code, password }`) and
remembers which was used last. What was genuinely missing was any way to *know*
whether a password exists, so `identity.HasPassword` was added — one `SELECT
EXISTS` against `identity.credentials` — and surfaced as `has_password` on both
`GET /auth/me` and `GET /account/profile`. After a first OTP sign-in with no
password, the profile offers to set one. It never forces it.

---

## 5 · The profile, rebuilt (`988655b`)

`lib/screens/account.dart` was two switches and a sign-in box. It is now a real
profile, in this order:

1. **Who you are** — name, phone, email, edited through `PATCH /auth/profile`
2. **Your trips** — `GET /account/bookings`, split *coming up* / *travelled*,
   each row opening its ticket; falls back to the device cache offline **and
   says so**
3. **People you travel with** — full CRUD on saved travellers
4. **Getting in** — set or change password, active sessions, sign out everywhere
5. **Preferences** — language, reminders, biometric
6. **Saved routes**

Each section loads independently, so one failing request does not blank the
page.

### New server endpoints

`catalog.saved_passengers` had existed since migration 005 with **nothing ever
writing to it**. Three endpoints in `services/api/httpapi/postbooking.go`:

```
POST   /api/v1/account/passengers        -> 201
PATCH  /api/v1/account/passengers/{id}
DELETE /api/v1/account/passengers/{id}   -> 204
```

Ownership is enforced **inside the SQL**, `AND user_id = $2::uuid`, not by a
guard above it that a later refactor could step around. `RowsAffected() == 0`
returns 404 — a row that does not exist and a row belonging to somebody else get
the same answer, so the endpoint cannot be used to discover whether an ID is
real.

---

## 6 · Voice (`988655b`)

### What it does

```
"kal dhaka theke chittagong, duita seat"
      -> gazetteer resolves the old spelling; search runs; results read out
"first one"
      -> READ-BACK: "Hanif, Dhaka to Chattogram, Tomorrow at 06:00.
                     Seat B2, D3. Total ৳1,610. Shall I hold it?"
      -> explicit spoken yes required  -> hold + booking
"bkash e taka dao"
      -> READ-BACK of the amount
      -> explicit spoken yes required  -> approve (sandbox only)
```

Driven end to end on the emulator, it produced ticket **DH4ATQ**, seats B2 and
D3.

### A grammar, not a model

`jatra_core/lib/src/voice/intent.dart` is pure Dart — no plugins, no network, no
model. A transcript in, a `VoiceIntent` out. That is where the test value lives:
30 table tests run in CI with no device and no microphone.

`voice_session.dart` is a thin wrapper over `speech_to_text` and `flutter_tts`
(`SpeechListenOptions` for locale, mode and timeouts on 7.x).

`VoiceAction` is deliberately small: `none, search, choose, confirm, reject,
pay, cancel, repeat`. **`none` is never guessed at** — on this screen a wrong
guess spends money.

### The Khulna bug

Bangla was matched by containment. **খুলনা ends in না — "no".** A passenger
asking for a bus to Khulna was parsed as a *refusal*, and at the confirm stage a
refusal releases held seats. **সকাল** ("morning") contains **কাল**
("tomorrow"), which moved travel dates by a day.

Reading the code would not have found this. Running a probe that printed actual
parse output did. Matching is now on word boundaries, with a `prefix` mode only
where Bangla inflection requires it (time, date, provider — `বিকাশে`):

```dart
bool _any(String t, List<String> words, {bool prefix = false}) {
  for (final w in words) {
    final tail = prefix ? '' : r'(?=$|\s)';
    if (RegExp('(?:^|\\s)${RegExp.escape(w)}$tail').hasMatch(t)) return true;
  }
  return false;
}
```

Both cases are permanent tests. Related fixes from the same probe: `"I want **to**
go from Dhaka to Sylhet"` split on the wrong `to` (a `from`-anchored pattern now
runs first, with `allMatches` to skip empty sides); Bangla digits U+09E6–U+09EF
are normalised to Latin; number words are filler, so `"chittagong duita"` no
longer leaves `duita` glued to the place name.

### Guardrails

Built regardless of the flow being permitted:

- **Read-back and an explicit spoken yes** before any seat is held and before
  any payment is approved. The gate tests `action == VoiceAction.confirm` —
  silence, noise or anything unclear is a no. It is not `!= reject`; that
  variant was tried and correctly turned a test red.
- **Voice never speaks, requests or accepts a PIN or an OTP.**
- **A ceiling**: `kVoicePayCeilingPoisha = 500000` (৳5,000). Above it voice
  hands over to the tap flow.
- **Sandbox-gated approval**: `if (!redirect.startsWith('/payment/sandbox'))`
  voice opens the sheet and stops, saying so on screen.
- **Voice never collects a name or a phone number.** When the booking needs
  them, the flow reaches `VoiceStage.needsDetails` and hands back to the form.

### Everything spoken is also on screen

`screens/voice.dart` draws the whole exchange as text, with a tappable twin for
every spoken answer and a "type instead" box that feeds the identical parser. A
passenger has to be able to see that they were misheard. It is also what makes
the flow demonstrable on a device with no usable microphone.

**A bug the device found in this work:** the sheet opens on the root navigator
(correct — a modal should cover the bar), which made `Navigator.of(context)`
inside it the root one, so finishing a spoken booking pushed the payment screen
*above the shell* — reintroducing the exact bug §3 set out to fix. The sheet now
takes an `intoTab` callback and pushes into the tab that is on screen.

---

## Verification

Everything below was run, not assumed.

| Suite | Result |
|---|---|
| `flutter test` (3 packages) | **109 hermetic tests** — 53 passenger (incl. 10 voice-flow), 26 crew, 30 voice grammar |
| `flutter analyze` | clean, all three packages |
| `go build ./...`, `go vet ./services/...` | clean |
| `node scripts/smoke.mjs` | ALL CHECKS PASSED — new §14b (saved-passenger CRUD + ownership + `has_password`) and §14c (password login) |
| `channels-smoke.mjs` | ALL CHANNEL CHECKS PASSED |
| `platform-smoke.mjs` | ALL PLATFORM CHECKS PASSED |
| `browser-flow.mjs` | PASSED, 41 checks (incl. the measured seat-luminance gap) |
| `staff-flow.mjs` | ALL SIX STAFF APPS PASSED, 86 checks |
| `lang-audit.mjs` | NO ENGLISH PROSE in the frontline three |
| `place-picker.mjs` | PASSED, 18 checks |

Every safety-critical test was confirmed **by breaking the thing it guards and
watching it go red**: the canonical-name rule, the lead-passenger rule, and the
voice consent gate.

Two of the new tests were wrong on the first pass and the suite caught it — one
assumed an English default when the product defaults to `bn`, and one asserted
against a pre-filled field when the interesting case is an empty one.

### On the emulator

Bottom bar present on results, seats, passengers, payment and ticket · mic
permission requested on tap, not at launch · the full spoken booking above ·
"Hello, Rahim" on the home screen afterwards · one-tap OTP · "Set a password"
offered, then "Change password" once set · sessions listed · saved travellers
added and picked at checkout · the voice-booked trip under "Coming up".

---

## Stated plainly

- **The microphone itself is untested.** The emulator has none. The grammar, the
  read-backs, the confirmations and every action voice triggers are verified
  through the same `handle()` the mic path calls; audio capture is not, and
  whether a given handset carries a `bn-BD` recogniser can only be checked on
  real hardware.
- **Spoken payment completes against the sandbox only.** A real bKash or Nagad
  PIN is entered inside their app and is not delegable by design.
- `channels-smoke.mjs` **failed once** early in this work and passed on three
  consecutive reruns afterwards. It was not reproduced and is not explained.
- Never run on a physical phone: no real-camera QR scan, no real GPS.
- iOS is scaffolded — usage strings for microphone and speech recognition are in
  `Info.plist` — but has never been built; that needs a Mac.
- APKs are debug-signed. There is no server-sent push (FCM).
- The repository contains seeded local fixtures — the demo staff password in
  `db/migrations/008_channels_seed.sql`, `sk_*_demo` / `whsec_*_demo` sandbox
  keys, and a localhost Postgres URL. None are real credentials, but they are
  public on GitHub and should be rotated before anything resembling production.

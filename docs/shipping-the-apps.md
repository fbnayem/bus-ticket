# Shipping the apps

What is done, what a machine other than this one has to do, and how to tell the
difference. Everything below has been carried as far as a Windows laptop with no
Apple toolchain and no phone plugged into it can carry it, and the parts that
stop there say so rather than being quietly skipped.

---

## Android — release signing

**Done and verified.** Both apps sign with a real upload key when one is
present, and fall back to the debug key with a warning in the build log when it
is not.

```
crew, with android/key.properties present:
  Signer #1 certificate DN: CN=Jatra Demo Upload, O=Jatra, C=BD

passenger, with none:
  WARNING: no android/key.properties - this release build is signed with the
           DEBUG key and cannot be published
  Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
```

Set up your own key with `apps/mobile/<app>/android/keystore.md`. Two things
that cost an hour each if nobody says them:

- **`java.util.Properties` must be imported** in a Kotlin DSL build script.
  Gradle's own `java` extension shadows the package name, so the unqualified
  reference fails to resolve with a message that does not mention either.
- **A modern keystore is PKCS12, and its key password must equal its store
  password.** `keytool -keypass` accepts a different one and the build then
  fails at packaging with `Given final block not properly padded`, which reads
  like a corrupt file rather than a mismatched password.

Verify what actually signed a build rather than trusting the log:

```bash
apksigner verify --print-certs build/app/outputs/flutter-apk/app-release.apk
```

`.gitignore` covers `key.properties`, `*.jks`, `*.keystore`, `*.p12` and
`*.mobileprovision`. This is the one mistake here that a later commit cannot
undo — a signing key in history is a signing key everybody who has cloned the
repository can publish updates with, and it cannot be rotated without orphaning
every phone that already has the app.

---

## Android — on a real phone

**Not done, and it cannot be done here.** No handset has ever been attached to
this machine; `adb devices` has only ever listed an emulator.

Both release APKs build and are installable now:

```bash
cd apps/mobile/crew && flutter build apk --release --dart-define=APP_VERSION=1.0.0
adb install -r build/app/outputs/flutter-apk/app-release.apk
```

What a phone is needed for, and what an emulator cannot stand in for:

- **The camera at the door.** The scanner's own logic is proved (see below), but
  autofocus on a creased ticket under a bus's interior light is a physical
  question.
- **GPS.** The emulator feeds a fixed coordinate; a real one drifts, loses fix
  in a tunnel and recovers.
- **A dark doorway.** `screen_brightness` raises the screen so a scanner can
  read a passenger's ticket. An emulator has no brightness.
- **Battery over a nine-hour run to Chattogram**, which is the only test of the
  GPS ping interval that means anything.

---

## The QR scanner

**The logic is proved; the lens is not.**

Driving it found that the scanner had shipped and had never opened a door. A
ticket's QR encodes a signed token — `k1.` and then base64url — not a booking
reference. The app read the token, upper-cased it along with everything else and
sent it in the `pnr` field; base64url is case-sensitive, so every scan of a real
ticket came back NOT_FOUND. It survived because the manual-entry fallback works
and because the smoke suite only ever scanned by PNR.

Now proved end to end against a real ticket and a real database:

```
PASS  the manifest carries the code printed on the ticket - k1.7-h9jruW8…
PASS  scanning the QR on a ticket boards that passenger   - BOARDED, seat B3
PASS  an upper-cased QR token is not a QR token           - NOT_FOUND
```

and in the app, four tests covering what leaves the phone and what an offline
phone matches against — including that a QR not on the downloaded manifest is
refused rather than guessed.

What remains unverified is the optics: whether `mobile_scanner` focuses on a
phone screen held at arm's length in the dark. The emulator has no camera, and
Android's virtual-scene camera renders a poster in a synthetic room rather than
a passenger's phone.

---

## iOS

**Configured, never built.** Building iOS needs macOS and Xcode; this is
Windows. What has been done here is everything that can be:

- The crew app had **no iOS project at all**. It has one now
  (`flutter create --platforms=ios --org bd.jatra`), bundle id
  `bd.jatra.jatraCrew`, display name *Jatra Crew*.
- **Camera and location usage strings** added to the crew `Info.plist`. This is
  not paperwork: iOS terminates a process that touches the camera with no
  `NSCameraUsageDescription`, so without it the scanner would not fail — the app
  would vanish, on the first tap, at a bus door. The passenger app already
  declared the three it needs (Face ID, microphone, speech recognition).

On a Mac, from here:

```bash
cd apps/mobile/crew && flutter build ios --release
```

Then a paid Apple Developer account, a distribution certificate and a
provisioning profile, which are per-organisation and cannot be prepared from
here. `*.mobileprovision` and `*.p12` are gitignored for the same reason the
Android keystore is.

---

## Push notifications

**Addressed, not delivered.**

The notification service has had a PUSH channel since its first migration —
providers, preferences, templates, a delivery log — and never had an address.
`Audience.PushToken` was a field nothing ever set, so every push was skipped for
want of a recipient. The comment in the resolver said why: there was no app.

There are two apps now, so there is a device registry
(`notify.devices`, migration 024), a registration endpoint, and both apps
registering on sign-in and revoking on sign-out. A booking confirmation now
carries a push address and the channel reports a delivery:

```
booking.confirmed  +8801700000000  local:DEV-SMOKE1
                   SMS:SSLWIRELESS:SENT, EMAIL:SES_RELAY:SENT, PUSH:FCM:SENT
```

**What is real:** the registry, the ownership rules, the resolver, the
addressing, and the fact that a signed-out phone stops receiving. The token is
the unique key rather than the person, so a handset that changes hands moves
with its token instead of delivering the previous owner's tickets to whoever has
it now.

**What is not:** the token itself, and the delivery. A real token comes from
Firebase Cloud Messaging or APNs, both of which need a project and credentials
this repository does not hold, so `DeviceRegistration.token()` falls back to the
handset's own stable reference. And `PUSH:FCM:SENT` means the same thing as
`SMS:SSLWIRELESS:SENT` does everywhere else in this build: it reached the
simulated provider sink, not a phone. SMS and email are simulated in exactly the
same way, and always have been.

Wiring FCM later changes one line — where the token comes from — and nothing
else: not the endpoint, not the registry, not the resolver, not either app's
sign-in. That is why it was built in this order.

---

## Errors and crashes

**Done.**

- **A panic in any API handler used to be able to end the process.** It now logs
  the route and the stack against the request id and answers 500 quoting it, so
  the caller has a reference and the log has the stack — unless the response has
  already begun, in which case a second `WriteHeader` would only stamp a warning
  over the real failure.
- **A Flutter exception used to produce a red screen on one phone and nothing
  anywhere else.** A conductor force-quit and carried on selling on paper. Now
  the person gets a sentence in their own language and the office gets the
  stack, the screen, the app version and a count, in `ops.client_errors`.

Two decisions worth keeping:

- The report endpoint is **unauthenticated**. The crash a passenger hits on the
  sign-in screen is the one nobody could report through an authenticated
  endpoint, and it is usually the worst one. Every field is length-bounded and
  the same fault is reported once per run, because a widget that throws on every
  frame would otherwise be a denial of service we wrote ourselves.
- The fingerprint is built from the exception type and the top frames, **never
  the message**. Messages carry seat numbers and PNRs: grouping on them would
  file the same bug once per passenger and put passenger data in the key.

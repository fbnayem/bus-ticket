# Signing a release build

Both apps are configured to sign with a real upload key when one is present and
to fall back to the debug key — loudly — when it is not. Nothing here is
committed: a signing key in version control is a signing key that everybody who
has ever cloned the repository can publish updates with, and it cannot be
revoked without orphaning every phone that already has the app.

## Once, per app

```bash
keytool -genkeypair -v \
  -keystore ~/jatra-crew-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

`-validity 10000` is about 27 years. Google Play refuses an upload key that
expires before 2033, and re-keying after publication is a support process rather
than a command.

Then write `android/key.properties` **next to `android/app/`, not inside it**:

```properties
storePassword=…
keyPassword=…
keyAlias=upload
storeFile=/absolute/path/to/jatra-crew-upload.jks
```

`.gitignore` already covers `key.properties` and `*.jks`. Check with
`git status` before committing — that is the one mistake here that cannot be
undone by a later commit.

## Then

```bash
flutter build apk   --release          # installable directly on a phone
flutter build appbundle --release      # what Play actually wants
```

Confirm what actually signed it, rather than trusting the build log:

```bash
# Android SDK build-tools
apksigner verify --print-certs build/app/outputs/flutter-apk/app-release.apk
```

A certificate reading `CN=Android Debug, O=Android, C=US` is the debug key. That
APK installs and runs and can never be published, and the build says so in the
log when it happens.

## Keeping the key

Losing the upload key means losing the ability to update the app for every
existing installation. Enrol in Play App Signing so Google holds the *app*
signing key and this one becomes a replaceable upload key — that turns a
catastrophe into a support ticket.

Back it up somewhere that is not this laptop and not this repository.

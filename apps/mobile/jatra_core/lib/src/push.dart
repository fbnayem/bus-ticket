import 'api/client.dart';
import 'store.dart';

/// Telling the platform where to reach this phone.
///
/// ## What this is, and what it is not
///
/// The platform's notification service has always had a PUSH channel — its own
/// providers, preferences, templates and delivery log — and never had an
/// address to send to, because there was no app when it was written. This is
/// the address: a token registered on sign-in and revoked on sign-out, so a
/// notification can be *directed at a phone* instead of skipped for want of a
/// recipient.
///
/// What it is not is a live delivery integration. A real token comes from
/// Firebase Cloud Messaging or APNs, and both need a project, credentials and a
/// signing identity this repository deliberately does not hold. Until one
/// exists, [DeviceRegistration.token] falls back to the handset's own stable
/// reference, which is a real, unique, per-installation string — enough to
/// prove the addressing end to end, and honestly useless for waking a phone up.
///
/// Adding FCM later changes exactly one line — where the token comes from — and
/// nothing else in the platform: not this class's callers, not the endpoint,
/// not the registry, not the resolver that reads it. That is the point of doing
/// it in this order.
class DeviceRegistration {
  DeviceRegistration({required this.api, required this.store, required this.app});

  final ApiClient api;
  final Store store;

  /// `passenger` or `crew`. The server refuses anything else: a crew
  /// notification delivered to a passenger's phone is worse than none.
  final String app;

  /// Where this phone can be reached.
  ///
  /// Override once a real messaging SDK is wired in. Deliberately a method
  /// rather than a constructor argument so the fallback is visible at the point
  /// it is used rather than buried at a call site.
  Future<String> token() async => 'local:${store.deviceRef}';

  /// Called after a successful sign-in. Never throws: failing to register for
  /// notifications must not stop somebody using the app they just signed into.
  Future<bool> register({String platform = ''}) async {
    try {
      await api.post('/devices', body: {
        'token': await token(),
        'app': app,
        'platform': platform,
        'device_ref': store.deviceRef,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Called on sign-out, before the session is cleared.
  ///
  /// A phone that cannot say "stop" keeps receiving the tickets of whoever signs
  /// in next, which is the one failure this whole registry must not have.
  Future<void> revoke() async {
    try {
      await api.post('/devices/revoke', body: {'token': await token()});
    } catch (_) {
      // Nothing to be done and nothing worth telling anybody. The token stops
      // being re-registered from here, and the server retires one it has not
      // seen in months.
    }
  }
}

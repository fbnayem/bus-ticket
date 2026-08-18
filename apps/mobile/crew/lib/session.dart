import 'dart:async';
import 'dart:io' show Platform;
import 'package:flutter/widgets.dart';
import 'package:jatra_core/jatra_core.dart';

/// The signed-in crew member, and the two objects everything else needs.
///
/// What this class does NOT do is decide anything. `identity.can(...)` hides
/// a button the server would refuse; it does not grant anything. Every request
/// is checked again at the other end, on a permission this app never sees the
/// rules for.
class Session extends ChangeNotifier {
  Session({required this.api, required this.store}) {
    api.c.onUnauthenticated = () {
      _identity = null;
      store.clearSession();
      notifyListeners();
    };
    api.c.bearer = store.token;
  }

  final CrewApi api;
  final Store store;

  StaffIdentity? _identity;
  StaffIdentity? get identity => _identity;
  bool get signedIn => _identity != null;

  /// True once the app has finished asking who, if anyone, is signed in.
  bool ready = false;

  /// Picks up an existing session on launch so a driver who opened the app
  /// yesterday is not asked for a password at 5am at the terminal.
  Future<void> restore() async {
    final token = store.token;
    if (token == null || token.isEmpty) {
      ready = true;
      notifyListeners();
      return;
    }
    api.c.bearer = token;
    try {
      final me = await api.me();
      _identity = StaffIdentity.fromJson(me['identity'] as Map<String, dynamic>);
    } on ApiError catch (e) {
      // A dead session signs them out; no line at all does not. A driver in a
      // basement terminal keeps the app they had a minute ago.
      if (!e.offline) {
        _identity = null;
        await store.clearSession();
      }
    }
    ready = true;
    notifyListeners();
  }

  /// Where the platform can reach this phone. Registered on sign-in, revoked on
  /// sign-out; see [DeviceRegistration] for what is and is not real about it.
  late final DeviceRegistration devices =
      DeviceRegistration(api: api.c, store: store, app: 'crew');

  Future<void> signIn(String email, String password, {String? totp}) async {
    final r = await api.signIn(email, password, totp: totp);
    api.c.bearer = r['token'] as String?;
    await store.saveSession(token: r['token'] as String?);
    _identity = StaffIdentity.fromJson(r['identity'] as Map<String, dynamic>);
    notifyListeners();
    // After the identity is set, so a failure here cannot cost somebody the
    // sign-in they just completed. It reports nothing to the screen for the
    // same reason.
    unawaited(devices.register(platform: _platformName()));
  }

  Future<void> signOut() async {
    // Before the token is cleared: revoking needs a session, and a phone that
    // cannot say "stop" keeps receiving the tickets of whoever signs in next.
    await devices.revoke();
    await api.signOut();
    api.c.bearer = null;
    _identity = null;
    await store.clearSession();
    notifyListeners();
  }

  String _platformName() {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return '';
  }
}

/// Hands the session down the tree without pulling in a state-management
/// package for one object.
class SessionScope extends InheritedNotifier<Session> {
  const SessionScope({super.key, required Session session, required super.child})
      : super(notifier: session);

  /// Reads the session **and subscribes** to it. For `build`.
  static Session of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<SessionScope>();
    assert(s != null, 'No SessionScope above this widget');
    return s!.notifier!;
  }

  /// Reads the session **without** subscribing. For `initState` and for
  /// callbacks that only want to call a method.
  ///
  /// `dependOnInheritedWidgetOfExactType` asserts when called before
  /// `initState` has finished, so a screen that starts its first load there —
  /// which is most of them — throws on the first frame in a debug build.
  static Session read(BuildContext context) {
    final s = context.getInheritedWidgetOfExactType<SessionScope>();
    assert(s != null, 'No SessionScope above this widget');
    return s!.notifier!;
  }
}

import 'package:flutter/widgets.dart';
import 'package:jatra_core/jatra_core.dart';

import 'owner_api.dart';

/// The signed-in owner, and the two objects everything else needs.
///
/// Like the crew session, this class decides nothing. `identity.can(...)` hides
/// a screen the server would refuse anyway; every request is checked again at
/// the other end on a permission this app never sees the rules for.
///
/// It does not register a device for push, and that is deliberate: the owner
/// app receives no notifications yet, so it claims no address it would never be
/// sent to. Adding push to the owner later is a device registration on sign-in
/// and one value in the registry's allow-list, and nothing here.
class Session extends ChangeNotifier {
  Session({required this.api, required this.store}) {
    api.c.onUnauthenticated = () {
      _identity = null;
      store.clearSession();
      notifyListeners();
    };
    api.c.bearer = store.token;
  }

  final OwnerApi api;
  final Store store;

  StaffIdentity? _identity;
  StaffIdentity? get identity => _identity;
  bool get signedIn => _identity != null;

  /// True once the app has finished asking who, if anyone, is signed in.
  bool ready = false;

  /// Picks up an existing session on launch, so an owner who checked the takings
  /// last night is not asked for a password to check them this morning.
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
      // A dead session signs them out; no connection at all does not.
      if (!e.offline) {
        _identity = null;
        await store.clearSession();
      }
    }
    ready = true;
    notifyListeners();
  }

  Future<void> signIn(String email, String password, {String? totp}) async {
    final r = await api.signIn(email, password, totp: totp);
    api.c.bearer = r['token'] as String?;
    await store.saveSession(token: r['token'] as String?);
    _identity = StaffIdentity.fromJson(r['identity'] as Map<String, dynamic>);
    notifyListeners();
  }

  Future<void> signOut() async {
    await api.signOut();
    api.c.bearer = null;
    _identity = null;
    await store.clearSession();
    notifyListeners();
  }
}

/// Hands the session down the tree without a state-management package.
class SessionScope extends InheritedNotifier<Session> {
  const SessionScope({super.key, required Session session, required super.child})
      : super(notifier: session);

  /// Reads the session **and subscribes**. For `build`.
  static Session of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<SessionScope>();
    assert(s != null, 'No SessionScope above this widget');
    return s!.notifier!;
  }

  /// Reads the session **without** subscribing. For `initState` and callbacks.
  static Session read(BuildContext context) {
    final s = context.getInheritedWidgetOfExactType<SessionScope>();
    assert(s != null, 'No SessionScope above this widget');
    return s!.notifier!;
  }
}

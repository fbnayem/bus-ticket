import 'package:flutter/widgets.dart';
import 'package:jatra_core/jatra_core.dart';

import 'reminders.dart';

/// Who is holding the phone, and what they have bought.
///
/// The account is deliberately optional. Guest checkout is the default path on
/// this platform, and it stays the default here: a passenger can search, hold,
/// pay and hold a ticket without ever signing in. Signing in only gathers the
/// tickets bought on one number into one place.
class AppState extends ChangeNotifier {
  AppState({required this.api, required this.store, required this.reminders}) {
    api.c.onUnauthenticated = () {
      _signedIn = false;
      store.clearSession();
      notifyListeners();
    };
    final t = store.token;
    if (t != null && t.isNotEmpty) {
      api.c.bearer = t;
      _signedIn = true;
    }
  }

  final PassengerApi api;
  final Store store;
  final Reminders reminders;

  bool _signedIn = false;
  bool get signedIn => _signedIn;

  String? get phone => store.phone;
  String? get displayName => store.displayName;

  /// Tickets this phone can show with no signal at all.
  ///
  /// This list is read from the device first and refreshed from the platform
  /// second, never the other way round. A passenger standing at a bus door in a
  /// place with no bars must not see a spinner where their ticket should be.
  List<Booking> get tickets => store.cachedTickets();

  Future<void> keep(Booking b) async {
    await store.cacheTicket(b);
    if (store.remindersOn && b.confirmed) {
      await reminders.scheduleFor(b);
    }
    notifyListeners();
  }

  Future<void> forget(String pnr) async {
    await store.forgetTicket(pnr);
    await reminders.cancelFor(pnr);
    notifyListeners();
  }

  /// Refreshes every cached ticket from the platform.
  ///
  /// Called on launch and on pull-to-refresh. A ticket cancelled from the
  /// website, or one the crew has marked boarded, has to reach this phone; a
  /// stale ticket in a pocket is how somebody argues with a helper at a door.
  Future<void> refreshTickets() async {
    for (final cached in store.cachedTickets()) {
      try {
        final fresh = await api.booking(cached.pnr);
        await store.cacheTicket(fresh);
      } on ApiError catch (e) {
        if (e.offline) break; // nothing to refresh from; keep what we have
        // A 404 means the platform no longer knows this booking. Anything else
        // is left alone rather than guessed at.
        if (e.status == 404) await store.forgetTicket(cached.pnr);
      }
    }
    notifyListeners();
  }

  Future<void> signedInAs({required String token, String? refresh, required String phone, String? name}) async {
    api.c.bearer = token;
    await store.saveSession(token: token, refresh: refresh, phone: phone, name: name);
    _signedIn = true;
    notifyListeners();
    // Pull in anything bought on this number from another device, so signing in
    // actually delivers what it promises.
    await pullAccountTickets();
  }

  Future<void> signOut() async {
    await api.logout();
    api.c.bearer = null;
    await store.clearSession();
    _signedIn = false;
    notifyListeners();
  }

  Future<void> pullAccountTickets() async {
    if (!_signedIn) return;
    try {
      final r = await api.accountBookings();
      final rows = [
        ...(r['upcoming'] as List? ?? const []),
        ...(r['past'] as List? ?? const []),
      ].map((e) => AccountBooking.fromJson(e as Map<String, dynamic>));
      for (final row in rows) {
        if (store.cachedTicket(row.pnr) != null) continue;
        try {
          await keep(await api.booking(row.pnr));
        } on ApiError {
          // One unreadable booking must not cost the passenger the rest.
        }
      }
    } on ApiError {
      // Offline, or the account endpoint refused. Either way the tickets
      // already on the device are untouched.
    }
    notifyListeners();
  }

  Future<void> saveRoute(String from, String to) async {
    await store.saveRoute(from, to);
    notifyListeners();
  }

  Future<void> forgetRoute(String from, String to) async {
    await store.forgetRoute(from, to);
    notifyListeners();
  }
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child})
      : super(notifier: state);

  /// Reads the state **and subscribes** to it. For `build`.
  static AppState of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(s != null, 'No AppScope above this widget');
    return s!.notifier!;
  }

  /// Reads the state **without** subscribing. For `initState` and for
  /// callbacks that only want to call a method.
  ///
  /// The distinction is not stylistic. `dependOnInheritedWidgetOfExactType`
  /// asserts when it is called before `initState` has finished, so every screen
  /// that kicked off its first load from `initState` — which is most of them —
  /// would have thrown on the first frame in a debug build. Release builds
  /// disable that assert, so it would have "worked" right up until somebody ran
  /// it from an IDE.
  static AppState read(BuildContext context) {
    final s = context.getInheritedWidgetOfExactType<AppScope>();
    assert(s != null, 'No AppScope above this widget');
    return s!.notifier!;
  }
}

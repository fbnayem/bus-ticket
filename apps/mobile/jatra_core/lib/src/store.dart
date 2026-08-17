import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import 'i18n.dart';
import 'models.dart';

/// Everything the apps keep on the device.
///
/// The line this file draws: the device holds *copies* and *intentions*. It
/// never holds a fact the platform does not already have or is not about to be
/// told. A cached ticket is a copy of one the server issued. A queued boarding
/// check is an intention carrying the identity the server will deduplicate on.
/// Nothing here is authoritative, and nothing here is money.
class Store {
  Store(this._p);
  final SharedPreferences _p;

  static Future<Store> open() async => Store(await SharedPreferences.getInstance());

  /* -------------------------------------------------------------- language */

  static const _kLang = 'jatra.lang';

  Lang get lang => _p.getString(_kLang) == 'en' ? Lang.en : Lang.bn;
  Future<void> setLang(Lang l) => _p.setString(_kLang, l.code);

  /* --------------------------------------------------------------- session */

  static const _kToken = 'jatra.token';
  static const _kRefresh = 'jatra.refresh';
  static const _kPhone = 'jatra.phone';
  static const _kName = 'jatra.name';

  String? get token => _p.getString(_kToken);
  String? get refreshToken => _p.getString(_kRefresh);
  String? get phone => _p.getString(_kPhone);
  String? get displayName => _p.getString(_kName);

  Future<void> saveSession({String? token, String? refresh, String? phone, String? name}) async {
    if (token != null) await _p.setString(_kToken, token);
    if (refresh != null) await _p.setString(_kRefresh, refresh);
    if (phone != null) await _p.setString(_kPhone, phone);
    if (name != null) await _p.setString(_kName, name);
  }

  Future<void> clearSession() async {
    await _p.remove(_kToken);
    await _p.remove(_kRefresh);
    await _p.remove(_kName);
    // The phone number is deliberately kept. Signing out is not forgetting who
    // you are, and re-typing an 11-digit number to receive a code is the step
    // people abandon.
  }

  /* -------------------------------------------------- the device's own name */

  static const _kDevice = 'jatra.device';

  /// A stable id for this handset, minted once.
  ///
  /// It is what makes a boarding check traceable to the phone that took it, and
  /// it is part of the client reference the server deduplicates on. It is not
  /// an identity and carries nothing about the person holding the phone.
  String get deviceRef {
    final existing = _p.getString(_kDevice);
    if (existing != null) return existing;
    final r = Random.secure();
    final id = 'DEV-${List.generate(5, (_) => r.nextInt(36).toRadixString(36)).join().toUpperCase()}';
    _p.setString(_kDevice, id);
    return id;
  }

  /* ------------------------------------------------------- tickets on hand */

  static const _kTickets = 'jatra.tickets';

  /// Every ticket this phone has been shown, kept whole.
  ///
  /// This is what makes the promise on the home screen true: the ticket and its
  /// QR open at the door of a bus in a place with no bars. The QR token is a
  /// signed opaque string issued by the platform — it carries no personal
  /// details, and storing it is storing exactly what a printed ticket would
  /// have carried anyway.
  List<Booking> cachedTickets() {
    final raw = _p.getStringList(_kTickets) ?? const [];
    final out = <Booking>[];
    for (final s in raw) {
      try {
        out.add(Booking.fromJson(jsonDecode(s) as Map<String, dynamic>));
      } catch (_) {
        // One unreadable entry must not cost the passenger the rest of their
        // tickets, so a bad row is skipped rather than thrown.
      }
    }
    out.sort((a, b) => a.departAt.compareTo(b.departAt));
    return out;
  }

  Future<void> cacheTicket(Booking b) async {
    final all = _p.getStringList(_kTickets) ?? <String>[];
    final kept = all.where((s) {
      try {
        return (jsonDecode(s) as Map<String, dynamic>)['pnr'] != b.pnr;
      } catch (_) {
        return false;
      }
    }).toList();
    kept.add(jsonEncode(b.raw));
    await _p.setStringList(_kTickets, kept);
  }

  Future<void> forgetTicket(String pnr) async {
    final all = _p.getStringList(_kTickets) ?? const [];
    await _p.setStringList(
      _kTickets,
      all.where((s) {
        try {
          return (jsonDecode(s) as Map<String, dynamic>)['pnr'] != pnr;
        } catch (_) {
          return false;
        }
      }).toList(),
    );
  }

  Booking? cachedTicket(String pnr) {
    for (final b in cachedTickets()) {
      if (b.pnr == pnr) return b;
    }
    return null;
  }

  /* ------------------------------------------------------- journeys kept */

  static const _kRoutes = 'jatra.routes';

  /// Separator for a saved journey.
  ///
  /// A unit separator rather than a comma or a pipe, because place names come
  /// from the platform's gazetteer and one of them will eventually contain
  /// whatever printable character seemed safe. It is spelled out here rather
  /// than written inline as a literal control character, which is invisible in
  /// a diff and reads like a bug to whoever finds it next.
  static const _sep = '\u0001';

  List<({String from, String to})> savedRoutes() {
    final raw = _p.getStringList(_kRoutes) ?? const [];
    return raw
        .map((s) => s.split(_sep))
        .where((p) => p.length == 2)
        .map((p) => (from: p[0], to: p[1]))
        .toList();
  }

  Future<void> saveRoute(String from, String to) async {
    final key = '$from$_sep$to';
    final all = _p.getStringList(_kRoutes) ?? <String>[];
    all.remove(key);
    all.insert(0, key);
    await _p.setStringList(_kRoutes, all.take(6).toList());
  }

  Future<void> forgetRoute(String from, String to) async {
    final all = _p.getStringList(_kRoutes) ?? <String>[];
    all.remove('$from$_sep$to');
    await _p.setStringList(_kRoutes, all);
  }

  /* ------------------------------------------------------- recent places */

  static const _kPlaces = 'jatra.places.recent';

  /// The places this passenger has actually chosen, most recent first.
  ///
  /// This is what the picker can offer with no signal at all. Somebody on a
  /// bus stand with one bar is usually going somewhere they have been before,
  /// and the alternative — an empty list and a spinner — is the picker failing
  /// at exactly the moment it is needed.
  ///
  /// Both names are kept so the list still reads correctly in either language
  /// offline; the canonical name is what gets sent to the platform.
  List<({String name, String nameBn})> recentPlaces() {
    final raw = _p.getStringList(_kPlaces) ?? const [];
    return raw
        .map((s) => s.split(_sep))
        .where((p) => p.isNotEmpty && p[0].isNotEmpty)
        .map((p) => (name: p[0], nameBn: p.length > 1 ? p[1] : ''))
        .toList();
  }

  Future<void> rememberPlace(String name, String nameBn) async {
    if (name.isEmpty) return;
    final all = _p.getStringList(_kPlaces) ?? <String>[];
    all.removeWhere((s) => s.split(_sep).first == name);
    all.insert(0, '$name$_sep$nameBn');
    await _p.setStringList(_kPlaces, all.take(8).toList());
  }

  /* --------------------------------------------------------- preferences */

  static const _kBiometric = 'jatra.biometric';
  static const _kReminders = 'jatra.reminders';

  bool get biometricOn => _p.getBool(_kBiometric) ?? false;
  Future<void> setBiometric(bool v) => _p.setBool(_kBiometric, v);

  bool get remindersOn => _p.getBool(_kReminders) ?? true;
  Future<void> setReminders(bool v) => _p.setBool(_kReminders, v);

  /* ------------------------------------------------- crew: the two caches */

  static const _kManifest = 'jatra.manifest.';
  static const _kQueue = 'jatra.scan.queue';

  /// The list downloaded before departure. Offline checks are made against it.
  Future<void> cacheManifest(String tripId, Map<String, dynamic> raw) =>
      _p.setString('$_kManifest$tripId', jsonEncode(raw));

  Manifest? cachedManifest(String tripId) {
    final s = _p.getString('$_kManifest$tripId');
    if (s == null) return null;
    try {
      return Manifest.fromJson(jsonDecode(s) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  /// Boarding checks taken with no line, waiting to be sent.
  ///
  /// Each entry already carries the `client_ref` minted before the first
  /// attempt, so flushing this queue twice — or flushing it from a second
  /// device that somehow has the same entry — marks one passenger aboard once.
  List<Map<String, dynamic>> queuedScans() {
    final raw = _p.getStringList(_kQueue) ?? const [];
    final out = <Map<String, dynamic>>[];
    for (final s in raw) {
      try {
        out.add(jsonDecode(s) as Map<String, dynamic>);
      } catch (_) {/* skip a corrupt entry rather than lose the queue */}
    }
    return out;
  }

  Future<void> queueScan(Map<String, dynamic> body) async {
    final all = _p.getStringList(_kQueue) ?? <String>[];
    all.add(jsonEncode(body));
    await _p.setStringList(_kQueue, all);
  }

  Future<void> dropQueuedScans(Set<String> clientRefs) async {
    final kept = queuedScans()
        .where((s) => !clientRefs.contains(s['client_ref']))
        .map(jsonEncode)
        .toList();
    await _p.setStringList(_kQueue, kept);
  }
}

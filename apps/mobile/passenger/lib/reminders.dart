import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// "Your bus leaves in two hours."
///
/// Scheduled on the device, not pushed from a server. The phone already knows
/// when the bus leaves — it is written on the ticket in its pocket — so a
/// reminder needs no push credentials, no Firebase project, and no delivery
/// that can fail silently in a place with no signal. It also means the reminder
/// still arrives for a passenger who bought as a guest and never signed in.
///
/// The seam for server-sent push (a trip cancelled at short notice, a bus
/// running late) is deliberately left open: that is news only the platform can
/// know, and it needs FCM credentials this build does not have.
class Reminders {
  Reminders(this._plugin, this._store);

  final FlutterLocalNotificationsPlugin _plugin;
  final Store _store;

  static const _channel = AndroidNotificationChannel(
    'jatra.departures',
    'Departure reminders',
    description: 'Two hours and one hour before a bus you have a ticket for leaves.',
    importance: Importance.high,
  );

  static Future<Reminders> start(Store store) async {
    tzdata.initializeTimeZones();
    // Bangladesh has kept no daylight saving since the 2009 experiment, so the
    // zone is fixed and a reminder scheduled a month out is still correct.
    tz.setLocalLocation(tz.getLocation('Asia/Dhaka'));

    final plugin = FlutterLocalNotificationsPlugin();
    await plugin.initialize(const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    ));
    await plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_channel);
    return Reminders(plugin, store);
  }

  /// Asked for the first time a passenger actually has a ticket, not on first
  /// launch. A permission dialog before anyone has bought anything is a dialog
  /// people dismiss.
  Future<bool> askPermission() async {
    final android = _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (android != null) return await android.requestNotificationsPermission() ?? false;
    final ios = _plugin
        .resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>();
    if (ios != null) {
      return await ios.requestPermissions(alert: true, badge: true, sound: true) ?? false;
    }
    return false;
  }

  /// Two ids per booking, derived from the PNR so re-scheduling replaces rather
  /// than duplicates. A passenger who opens the app five times must not get
  /// five reminders.
  static int _id(String pnr, int slot) => (pnr.hashCode & 0x3FFFFFF) * 2 + slot;

  Future<void> scheduleFor(Booking b) async {
    final departs = b.departure;
    if (departs == null) return;
    await cancelFor(b.pnr);

    final l = L(_store.lang);
    final seats = b.seats.join(', ');
    final route = '${b.origin} → ${b.destination}';

    await _at(
      id: _id(b.pnr, 0),
      when: departs.subtract(const Duration(hours: 2)),
      title: l('nt.soonTitle'),
      body: l('nt.soonBody', {
        'route': route,
        'seats': seats,
        'time': timeOf(b.departAt, l.lang),
      }),
      payload: b.pnr,
    );
    await _at(
      id: _id(b.pnr, 1),
      when: departs.subtract(const Duration(hours: 1)),
      title: l('nt.nowTitle'),
      body: l('nt.nowBody', {'origin': b.origin, 'pnr': b.pnr}),
      payload: b.pnr,
    );
  }

  Future<void> _at({
    required int id,
    required DateTime when,
    required String title,
    required String body,
    required String payload,
  }) async {
    // A reminder for a bus that has already gone is noise. Silently skipping it
    // is correct: the passenger who books ninety minutes before departure gets
    // the one-hour reminder and not the two-hour one.
    if (when.isBefore(DateTime.now())) return;
    try {
      await _plugin.zonedSchedule(
        id,
        title,
        body,
        tz.TZDateTime.from(when, tz.local),
        NotificationDetails(
          android: AndroidNotificationDetails(
            _channel.id,
            _channel.name,
            channelDescription: _channel.description,
            importance: Importance.high,
            priority: Priority.high,
          ),
          iOS: const DarwinNotificationDetails(),
        ),
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
        // Absolute time, not wall-clock. A passenger who crosses into another
        // zone — or a phone that changes its own — should still be reminded two
        // hours before the bus leaves Dhaka, not two hours before some local
        // reading of the same clock face.
        uiLocalNotificationDateInterpretation:
            UILocalNotificationDateInterpretation.absoluteTime,
        payload: payload,
      );
    } catch (_) {
      // Reminders are a courtesy. A phone that refuses to schedule one must
      // never stop a passenger holding a ticket.
    }
  }

  Future<void> cancelFor(String pnr) async {
    for (var slot = 0; slot < 2; slot++) {
      try {
        await _plugin.cancel(_id(pnr, slot));
      } catch (_) {/* nothing scheduled, nothing to cancel */}
    }
  }

  Future<void> cancelAll() async {
    try {
      await _plugin.cancelAll();
    } catch (_) {}
  }
}

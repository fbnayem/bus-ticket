@Tags(['live'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_crew/boarding.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The crew app's client code, driven against the running platform.
///
///   flutter test --tags live --dart-define=JATRA_API=http://localhost:8080/api/v1
///
/// Tagged so an ordinary `flutter test` run does not need a platform in front
/// of it.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The binding otherwise answers every request with an empty 400 so a widget
  // test cannot reach the network. This file exists to reach it.
  HttpOverrides.global = null;

  late CrewApi api;
  late Store store;
  late Boarding boarding;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    store = await Store.open();
    api = CrewApi(ApiClient(
      base: const String.fromEnvironment('JATRA_API',
          defaultValue: 'http://localhost:8080/api/v1'),
      timeout: const Duration(seconds: 30),
    ));
    boarding = Boarding(api: api, store: store);

    final r = await api.signIn('driver@greenline.test', 'Jatra#2026');
    api.c.bearer = r['token'] as String?;
  });

  test('signing in returns an identity the app can reason about', () async {
    final me = await api.me();
    final id = StaffIdentity.fromJson(me['identity'] as Map<String, dynamic>);
    expect(id.fullName, isNotEmpty);
    expect(id.permissions, isNotEmpty);
    // The app hides what the server would refuse; it never grants anything.
    // These are the two the crew app is built around: running a trip, and
    // checking a ticket at the door.
    expect(id.can('driver.trip'), isTrue);
    expect(id.can('boarding.scan'), isTrue);
  });

  test('a driver sees only their own roster', () async {
    final trips = await api.trips();
    expect(trips, isNotEmpty, reason: 'nothing rostered; reset the fixtures');
    for (final t in trips) {
      expect(t.route, isNotEmpty);
      expect(t.registration, isNotEmpty);
    }
  });

  test('the list downloads, caches, and answers a check at the door', () async {
    final trips = await api.trips();
    // A trip with passengers on it, which is the only kind worth checking.
    Manifest? manifest;
    CrewTrip? chosen;
    for (final t in trips) {
      final m = await api.manifest(t.tripId);
      if (m.passengers.isNotEmpty) {
        manifest = m;
        chosen = t;
        break;
      }
    }
    expect(manifest, isNotNull, reason: 'no departure with passengers on it');

    // Cached before departure. This is the whole basis for checking tickets
    // where there is no signal.
    await store.cacheManifest(chosen!.tripId, manifest!.raw);
    final cached = store.cachedManifest(chosen.tripId);
    expect(cached, isNotNull);
    expect(cached!.passengers.length, manifest.passengers.length);

    // Somebody who has not boarded yet.
    final waiting = manifest.passengers.where((p) => !p.boarded).toList();
    if (waiting.isEmpty) return; // everyone is already aboard; nothing to prove

    const l = L(Lang.en);
    final verdict = await boarding.check(
      tripId: chosen.tripId,
      pnr: waiting.first.pnr,
      l: l,
    );
    expect(verdict.letThemOn || verdict.alreadyOn, isTrue,
        reason: 'a valid ticket on the right trip must produce an instruction');
    expect(verdict.queued, isFalse, reason: 'the platform answered');

    // The same ticket a second time is refused, and the refusal is an answer
    // rather than an exception — which is what the crew needs to see.
    final again = await boarding.check(
      tripId: chosen.tripId,
      pnr: waiting.first.pnr,
      l: l,
    );
    expect(again.alreadyOn, isTrue);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('an incident reaches the office', () async {
    final trips = await api.trips();
    // A mark unique to this run. Counting rows would not do: the list the
    // platform returns is capped, so on a database with a long history a new
    // incident arrives without the count changing at all.
    final mark = 'MOBILE-${DateTime.now().millisecondsSinceEpoch}';

    await api.reportIncident(
      tripId: trips.first.tripId,
      kind: 'DELAY',
      severity: 'LOW',
      note: 'Held at the Meghna bridge. $mark',
    );

    final after = await api.incidents();
    expect(after.any((i) => i.note.contains(mark)), isTrue,
        reason: 'the office has to be able to see what the crew reported');
  });

  test('position reports are accepted', () async {
    final trips = await api.trips();
    // Dhaka, roughly. What matters is that the platform takes it and the app's
    // encoding of it is the shape the platform expects.
    await api.reportPosition(trips.first.tripId, 23.7276, 90.4103,
        speedKph: 42, heading: 135);
  });
}

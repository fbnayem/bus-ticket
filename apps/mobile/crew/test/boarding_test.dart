import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_crew/boarding.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// These tests are about the one thing this app must never get wrong: a
/// passenger boarding twice, or a passenger being told they may board when
/// nothing has said so.

const _l = L(Lang.en);

Map<String, dynamic> _manifestRaw() => {
      'trip': {
        'route': 'Dhaka → Chattogram',
        'operator': 'Green Line',
        'registration': 'DHA-METRO-B-11-2288',
        'depart_at': '2026-08-18T22:00:00+06:00',
        'status': 'BOARDING',
      },
      'total': 2,
      'boarded': 1,
      'passengers': [
        {
          'seat_no': 'A1', 'pnr': 'K7W4VP', 'passenger': 'Rahim Uddin',
          'phone': '01711000000', 'channel': 'WEB', 'ticket_status': 'VALID',
          'from': 'Dhaka', 'to': 'Chattogram',
        },
        {
          'seat_no': 'A2', 'pnr': 'M2X8QT', 'passenger': 'Karima Begum',
          'phone': '01711000001', 'channel': 'COUNTER', 'ticket_status': 'BOARDED',
          'from': 'Cumilla', 'to': 'Chattogram',
        },
      ],
    };

/// A client with no line at all, as opposed to one that refuses.
MockClient _deadLine() => MockClient((_) async => throw const _NoRoute());

class _NoRoute implements Exception {
  const _NoRoute();
}

Future<(Boarding, Store, List<Map<String, dynamic>>)> _rig(MockClient client) async {
  SharedPreferences.setMockInitialValues({});
  final store = await Store.open();
  final api = CrewApi(ApiClient(base: 'http://test/api/v1', httpClient: client));
  return (Boarding(api: api, store: store), store, <Map<String, dynamic>>[]);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a clean check returns the platform\'s verdict', () async {
    final client = MockClient((req) async => http.Response(
          jsonEncode({
            'result': 'BOARDED', 'seat_no': 'A1', 'pnr': 'K7W4VP',
            'passenger': 'Rahim Uddin', 'message': 'Seat A1.',
          }),
          200,
          headers: {'content-type': 'application/json'},
        ));
    final (boarding, _, _) = await _rig(client);

    final v = await boarding.check(tripId: 't1', pnr: 'k7w4vp', l: _l);

    expect(v.letThemOn, isTrue);
    expect(v.seatNo, 'A1');
    expect(v.queued, isFalse, reason: 'the platform answered, so nothing is provisional');
  });

  test('a refusal is an answer, not an exception', () async {
    // ALREADY_BOARDED arrives as a 409. Treating any non-2xx as a failure would
    // hide from the crew the one thing they need to know at that moment.
    final client = MockClient((req) async => http.Response(
          jsonEncode({
            'result': 'ALREADY_BOARDED', 'seat_no': 'A2', 'pnr': 'M2X8QT',
            'message': 'This ticket was already scanned.',
          }),
          409,
          headers: {'content-type': 'application/json'},
        ));
    final (boarding, _, _) = await _rig(client);

    final v = await boarding.check(tripId: 't1', pnr: 'M2X8QT', l: _l);

    expect(v.alreadyOn, isTrue);
    expect(v.letThemOn, isFalse);
  });

  test('with no line, a known passenger is let on and the check is queued', () async {
    final (boarding, store, _) = await _rig(_deadLine());
    await store.cacheManifest('t1', _manifestRaw());

    final v = await boarding.check(tripId: 't1', pnr: 'K7W4VP', l: _l);

    expect(v.letThemOn, isTrue);
    expect(v.seatNo, 'A1');
    expect(v.queued, isTrue, reason: 'a provisional yes must say it is provisional');
    expect(store.queuedScans(), hasLength(1));
  });

  test('with no line, someone already aboard is not queued a second time', () async {
    final (boarding, store, _) = await _rig(_deadLine());
    await store.cacheManifest('t1', _manifestRaw());

    final v = await boarding.check(tripId: 't1', pnr: 'M2X8QT', l: _l);

    expect(v.alreadyOn, isTrue);
    expect(store.queuedScans(), isEmpty);
  });

  test('with no line, an unknown ticket queues nothing at all', () async {
    // The device has no basis for asserting this person may travel. Guessing
    // yes is the one mistake that cannot be taken back once the bus has left.
    final (boarding, store, _) = await _rig(_deadLine());
    await store.cacheManifest('t1', _manifestRaw());

    final v = await boarding.check(tripId: 't1', pnr: 'NOSUCH', l: _l);

    expect(v.letThemOn, isFalse);
    expect(v.result, 'NOT_FOUND');
    expect(store.queuedScans(), isEmpty);
  });

  test('with no line and no cached list, nothing is asserted', () async {
    final (boarding, store, _) = await _rig(_deadLine());

    final v = await boarding.check(tripId: 'never-fetched', pnr: 'K7W4VP', l: _l);

    expect(v.result, 'NOT_FOUND');
    expect(store.queuedScans(), isEmpty);
  });

  test('a queued check keeps the reference it was minted with, and flushing '
      'twice boards nobody twice', () async {
    SharedPreferences.setMockInitialValues({});
    final store = await Store.open();

    // First: no line. The check is queued with a reference minted on device.
    var online = false;
    final seen = <String>[];
    final client = MockClient((req) async {
      if (!online) throw const _NoRoute();
      seen.add((jsonDecode(req.body) as Map<String, dynamic>)['client_ref'] as String);
      return http.Response(
        jsonEncode({'result': 'BOARDED', 'seat_no': 'A1', 'pnr': 'K7W4VP', 'message': 'ok'}),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final boarding = CrewApi(ApiClient(base: 'http://test/api/v1', httpClient: client));
    final b = Boarding(api: boarding, store: store);
    await store.cacheManifest('t1', _manifestRaw());

    await b.check(tripId: 't1', pnr: 'K7W4VP', l: _l);
    expect(store.queuedScans(), hasLength(1));
    final mintedRef = store.queuedScans().single['client_ref'] as String;

    // Then the line comes back.
    online = true;
    expect(await b.flush(), 1);
    expect(store.queuedScans(), isEmpty);

    // And a second flush sends nothing, because the queue is empty — the
    // platform is never asked to deduplicate what was never re-sent.
    expect(await b.flush(), 0);

    expect(seen, [mintedRef],
        reason: 'the reference must survive the queue, or a replay becomes a second boarding');
  });

  test('a flush with no line keeps everything for later', () async {
    final (boarding, store, _) = await _rig(_deadLine());
    await store.cacheManifest('t1', _manifestRaw());
    await boarding.check(tripId: 't1', pnr: 'K7W4VP', l: _l);

    expect(await boarding.flush(), 0);
    expect(store.queuedScans(), hasLength(1), reason: 'nothing is dropped while offline');
  });

  test('a check the platform refuses is dropped rather than retried forever', () async {
    SharedPreferences.setMockInitialValues({});
    final store = await Store.open();
    var online = false;
    final client = MockClient((req) async {
      if (!online) throw const _NoRoute();
      return http.Response(
        jsonEncode({'error': 'trip_closed', 'message': 'That trip has finished.'}),
        422,
        headers: {'content-type': 'application/json'},
      );
    });
    final b = Boarding(
      api: CrewApi(ApiClient(base: 'http://test/api/v1', httpClient: client)),
      store: store,
    );
    await store.cacheManifest('t1', _manifestRaw());
    await b.check(tripId: 't1', pnr: 'K7W4VP', l: _l);

    online = true;
    await b.flush();

    expect(store.queuedScans(), isEmpty,
        reason: 'a refusal is a decision; re-sending it forever would only hide it');
  });
}

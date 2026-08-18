import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:jatra_core/jatra_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:jatra_crew/boarding.dart';

/// The door, and the bug that meant it never opened for a camera.
///
/// A ticket's QR encodes a signed token — `k1.` and then base64url — not a PNR.
/// The app read that token, upper-cased it along with everything else, and sent
/// it in the `pnr` field. base64url is case-sensitive, so the lookup could not
/// match, and every scan of a real ticket came back NOT_FOUND.
///
/// It survived a release because the manual-entry fallback works and the smoke
/// suite only ever scanned by PNR. These tests are the two halves of that: what
/// leaves the phone, and what an offline phone matches against.

http.Response _json(Object body, [int code = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)), code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

const _token = 'k1.aBcD_eFgH-iJkL';

class _Wire {
  final List<Map<String, dynamic>> sent = [];
  late final CrewApi api = CrewApi(ApiClient(
    base: 'http://test/api/v1',
    httpClient: MockClient((req) async {
      if (req.url.path.endsWith('/driver/scan')) {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        sent.add(body);
        // The server this stands in for looks the token up exactly as sent.
        final ok = body['qr_token'] == _token;
        return _json({
          'result': ok ? 'BOARDED' : 'NOT_FOUND',
          'seat_no': ok ? 'B3' : '',
          'pnr': ok ? 'ABC123' : body['pnr'],
          'message': ok ? 'Boarded' : 'Not found',
        });
      }
      return _json(const {});
    }),
  ));
}

Future<Boarding> _boarding(_Wire wire) async {
  SharedPreferences.setMockInitialValues({});
  final store = await Store.open();
  return Boarding(api: wire.api, store: store);
}

void main() {
  const l = L(Lang.bn);

  test('a scanned QR leaves the phone as a token, exactly as it was read',
      () async {
    final wire = _Wire();
    final boarding = await _boarding(wire);

    final v = await boarding.check(tripId: 't-1', qrToken: _token, l: l);

    final body = wire.sent.single;
    expect(body['qr_token'], _token,
        reason: 'case is significant in base64url; upper-casing it turned every '
            'valid ticket into NOT_FOUND');
    expect(body['pnr'], '',
        reason: 'a signed token is not a booking reference and must not be sent as one');
    expect(v.result, 'BOARDED');
  });

  test('a typed booking reference is still upper-cased and sent as a PNR',
      () async {
    final wire = _Wire();
    final boarding = await _boarding(wire);

    await boarding.check(tripId: 't-1', pnr: ' k7w4vp ', l: l);

    final body = wire.sent.single;
    expect(body['pnr'], 'K7W4VP',
        reason: 'a helper reads six characters off a screen; case is not '
            'significant there and the server upper-cases anyway');
    expect(body['qr_token'], '');
  });

  test('with no signal, a scanned QR is matched against the downloaded list',
      () async {
    SharedPreferences.setMockInitialValues({});
    final store = await Store.open();
    // A phone that cannot reach the platform at all — the case the whole
    // offline path exists for, on a bus between towns.
    final offline = Boarding(
      api: CrewApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((_) async => throw http.ClientException('no route to host')),
      )),
      store: store,
    );

    await store.cacheManifest('t-1', {
      'trip': {'route': 'Dhaka → Chattogram', 'operator': 'Green Line',
               'registration': 'DHA-1', 'depart_at': '2099-09-01T22:00:00+06:00',
               'status': 'BOARDING'},
      'total': 1, 'boarded': 0,
      'passengers': [
        {'seat_no': 'B3', 'pnr': 'ABC123', 'passenger': 'Rahim Uddin',
         'phone': '+8801711000001', 'channel': 'WEB', 'ticket_status': 'VALID',
         'from': 'Dhaka', 'to': 'Chattogram', 'qr_token': _token},
      ],
    });

    final v = await offline.check(tripId: 't-1', qrToken: _token, l: l);

    expect(v.result, 'BOARDED',
        reason: 'the manifest carries the token precisely so a phone with no '
            'signal can still answer for a scanned ticket');
    expect(v.seatNo, 'B3');
    expect(v.queued, isTrue);

    // What is queued is the resolved PNR and seat, not the raw token: by the
    // time this replays, the seat is what the office needs to see.
    final queued = store.queuedScans().single;
    expect(queued['pnr'], 'ABC123');
    expect(queued['seat_no'], 'B3');
  });

  test('a QR that is not on the downloaded list is refused, not guessed',
      () async {
    SharedPreferences.setMockInitialValues({});
    final store = await Store.open();
    final offline = Boarding(
      api: CrewApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((_) async => throw http.ClientException('no route to host')),
      )),
      store: store,
    );
    await store.cacheManifest('t-1', {
      'trip': {'route': 'Dhaka → Chattogram', 'operator': 'Green Line',
               'registration': 'DHA-1', 'depart_at': '2099-09-01T22:00:00+06:00',
               'status': 'BOARDING'},
      'total': 0, 'boarded': 0, 'passengers': [],
    });

    final v = await offline.check(tripId: 't-1', qrToken: _token, l: l);
    expect(v.result, 'NOT_FOUND',
        reason: 'saying yes to somebody who is not on the list is the one '
            'mistake that cannot be taken back once the bus has left');
  });
}

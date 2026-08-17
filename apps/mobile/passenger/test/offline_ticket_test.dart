import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The promise this app is built to keep: a ticket opens at a bus door in a
/// place with no signal. These tests are about that promise and about the two
/// money rules it sits next to.

Map<String, dynamic> _bookingRaw({
  String pnr = 'K7W4VP',
  String status = 'TICKETED',
  String departAt = '2026-09-01T22:00:00+06:00',
}) =>
    {
      'pnr': pnr,
      'booking_id': 'b-$pnr',
      'status': status,
      'total_poisha': 120000,
      'channel': 'APP',
      'created_at': '2026-08-17T10:00:00+06:00',
      'trip_id': 't-1',
      'brand': 'Green Line',
      'bus_type': 'AC Business',
      'registration': 'DHA-METRO-B-11-2288',
      'depart_at': departAt,
      'origin': 'Dhaka',
      'destination': 'Chattogram',
      'phone': '01711000000',
      'seats': ['A1', 'A2'],
      'tickets': [
        {
          'ticket_id': 'tk-1', 'seat_no': 'A1', 'qr_token': 'signed.opaque.token',
          'status': 'VALID', 'passenger': 'Rahim Uddin',
        },
      ],
    };

class _NoRoute implements Exception {
  const _NoRoute();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('a ticket on the device', () {
    test('survives being written and read back whole', () async {
      SharedPreferences.setMockInitialValues({});
      final store = await Store.open();

      await store.cacheTicket(Booking.fromJson(_bookingRaw()));
      final back = store.cachedTicket('K7W4VP');

      expect(back, isNotNull);
      expect(back!.seats, ['A1', 'A2']);
      expect(back.tickets.single.qrToken, 'signed.opaque.token',
          reason: 'without the token there is no QR to show at the door');
      expect(back.totalPoisha, 120000);
    });

    test('is replaced rather than duplicated when it is refreshed', () async {
      SharedPreferences.setMockInitialValues({});
      final store = await Store.open();

      await store.cacheTicket(Booking.fromJson(_bookingRaw(status: 'CONFIRMED')));
      await store.cacheTicket(Booking.fromJson(_bookingRaw(status: 'TICKETED')));

      expect(store.cachedTickets(), hasLength(1));
      expect(store.cachedTicket('K7W4VP')!.status, 'TICKETED');
    });

    test('is readable with the platform completely unreachable', () async {
      SharedPreferences.setMockInitialValues({});
      final store = await Store.open();
      await store.cacheTicket(Booking.fromJson(_bookingRaw()));

      // No line at all. Nothing below touches the network.
      final api = PassengerApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((_) async => throw const _NoRoute()),
      ));
      expect(() => api.booking('K7W4VP'), throwsA(isA<ApiError>()));

      final offline = store.cachedTicket('K7W4VP');
      expect(offline!.tickets.single.qrToken, isNotEmpty);
    });

    test('one corrupt entry does not cost the passenger the others', () async {
      SharedPreferences.setMockInitialValues({
        'jatra.tickets': ['{not json at all', jsonEncode(_bookingRaw())],
      });
      final store = await Store.open();

      expect(store.cachedTickets(), hasLength(1));
      expect(store.cachedTickets().single.pnr, 'K7W4VP');
    });
  });

  group('the money rules', () {
    test('poisha are integers all the way to the screen', () {
      // 120000 poisha is ৳1,200 — never 1200.0, and never reconstructed from a
      // double that might land on 1199.99.
      expect(taka(120000), '৳1,200');
      expect(taka(120050, decimals: true), '৳1,200.50');
      expect(taka(5), '৳0');
      expect(taka(5, decimals: true), '৳0.05');
    });

    test('grouping follows en-BD, not the Indian convention', () {
      // The web product renders 1,20,000 as 120,000 through en-BD. A mobile app
      // that grouped differently would give a passenger and a counter clerk two
      // different-looking versions of the same fare.
      expect(taka(12000000), '৳120,000');
      expect(taka(123456700), '৳1,234,567');
    });

    test('a negative difference keeps its sign', () {
      expect(taka(-25000), '৳-250');
    });
  });

  group('the client', () {
    test('carries an idempotency key when one is given', () async {
      String? seen;
      final api = PassengerApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((req) async {
          seen = req.headers['Idempotency-Key'];
          return http.Response(
            jsonEncode({'hold_id': 'h1', 'trip_id': 't1', 'seats': ['A1'], 'expires_at': ''}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      ));

      await api.createHold(
        tripId: 't1', seats: ['A1'], boardSeq: 0, dropSeq: 3,
        idempotencyKey: 'hold-abc',
      );

      expect(seen, 'hold-abc',
          reason: 'a retried tap must not take two sets of seats');
    });

    test('minted keys are not repeated', () {
      final keys = List.generate(200, (_) => newIdempotencyKey('hold'));
      expect(keys.toSet(), hasLength(200));
    });

    test('sends the channel as APP, so the platform can tell it apart', () async {
      Map<String, dynamic>? body;
      final api = PassengerApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((req) async {
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({'hold_id': 'h1', 'trip_id': 't1', 'seats': ['A1'], 'expires_at': ''}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      ));

      await api.createHold(
        tripId: 't1', seats: ['A1'], boardSeq: 0, dropSeq: 3,
        idempotencyKey: 'k',
      );

      expect(body!['channel'], 'APP');
    });

    test('a Bangla message survives the wire', () async {
      // res.body guesses latin-1 when the server names no charset, which turns
      // every Bangla refusal into mojibake. The client decodes utf-8 explicitly.
      final api = PassengerApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((_) async => http.Response.bytes(
              utf8.encode(jsonEncode({
                'error': 'seat_taken',
                'message': 'আপনার একটু আগেই অন্য কেউ ওই আসনটি নিয়ে নিয়েছেন।',
              })),
              409,
            )),
      ));

      try {
        await api.booking('K7W4VP');
        fail('expected a refusal');
      } on ApiError catch (e) {
        expect(e.message, contains('আসনটি'));
        expect(e.status, 409);
      }
    });

    test('no line is distinguishable from a refusal', () async {
      final dead = PassengerApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: MockClient((_) async => throw const _NoRoute()),
      ));
      try {
        await dead.booking('K7W4VP');
        fail('expected a failure');
      } on ApiError catch (e) {
        expect(e.offline, isTrue,
            reason: 'the apps fall back to the device only when there is truly no line');
      }
    });
  });

  group('journeys kept', () {
    test('the newest sits first and the list stays short', () async {
      SharedPreferences.setMockInitialValues({});
      final store = await Store.open();

      for (final r in ['A|B', 'C|D', 'E|F', 'G|H', 'I|J', 'K|L', 'M|N']) {
        final p = r.split('|');
        await store.saveRoute(p[0], p[1]);
      }

      final saved = store.savedRoutes();
      expect(saved, hasLength(6));
      expect(saved.first.from, 'M');
    });

    test('saving the same journey twice moves it up rather than repeating it', () async {
      SharedPreferences.setMockInitialValues({});
      final store = await Store.open();
      await store.saveRoute('Dhaka', 'Chattogram');
      await store.saveRoute('Dhaka', 'Sylhet');
      await store.saveRoute('Dhaka', 'Chattogram');

      expect(store.savedRoutes(), hasLength(2));
      expect(store.savedRoutes().first.to, 'Chattogram');
    });
  });

  group('the language', () {
    test('figures stay Latin in Bangla', () {
      const bn = L(Lang.bn);
      // ৳১,২০০ next to ৳1,200 is how a passenger and a clerk end up unable to
      // check a fare against each other over a phone line.
      expect(bn('find.seatsLeft', {'n': 7}), contains('7'));
      expect(taka(120000), contains('1,200'));
    });

    test('a missing key is loud rather than blank', () {
      const bn = L(Lang.bn);
      expect(bn('no.such.key'), 'no.such.key');
    });

    test('an unfilled placeholder stays visible', () {
      expect(fill('Seat {seat}', {}), 'Seat {seat}');
    });
  });
}

import 'dart:convert';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_passenger/app_state.dart';
import 'package:jatra_passenger/reminders.dart';
import 'package:jatra_passenger/voice_flow.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The voice flow, driven without a microphone.
///
/// `VoiceFlow.handle` is the same method the microphone path calls once a
/// transcript has been parsed, so feeding intents straight in exercises every
/// decision the feature makes — what it holds, what it books, what it pays, and
/// crucially what it refuses to do — with the only untested step being the
/// audio capture itself, which no test rig can drive anyway.
///
/// The tests that matter most here are the negative ones. A voice interface
/// that occasionally mishears is tolerable; one that holds seats or spends
/// money when nobody said yes is not.

http.Response _json(Object body, [int code = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

Map<String, dynamic> _trip({
  String id = 't-1',
  String brand = 'Green Line',
  String depart = '2099-09-01T06:00:00+06:00',
  int fare = 115000,
}) =>
    {
      'trip_id': id,
      'brand': brand,
      'bus_type': 'AC Business',
      'is_ac': true,
      'class': 'BUSINESS',
      'registration': 'DHAKA METRO-B-11-2288',
      'depart_at': depart,
      'arrive_at': '2099-09-01T11:00:00+06:00',
      'origin': 'Dhaka',
      'destination': 'Chattogram',
      'fare_poisha': fare,
      'seats_free': 30,
      'board_seq': 0,
      'drop_seq': 3,
    };

Map<String, dynamic> _booking({String status = 'PAYMENT_PENDING', int total = 230000}) => {
      'pnr': 'VOX123',
      'booking_id': 'b-vox',
      'status': status,
      'total_poisha': total,
      'trip_id': 't-1',
      'brand': 'Green Line',
      'bus_type': 'AC Business',
      'registration': 'DHAKA METRO-B-11-2288',
      'depart_at': '2099-09-01T06:00:00+06:00',
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

/// Records what the flow actually asked the platform to do, so a test can
/// assert that nothing was held or paid rather than only that the screen said
/// so.
class _Calls {
  final List<String> hits = [];
  // endsWith, because the recorded path carries the /api/v1 prefix.
  bool get held => hits.any((h) => h.startsWith('POST') && h.endsWith('/holds'));
  bool get booked => hits.any((h) => h.startsWith('POST') && h.endsWith('/bookings'));
  bool get paid => hits.any((h) => h.contains('sandbox/complete'));
}

MockClient _platform(
  _Calls calls, {
  int fare = 115000,
  int bookingTotal = 230000,
  String redirect = '/payment/sandbox?ref=abc',
  String finalStatus = 'TICKETED',
}) =>
    MockClient((req) async {
      final p = req.url.path;
      calls.hits.add('${req.method} $p');

      if (p.endsWith('/locations')) {
        final q = (req.url.queryParameters['q'] ?? '').toLowerCase();
        // Stands in for the platform's real resolver, which is typo-tolerant
        // and knows both languages. What matters here is only that the words
        // the parser extracted are handed to it and a canonical name comes back.
        const known = {
          'dhaka': 'Dhaka', 'ঢাকা': 'Dhaka',
          'chittagong': 'Chattogram', 'chattogram': 'Chattogram', 'চট্টগ্রাম': 'Chattogram',
        };
        final hit = known[q];
        return _json({
          'locations': hit == null
              ? []
              : [
                  {'id': 'l1', 'name': hit, 'name_bn': '', 'kind': 'CITY',
                   'parent': '', 'served': true}
                ]
        });
      }
      if (p.endsWith('/search')) {
        return _json({
          'results': [
            _trip(fare: fare),
            _trip(id: 't-2', brand: 'Hanif', depart: '2099-09-01T22:00:00+06:00', fare: fare),
          ]
        });
      }
      if (p.endsWith('/seatmap')) {
        return _json({
          'seats': [
            for (var i = 1; i <= 4; i++)
              {
                'seat_no': 'A$i', 'row': 0, 'col': i, 'deck': 1,
                'seat_type': 'NORMAL',
                // `available` is its own field on the wire, computed by the
                // inventory service for the exact leg being booked — it is not
                // the negation of sold/held/blocked, and a fixture that leaves
                // it out is asserting the client's assumption rather than the
                // platform's answer.
                'available': true,
                'sold': false, 'held': false, 'blocked': false,
              }
          ]
        });
      }
      if (p.endsWith('/holds') && req.method == 'POST') {
        return _json({
          'hold_id': 'h-1', 'trip_id': 't-1', 'seats': ['A1', 'A2'],
          'board_seq': 0, 'drop_seq': 3,
          'expires_at': DateTime.now().add(const Duration(minutes: 9)).toIso8601String(),
        });
      }
      if (p.endsWith('/bookings') && req.method == 'POST') {
        return _json({'pnr': 'VOX123'});
      }
      if (p.endsWith('/payments/intent')) {
        return _json({
          'payment_ref': 'ref-1',
          'provider': 'BKASH',
          'amount_poisha': bookingTotal,
          'pnr': 'VOX123',
          'redirect_url': redirect,
        });
      }
      if (p.contains('sandbox/complete')) return _json(const {'ok': true});
      if (p.contains('/bookings/')) {
        // First read is the pending booking created above; after payment it is
        // whatever the platform says, which is the only thing that decides
        // whether a ticket exists.
        final done = calls.paid;
        return _json(_booking(
            status: done ? finalStatus : 'PAYMENT_PENDING', total: bookingTotal));
      }
      return _json(const {});
    });

Future<AppState> _state(_Calls calls,
    {bool known = true, int bookingTotal = 230000, String redirect = '/payment/sandbox?ref=abc'}) async {
  SharedPreferences.setMockInitialValues({
    if (known) 'jatra.me.name': 'Rahim Uddin',
    if (known) 'jatra.me.phone': '01711000000',
  });
  final store = await Store.open();
  return AppState(
    api: PassengerApi(ApiClient(
      base: 'http://test/api/v1',
      httpClient: _platform(calls, bookingTotal: bookingTotal, redirect: redirect),
    )),
    store: store,
    reminders: Reminders(FlutterLocalNotificationsPlugin(), store),
  );
}

const _l = L(Lang.bn);
final _now = DateTime(2026, 8, 18, 10, 0);

VoiceIntent _say(String s) => parseVoice(s, now: _now);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a spoken journey searches, and reads back before holding anything',
      (() async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong duita seat'));
    expect(flow.results, isNotEmpty, reason: 'the search should have run');

    await flow.handle(_say('প্রথমটা'));
    expect(flow.stage, VoiceStage.confirmHold);
    expect(calls.held, isFalse,
        reason: 'NOTHING may be held until the read-back has been answered');
  }));

  test('saying no holds nothing and books nothing', () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong duita seat'));
    await flow.handle(_say('প্রথমটা'));
    expect(flow.stage, VoiceStage.confirmHold);

    await flow.handle(_say('না'), expecting: VoiceStage.confirmHold);

    expect(flow.stage, VoiceStage.idle);
    expect(calls.held, isFalse);
    expect(calls.booked, isFalse);
  });

  test('an unclear answer to a read-back is treated as no', () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('mmm errr'), expecting: VoiceStage.confirmHold);

    expect(calls.held, isFalse,
        reason: 'silence and noise must never be read as consent — erring the '
            'other way holds seats against somebody who did not agree');
    expect(flow.stage, VoiceStage.idle);
  });

  test('yes holds, books, and then asks again before paying', () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong duita seat'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmHold);

    expect(calls.held, isTrue);
    expect(calls.booked, isTrue);
    expect(flow.stage, VoiceStage.confirmPay,
        reason: 'booking and paying are two separate consents');
    expect(calls.paid, isFalse, reason: 'no money moves on the booking yes');
  });

  test('a second yes pays, and the ticket comes from the platform', () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong duita seat'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmHold);
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmPay);

    expect(calls.paid, isTrue);
    expect(flow.stage, VoiceStage.done);
    expect(flow.booking?.pnr, 'VOX123');
    // The app did not decide this. It asked the platform what happened.
    expect(calls.hits.where((h) => h.contains('/bookings/VOX123')).length,
        greaterThanOrEqualTo(1),
        reason: 'the booking is re-read after payment rather than assumed');
  });

  test('saying no to the payment leaves the booking unpaid, not cancelled',
      () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmHold);
    await flow.handle(_say('না'), expecting: VoiceStage.confirmPay);

    expect(calls.paid, isFalse);
    expect(flow.booking, isNotNull,
        reason: 'the booking exists and can still be paid by tapping');
  });

  test('voice will not approve more than its ceiling', () async {
    final calls = _Calls();
    // One taka over the line.
    final flow = VoiceFlow(
      app: await _state(calls, bookingTotal: kVoicePayCeilingPoisha + 100),
      l: _l,
    );

    await flow.handle(_say('kal dhaka theke chittagong'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmHold);

    expect(flow.stage, VoiceStage.needsDetails,
        reason: 'a misheard yes on a large amount is a serious loss, so above '
            'the ceiling voice hands over to the tap flow');
    expect(calls.paid, isFalse);
  });

  test('against a real provider voice stops at the payment sheet', () async {
    final calls = _Calls();
    final flow = VoiceFlow(
      app: await _state(calls, redirect: 'https://checkout.bkash.com/abc'),
      l: _l,
    );

    await flow.handle(_say('kal dhaka theke chittagong'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmHold);

    expect(flow.stage, VoiceStage.needsDetails,
        reason: 'the PIN is taken inside the provider app and cannot be '
            'delegated, so the last step has to be the passenger’s');
    expect(calls.paid, isFalse);
  });

  test('a device that does not know the traveller stops before booking',
      () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls, known: false), l: _l);

    await flow.handle(_say('kal dhaka theke chittagong'));
    await flow.handle(_say('প্রথমটা'));
    await flow.handle(_say('হ্যাঁ'), expecting: VoiceStage.confirmHold);

    expect(calls.held, isTrue, reason: 'the seats are secured first');
    expect(calls.booked, isFalse);
    expect(flow.stage, VoiceStage.needsDetails,
        reason: 'an 11-digit phone number is exactly what speech recognition '
            'is worst at, and a wrong one sends somebody else the ticket');
    expect(flow.hold, isNotNull, reason: 'the form needs the hold to continue');
  });

  test('a place the platform does not know is refused, not guessed', () async {
    final calls = _Calls();
    final flow = VoiceFlow(app: await _state(calls), l: _l);

    await flow.handle(_say('kal dhaka theke atlantis'));

    expect(flow.stage, VoiceStage.failed);
    expect(flow.results, isEmpty);
    expect(calls.held, isFalse);
  });
}

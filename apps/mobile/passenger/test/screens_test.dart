import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_passenger/app_state.dart';
import 'package:jatra_passenger/reminders.dart';
import 'package:jatra_passenger/screens/home.dart';
import 'package:jatra_passenger/screens/offers.dart';
import 'package:jatra_passenger/screens/ticket.dart';
import 'package:jatra_passenger/screens/tickets.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Mounting every screen.
///
/// These exist because of a class of bug nothing else here catches. The
/// analyzer is happy with `AppScope.of(context)` inside `initState`, and the
/// unit tests never build a widget — but Flutter asserts on it, so every screen
/// that started its first load from `initState`, which was most of them, threw
/// on its first frame in a debug build. A release build disables that assert,
/// so it would have looked fine right up until somebody ran it from an IDE.
///
/// A test that merely constructs a widget would not have found it either. The
/// widget has to be pumped.

Map<String, dynamic> _booking({String pnr = 'K7W4VP', String status = 'TICKETED'}) => {
      'pnr': pnr,
      'booking_id': 'b-$pnr',
      'status': status,
      'total_poisha': 120000,
      'trip_id': 't-1',
      'brand': 'Green Line',
      'bus_type': 'AC Business',
      'registration': 'DHA-METRO-B-11-2288',
      'depart_at': '2099-09-01T22:00:00+06:00',
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

http.Response _json(Object body, [int code = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// Answers whatever the screen under test asks for.
MockClient _platform() => MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('/offers')) {
        return _json({
          'offers': [
            {
              'code': 'EIDSAFAR', 'title': 'Eid Safar — 15% off',
              'title_bn': 'ঈদ সফর — 15% ছাড়', 'discount_pct': 15,
              'min_amount_poisha': 100000, 'max_discount_poisha': 30000,
            }
          ]
        });
      }
      if (p.contains('/bookings/')) return _json(_booking());
      if (p.endsWith('/search')) return _json({'results': []});
      return _json(const {});
    });

Future<AppState> _state({List<String> tickets = const []}) async {
  SharedPreferences.setMockInitialValues({'jatra.tickets': tickets});
  final store = await Store.open();
  return AppState(
    api: PassengerApi(ApiClient(base: 'http://test/api/v1', httpClient: _platform())),
    store: store,
    // Constructed directly rather than through start(), which would try to talk
    // to a notification plugin that does not exist in a test binding.
    reminders: Reminders(FlutterLocalNotificationsPlugin(), store),
  );
}

Widget _wrap(AppState state, Widget child) => LangScope(
      lang: Lang.bn,
      setLang: (_) {},
      child: AppScope(
        state: state,
        child: MaterialApp(theme: jatraTheme(), home: child),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the search screen mounts and offers a way to search', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    expect(find.text(const L(Lang.bn)('find.go')), findsOneWidget);
    expect(find.text('Dhaka'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the tickets screen mounts with nothing in it and says what to do',
      (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const TicketsScreen()));
    await tester.pump();

    expect(find.text(const L(Lang.bn)('tk.none')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a cached ticket appears without the platform being asked',
      (tester) async {
    final state = await _state(tickets: [jsonEncode(_booking())]);
    await tester.pumpWidget(_wrap(state, const TicketsScreen()));
    await tester.pump();

    expect(find.text('Dhaka → Chattogram'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the ticket screen draws a QR from the cached token', (tester) async {
    final state = await _state(tickets: [jsonEncode(_booking())]);
    await tester.pumpWidget(_wrap(state, const TicketScreen(pnr: 'K7W4VP')));
    await tester.pump();

    // The ticket number and the seats, which is what a helper at a door reads.
    // The seats appear twice on purpose — once on the stub at a glance, once in
    // the details underneath — so this counts at least one rather than exactly.
    expect(find.text('K7W4VP'), findsOneWidget);
    expect(find.text('A1, A2'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offers mount and show Bangla campaign copy to a Bangla reader',
      (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const OffersScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('ঈদ সফর — 15% ছাড়'), findsOneWidget);
    expect(find.text('EIDSAFAR'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the same screen in English shows the English campaign copy',
      (tester) async {
    final state = await _state();
    await tester.pumpWidget(LangScope(
      lang: Lang.en,
      setLang: (_) {},
      child: AppScope(
        state: state,
        child: MaterialApp(theme: jatraTheme(), home: const OffersScreen()),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Eid Safar — 15% off'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

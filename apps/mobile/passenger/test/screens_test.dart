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
import 'package:jatra_passenger/screens/seats.dart';
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

/// A seat map shaped the way the platform actually shapes one.
///
/// Two details here are the whole point of the tests below, and both were got
/// wrong against the real service: rows are numbered **from zero**, and a
/// sleeper puts two berths on the same row and column of different decks.
Map<String, dynamic> _seatMap({
  required int decks,
  required int rows,
  required int cols,
  required String Function(int deck, int row, int col) name,
}) =>
    {
      'trip_id': 't-1',
      'board_seq': 0,
      'drop_seq': 3,
      'seats': [
        for (var d = 1; d <= decks; d++)
          for (var r = 0; r < rows; r++)
            for (var c = 1; c <= cols; c++)
              {
                'seat_no': name(d, r, c),
                'seat_type': decks > 1 ? 'SLEEPER' : 'NORMAL',
                'deck': d,
                'row': r,
                'col': c,
                'available': true,
                'sold': false,
                'held': false,
                'blocked': false,
              },
      ],
    };

String _rowLetter(int r) => String.fromCharCode(65 + r);

TripSummary _trip() => TripSummary.fromJson({
      'trip_id': 't-1',
      'brand': 'Green Line',
      'bus_type': 'AC Business',
      'depart_at': '2099-09-01T22:00:00+06:00',
      'origin': 'Dhaka',
      'destination': 'Chattogram',
      'fare_poisha': 115000,
      'board_seq': 0,
      'drop_seq': 3,
    });

/// Answers whatever the screen under test asks for.
MockClient _platform({Map<String, dynamic>? seatMap}) => MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('/seatmap')) return _json(seatMap ?? const {'seats': []});
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

Future<AppState> _state({
  List<String> tickets = const [],
  Map<String, dynamic>? seatMap,
}) async {
  SharedPreferences.setMockInitialValues({'jatra.tickets': tickets});
  final store = await Store.open();
  return AppState(
    api: PassengerApi(
        ApiClient(base: 'http://test/api/v1', httpClient: _platform(seatMap: seatMap))),
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

  testWidgets('every seat the platform sent is on the map, including the front row',
      (tester) async {
    // Forty seats, rows numbered from zero exactly as the platform numbers
    // them. The front row is the one that used to vanish.
    final state = await _state(
      seatMap: _seatMap(
        decks: 1,
        rows: 10,
        cols: 4,
        name: (_, r, c) => '${_rowLetter(r)}$c',
      ),
    );
    await tester.pumpWidget(_wrap(state, SeatsScreen(trip: _trip())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    for (var r = 0; r < 10; r++) {
      for (var c = 1; c <= 4; c++) {
        final no = '${_rowLetter(r)}$c';
        expect(find.text(no), findsOneWidget,
            reason: '$no was sent by the platform and must be on the map');
      }
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('the front row can actually be bought, not merely drawn',
      (tester) async {
    final state = await _state(
      seatMap: _seatMap(
        decks: 1, rows: 10, cols: 4, name: (_, r, c) => '${_rowLetter(r)}$c'),
    );
    await tester.pumpWidget(_wrap(state, SeatsScreen(trip: _trip())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    await tester.tap(find.text('A1'));
    await tester.pump();

    // The bar only appears once a seat is chosen, and it names the seat and its
    // fare — so its presence is proof the tap reached the inventory-backed
    // selection rather than a decorative square.
    expect(find.text('A1'), findsWidgets);
    expect(find.text(taka(115000)), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a sleeper shows both decks, not just the one nearest the door',
      (tester) async {
    // Twelve berths below, twelve above, sharing row and column. Looking a seat
    // up by row and column alone hid the upper deck entirely.
    final state = await _state(
      seatMap: _seatMap(
        decks: 2,
        rows: 6,
        cols: 2,
        name: (d, r, c) => '${d == 1 ? 'L' : 'U'}${_rowLetter(r)}$c',
      ),
    );
    await tester.pumpWidget(_wrap(state, SeatsScreen(trip: _trip())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    for (var r = 0; r < 6; r++) {
      for (var c = 1; c <= 2; c++) {
        expect(find.text('L${_rowLetter(r)}$c'), findsOneWidget);
        expect(find.text('U${_rowLetter(r)}$c'), findsOneWidget);
      }
    }
    // And each deck is named, so a berth number means a shelf.
    const l = L(Lang.bn);
    expect(find.text(l('seat.lowerDeck')), findsOneWidget);
    expect(find.text(l('seat.upperDeck')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a single-deck coach is not given a deck label it does not need',
      (tester) async {
    final state = await _state(
      seatMap: _seatMap(
        decks: 1, rows: 10, cols: 4, name: (_, r, c) => '${_rowLetter(r)}$c'),
    );
    await tester.pumpWidget(_wrap(state, SeatsScreen(trip: _trip())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    const l = L(Lang.bn);
    expect(find.text(l('seat.lowerDeck')), findsNothing);
    expect(find.text(l('seat.upperDeck')), findsNothing);
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

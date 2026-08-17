import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_passenger/app_state.dart';
import 'package:jatra_passenger/main.dart';
import 'package:jatra_passenger/screens/account.dart';
import 'package:jatra_passenger/reminders.dart';
import 'package:jatra_passenger/screens/home.dart';
import 'package:jatra_passenger/screens/offers.dart';
import 'package:jatra_passenger/screens/passengers.dart';
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

/// The gazetteer, shaped the way the platform shapes it.
///
/// Field names are taken from a real `/locations` response, not from the model
/// that reads it — a fixture written from the client's assumptions is how the
/// crew roster came to read `role` for a year while the platform sent
/// `crew_role`, with the test agreeing with the bug.
List<Map<String, dynamic>> _places(String q) {
  const all = [
    {'id': 'l1', 'name': 'Dhaka', 'name_bn': 'ঢাকা', 'kind': 'CITY',
     'parent': '', 'served': true},
    {'id': 'l2', 'name': 'Chattogram', 'name_bn': 'চট্টগ্রাম', 'kind': 'CITY',
     'parent': '', 'served': true},
    {'id': 'l3', 'name': 'Cumilla', 'name_bn': 'কুমিল্লা', 'kind': 'CITY',
     'parent': 'Chattogram', 'served': true},
    {'id': 'l4', 'name': 'Bandarban', 'name_bn': 'বান্দরবান', 'kind': 'CITY',
     'parent': 'Chattogram', 'served': false},
    {'id': 'l5', 'name': 'Mohipal', 'name_bn': 'মহিপাল', 'kind': 'TERMINAL',
     'parent': 'Feni', 'served': false},
  ];
  if (q.isEmpty) return all.where((p) => p['served'] == true).toList();
  final n = q.toLowerCase();
  return all
      .where((p) => '${p['name']}${p['name_bn']}'.toLowerCase().contains(n))
      .toList();
}

/// Answers whatever the screen under test asks for.
MockClient _platform({Map<String, dynamic>? seatMap, bool placesFail = false}) =>
    MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('/locations')) {
        if (placesFail) return _json(const {'error': 'unreachable'}, 503);
        return _json({'locations': _places(req.url.queryParameters['q'] ?? '')});
      }
      if (p.endsWith('/seatmap')) return _json(seatMap ?? const {'seats': []});
      if (p.endsWith('/account/profile')) {
        return _json(const {
          'display_name': 'Rahim Uddin',
          'phone': '01711000000',
          'email': 'rahim@example.test',
          'authenticated': true,
          'lang': 'bn',
          'has_password': false,
        });
      }
      if (p.endsWith('/account/bookings')) {
        return _json({
          'upcoming': [
            {
              'pnr': 'UPC001', 'status': 'TICKETED', 'total_poisha': 230000,
              'depart_at': '2099-09-01T22:00:00+06:00', 'brand': 'Green Line',
              'origin': 'Dhaka', 'destination': 'Chattogram',
              'seat_count': 2, 'upcoming': true,
            }
          ],
          'past': [
            {
              'pnr': 'OLD777', 'status': 'COMPLETED', 'total_poisha': 115000,
              'depart_at': '2020-01-05T08:00:00+06:00', 'brand': 'Hanif',
              'origin': 'Dhaka', 'destination': 'Sylhet',
              'seat_count': 1, 'upcoming': false,
            }
          ],
          'phone': '01711000000',
        });
      }
      if (p.endsWith('/account/passengers')) {
        return _json(const {
          'passengers': [
            {'id': 'sp1', 'full_name': 'Fatema Begum', 'gender': 'F', 'age': 29,
             'id_type': 'NID', 'id_number': '1995987654321'},
          ]
        });
      }
      if (p.endsWith('/auth/sessions')) return _json(const {'sessions': []});
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
      // Creating a booking is refused, deliberately. These tests are about
      // whether the screen's own validation lets you through — once it does,
      // the platform's answer is somebody else's test, and a success here
      // would navigate away to a screen this fixture cannot furnish.
      if (p.endsWith('/bookings') && req.method == 'POST') {
        return _json(const {'error': 'unavailable', 'message': 'Not in this test.'}, 503);
      }
      if (p.contains('/bookings/')) return _json(_booking());
      if (p.endsWith('/search')) return _json({'results': []});
      return _json(const {});
    });

Future<AppState> _state({
  List<String> tickets = const [],
  Map<String, dynamic>? seatMap,
  bool placesFail = false,
  List<String> recentPlaces = const [],
  String? knownName,
  String? knownPhone,
  bool signedIn = false,
}) async {
  SharedPreferences.setMockInitialValues({
    'jatra.tickets': tickets,
    if (recentPlaces.isNotEmpty) 'jatra.places.recent': recentPlaces,
    if (knownName != null) 'jatra.me.name': knownName,
    if (knownPhone != null) 'jatra.me.phone': knownPhone,
    if (signedIn) 'jatra.token': 'test-token',
    if (signedIn) 'jatra.phone': knownPhone ?? '01711000000',
    if (signedIn) 'jatra.name': knownName ?? 'Rahim Uddin',
  });
  final store = await Store.open();
  return AppState(
    api: PassengerApi(ApiClient(
        base: 'http://test/api/v1',
        httpClient: _platform(seatMap: seatMap, placesFail: placesFail))),
    store: store,
    // Constructed directly rather than through start(), which would try to talk
    // to a notification plugin that does not exist in a test binding.
    reminders: Reminders(FlutterLocalNotificationsPlugin(), store),
  );
}

/// A hold over [seats], with long enough left on the clock that the countdown
/// does not replace the form with "your seats have gone" mid-test.
Hold _hold(List<String> seats) => Hold.fromJson({
      'hold_id': 'h-1',
      'trip_id': 't-1',
      'seats': seats,
      'board_seq': 0,
      'drop_seq': 3,
      'expires_at': DateTime.now().add(const Duration(minutes: 9)).toIso8601String(),
      'price': {
        'seat_count': seats.length,
        'base_poisha': 115000 * seats.length,
        'total_poisha': 115000 * seats.length,
      },
    });

/// The whole app shell, for the tests that are about navigation rather than
/// about one screen.
Widget _wrapShell(AppState state) => LangScope(
      lang: Lang.bn,
      setLang: (_) {},
      child: AppScope(
        state: state,
        child: MaterialApp(theme: jatraTheme(), home: const Shell()),
      ),
    );

Widget _wrap(AppState state, Widget child) => LangScope(
      lang: Lang.bn,
      setLang: (_) {},
      child: AppScope(
        state: state,
        child: MaterialApp(theme: jatraTheme(), home: child),
      ),
    );

/// These screens are ListViews, so on a phone-sized test surface only the first
/// card or two are ever built — the rest does not exist to be found or typed
/// into. A tall window builds the whole thing.
void tallWindow(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 4000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the search screen mounts and offers a way to search', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    expect(find.text(const L(Lang.bn)('find.go')), findsOneWidget);
    // A Bangla reader sees the Bangla name of the place. The canonical name is
    // what travels to the platform, and is checked where that matters below.
    expect(find.text('ঢাকা'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  /* --------------------------------------------------------- the shell */

  testWidgets('the bottom menu survives going somewhere', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrapShell(state));
    await tester.pumpAndSettle();

    expect(find.byType(NavigationBar), findsOneWidget);

    // Go two screens deep, the way a passenger does.
    await tester.tap(find.text(const L(Lang.bn)('find.go')));
    await tester.pumpAndSettle();

    expect(find.byType(NavigationBar), findsOneWidget,
        reason: 'the app must not lose its navigation exactly when somebody '
            'is deepest inside it — that was the whole bug');
  });

  testWidgets('back pops the tab before it leaves the app', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrapShell(state));
    await tester.pumpAndSettle();

    await tester.tap(find.text(const L(Lang.bn)('find.go')));
    await tester.pumpAndSettle();
    expect(find.text(const L(Lang.bn)('find.go')), findsNothing);

    // The system back button.
    final popped =
        await tester.binding.handlePopRoute().then((_) => true).catchError((_) => false);
    await tester.pumpAndSettle();
    expect(popped, isTrue);
    expect(find.text(const L(Lang.bn)('find.go')), findsOneWidget,
        reason: 'back belongs to the tab first; it should not close the app '
            'from inside a booking flow');
  });

  testWidgets('the microphone is reachable from every screen', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrapShell(state));
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.mic), findsOneWidget);
    await tester.tap(find.text(const L(Lang.bn)('find.go')));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.mic), findsOneWidget,
        reason: 'voice lives in the shell so it is there mid-flow, which is '
            'when somebody wants to change their mind');
  });

  /* ------------------------------------------ known on this device */

  testWidgets('buying a ticket makes the device know the traveller',
      (tester) async {
    final state = await _state();
    expect(state.known, isFalse);

    await state.rememberTraveller('Rahim Uddin', '01711000000');

    expect(state.known, isTrue);
    expect(state.displayName, 'Rahim Uddin');
    expect(state.phone, '01711000000');
    expect(state.signedIn, isFalse,
        reason: 'knowing who bought a ticket is NOT a session — a typed phone '
            'number is not proof of owning it, and a session would open that '
            "person's saved passengers and NID numbers to anyone");
  });

  testWidgets('a known traveller is greeted and pre-filled, not signed in',
      (tester) async {
    final state = await _state(knownName: 'Rahim Uddin', knownPhone: '01711000000');
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    expect(find.text(const L(Lang.bn)('find.hello', {'name': 'Rahim'})), findsOneWidget);
  });

  testWidgets('the account tab offers to verify, and does not claim to have',
      (tester) async {
    final state = await _state(knownName: 'Rahim Uddin', knownPhone: '01711000000');
    await tester.pumpWidget(_wrap(state, const AccountScreen()));
    await tester.pumpAndSettle();

    expect(find.text(const L(Lang.bn)('ac.travellingAs')), findsOneWidget);
    expect(find.text(const L(Lang.bn)('ac.keepEverywhere')), findsOneWidget);
    expect(find.text(const L(Lang.bn)('ac.onThisPhone')), findsOneWidget,
        reason: 'the screen has to say this is only on this phone, or it is '
            'claiming an account the passenger does not have');
  });

  testWidgets('signing out keeps the device knowing you; forgetting does not',
      (tester) async {
    final state = await _state(knownName: 'Rahim Uddin', knownPhone: '01711000000');
    await state.signOut();
    expect(state.known, isTrue,
        reason: 'signing out should not empty the next checkout form');
    await state.forgetMe();
    expect(state.known, isFalse);
  });

  /* --------------------------------------------------------- the profile */

  testWidgets('a stranger is offered both ways in', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const AccountScreen()));
    await tester.pumpAndSettle();

    expect(find.text(const L(Lang.bn)('ac.withCode')), findsOneWidget);
    expect(find.text(const L(Lang.bn)('ac.withPassword')), findsOneWidget);
  });

  testWidgets('the profile shows past trips, not just upcoming ones',
      (tester) async {
    final state = await _state(signedIn: true, knownName: 'Rahim Uddin');
    await tester.pumpWidget(_wrap(state, const AccountScreen()));
    await tester.pumpAndSettle();

    expect(find.text(const L(Lang.bn)('ac.upcoming')), findsOneWidget);
    expect(find.text(const L(Lang.bn)('ac.past')), findsOneWidget,
        reason: 'the old tickets are the half that was missing');
    expect(find.text('OLD777'), findsOneWidget);
    expect(find.text('UPC001'), findsOneWidget);
  });

  testWidgets('the profile lists saved travellers and lets details be edited',
      (tester) async {
    tallWindow(tester);
    final state = await _state(signedIn: true, knownName: 'Rahim Uddin');
    await tester.pumpWidget(_wrap(state, const AccountScreen()));
    await tester.pumpAndSettle();

    expect(find.text('Fatema Begum'), findsOneWidget);
    expect(find.text(const L(Lang.bn)('ac.addPerson')), findsOneWidget);
    expect(find.text(const L(Lang.bn)('ac.edit')), findsOneWidget);
    // has_password is false in the fixture, so it must offer to set one.
    expect(find.text(const L(Lang.bn)('ac.setPassword')), findsWidgets);
  });

  /* ----------------------------------------------------- who is travelling */

  testWidgets('only the person booking has to be named', (tester) async {
    tallWindow(tester);
    final state = await _state();
    await tester.pumpWidget(
        _wrap(state, PassengersScreen(trip: _trip(), hold: _hold(['A1', 'A2', 'A3']))));
    await tester.pump();

    final fields = find.byType(TextField);
    // Three seats plus the contact number.
    expect(fields, findsNWidgets(4));

    // Name the first passenger and nobody else, then try to go on.
    await tester.enterText(fields.at(0), 'Rahim Uddin');
    await tester.enterText(fields.at(3), '01711000000');
    await tester.tap(find.text(const L(Lang.bn)('common.next')));
    await tester.pumpAndSettle();

    expect(find.text(const L(Lang.bn)('pax.needName')), findsNothing,
        reason: 'a group of three should not have to collect two more full '
            'names off their friends before they are allowed to pay');
    // Positive proof it got past the screen's own gate rather than failing
    // earlier for some unrelated reason: the refusal on screen is the
    // platform's, which only happens once the booking was actually attempted.
    expect(find.byType(ErrorNotice), findsOneWidget);
  });

  testWidgets('but leaving the booking name blank is still refused', (tester) async {
    tallWindow(tester);
    final state = await _state();
    await tester.pumpWidget(
        _wrap(state, PassengersScreen(trip: _trip(), hold: _hold(['A1', 'A2']))));
    await tester.pump();

    final fields = find.byType(TextField);
    // Name the SECOND passenger only — the lead is still blank.
    await tester.enterText(fields.at(1), 'Fatema Begum');
    await tester.enterText(fields.at(2), '01711000000');
    await tester.tap(find.text(const L(Lang.bn)('common.next')));
    await tester.pump();

    expect(find.text(const L(Lang.bn)('pax.needName')), findsOneWidget,
        reason: 'the booking still has to be in somebody\'s name');
  });

  /* ------------------------------------------------------- place picking */

  testWidgets('tapping a place field opens a searchable list, not a text box',
      (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    await tester.tap(find.text('ঢাকা'));
    await tester.pumpAndSettle();

    // Only places we actually run buses to, before anything is typed.
    expect(find.text('কুমিল্লা'), findsOneWidget);
    expect(find.text('বান্দরবান'), findsNothing,
        reason: 'an untyped list must not open with somewhere we do not serve');
  });

  testWidgets('a place we do not serve is offered, and says so', (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    await tester.tap(find.text('ঢাকা'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'বান্দর');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    expect(find.text('বান্দরবান'), findsOneWidget,
        reason: 'hiding a real district makes the field look broken to whoever lives there');
    expect(find.text(const L(Lang.bn)('place.noBuses')), findsWidgets,
        reason: 'and it has to say so before the passenger commits to the route');
  });

  testWidgets('choosing a place commits the canonical name, not the Bangla one',
      (tester) async {
    final state = await _state();
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    await tester.tap(find.text('চট্টগ্রাম'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('কুমিল্লা').last);
    await tester.pumpAndSettle();

    // The field reads Bangla...
    expect(find.text('কুমিল্লা'), findsOneWidget);
    // ...and the device remembered the canonical name, which is what a search
    // is built from. If these ever merge, every Bangla search stops resolving.
    expect(state.store.recentPlaces().first.name, 'Cumilla');
  });

  testWidgets('with no network the picker offers places used before', (tester) async {
    final state = await _state(
      placesFail: true,
      // The store separates the two names with U+0001. Written as an escape
      // rather than pasted in, because the character itself is invisible in a
      // diff and reads like corruption to whoever finds it next.
      recentPlaces: ['Sylhet\u0001সিলেট', 'Khulna\u0001খুলনা'],
    );
    await tester.pumpWidget(_wrap(state, const HomeScreen()));
    await tester.pump();

    await tester.tap(find.text('ঢাকা'));
    await tester.pumpAndSettle();

    expect(find.text('সিলেট'), findsOneWidget,
        reason: 'a picker that needs signal fails exactly where it is used');
    expect(find.text(const L(Lang.bn)('place.offline')), findsOneWidget,
        reason: 'and it should say the list is old rather than imply it is complete');
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

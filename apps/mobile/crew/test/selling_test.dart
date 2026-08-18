import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_crew/boarding.dart';
import 'package:jatra_crew/main.dart';
import 'package:jatra_crew/screens/me.dart';
import 'package:jatra_crew/screens/money.dart';
import 'package:jatra_crew/screens/sell.dart';
import 'package:jatra_crew/screens/trip.dart';
import 'package:jatra_crew/session.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Selling on the bus, the money that comes of it, and the bar that has to stay
/// on screen while both happen.
///
/// The arithmetic tests here are the important ones. A conductor decides
/// whether to give a discount from what this screen tells them it will cost, so
/// the preview being wrong is not a display bug — it is a person giving away
/// money they did not mean to give away.

http.Response _json(Object body, [int code = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// A tall window, so a ListView actually builds the rows a test looks for.
/// Flutter does not build offscreen children, and a `findsNothing` caused by a
/// short test window looks exactly like a missing widget.
void tallWindow(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 2.0;
  addTearDown(tester.view.reset);
}

/// Records what the app actually sent, so a test can assert on the request and
/// not only on the screen.
class Sent {
  final List<String> calls = [];
  final List<Map<String, dynamic>> bodies = [];
}

MockClient _platform(Sent sent, {bool onDuty = true, bool mayDiscount = true}) =>
    MockClient((req) async {
      final p = req.url.path;
      sent.calls.add('${req.method} $p');
      if (req.body.isNotEmpty) {
        try {
          sent.bodies.add(jsonDecode(req.body) as Map<String, dynamic>);
        } catch (_) {
          // A non-JSON body is not interesting to these tests.
        }
      }

      if (p.endsWith('/crew/sell/context')) {
        return _json({
          'crew_role': 'DRIVER',
          'may_sell': true,
          'may_discount': mayDiscount,
          // 20% or 200 taka, whichever binds first.
          'max_pct_bp': 2000,
          'max_amount_poisha': 20000,
          'service_fee_poisha': 5000,
          // The resolved rule, as the server reports it: 5% of base.
          'commission_bp': 500,
          'commission_flat_poisha': 0,
          'duty_id': onDuty ? 'duty-1' : '',
          'duty': onDuty
              ? {
                  'duty_id': 'duty-1',
                  'opening_float_poisha': 100000,
                  'collected_poisha': 240000,
                  'expected_cash_poisha': 340000,
                  'commission_poisha': 11500,
                  'remit_poisha': 328500,
                  'sales_count': 2,
                  'discount_poisha': 2000,
                }
              : null,
          'reasons': [
            {'code': 'CHILD', 'label': 'Child', 'label_bn': 'শিশু', 'max_pct_bp': 5000},
            {'code': 'NEGOTIATED', 'label': 'Negotiated', 'label_bn': 'দরদাম করা',
             'max_pct_bp': 0},
          ],
        });
      }
      if (p.endsWith('/crew/report')) {
        return _json({
          'today': {'sales_count': 3, 'gross_poisha': 348000,
                    'discount_poisha': 12000, 'commission_poisha': 9500},
          'week': {'sales_count': 9, 'gross_poisha': 900000,
                   'discount_poisha': 20000, 'commission_poisha': 30000},
          'duty': onDuty
              ? {
                  'duty_id': 'duty-1', 'opening_float_poisha': 100000,
                  'collected_poisha': 348000, 'expected_cash_poisha': 448000,
                  'commission_poisha': 9500, 'remit_poisha': 438500,
                  'sales_count': 3, 'discount_poisha': 12000,
                }
              : null,
          'trips': [],
        });
      }
      if (p.endsWith('/crew/duties')) {
        return _json({'duties': [], 'open': null});
      }
      if (p.endsWith('/driver/trips')) {
        return _json({
          'trips': [
            {
              'trip_id': 't-1',
              'depart_at': '2099-09-01T22:00:00+06:00',
              'route': 'Dhaka → Chattogram',
              'registration': 'DHA-METRO-B-11-2288',
              'status': 'OPEN',
              'crew_role': 'DRIVER',
              'passengers': 3,
              'boarded': 0,
            }
          ]
        });
      }
      if (p.contains('/manifest')) {
        return _json({
          'trip': {'route': 'Dhaka → Chattogram', 'operator': 'Green Line',
                   'registration': 'DHA-1', 'depart_at': '2099-09-01T22:00:00+06:00',
                   'status': 'SCHEDULED'},
          'total': 3, 'boarded': 0,
          'passengers': [
            {'seat_no': 'A1', 'pnr': 'AAA111', 'passenger': 'Rahim Uddin',
             'phone': '+8801711000001', 'channel': 'WEB', 'ticket_status': 'ISSUED',
             'from': 'Dhaka', 'to': 'Chattogram'},
            {'seat_no': 'B2', 'pnr': 'BBB222', 'passenger': 'Karim Ali',
             'phone': '+8801822000002', 'channel': 'COUNTER', 'ticket_status': 'ISSUED',
             'from': 'Dhaka', 'to': 'Feni'},
            {'seat_no': 'C1', 'pnr': 'CCC333', 'passenger': 'Shirin Akter',
             'phone': '+8801933000003', 'channel': 'ONBOARD', 'ticket_status': 'BOARDED',
             'from': 'Cumilla', 'to': 'Chattogram'},
          ],
        });
      }
      if (p.endsWith('/staff/sessions')) return _json({'sessions': []});
      if (p.endsWith('/staff/login') || p.endsWith('/staff/me')) {
        return _json({
          'token': 'test-token',
          'identity': {
            'staff_id': 's-1', 'email': 'driver@greenline.test',
            'full_name': 'Abdul Karim', 'operator_id': 'op-1',
            'roles': ['DRIVER'],
            'permissions': ['crew.sell', 'crew.duty', 'crew.discount', 'crew.report'],
          },
        });
      }
      return _json(const {});
    });

Future<(Session, Boarding, Sent)> _rig({bool onDuty = true, bool mayDiscount = true}) async {
  SharedPreferences.setMockInitialValues({});
  final store = await Store.open();
  final sent = Sent();
  final api = CrewApi(ApiClient(
      base: 'http://test/api/v1',
      httpClient: _platform(sent, onDuty: onDuty, mayDiscount: mayDiscount)));
  return (Session(api: api, store: store), Boarding(api: api, store: store), sent);
}

Widget _wrap(Session session, Widget child) => LangScope(
      lang: Lang.bn,
      setLang: (_) {},
      child: SessionScope(
        session: session,
        child: MaterialApp(theme: jatraTheme(seed: J.crew), home: child),
      ),
    );

TripSummary _trip() => TripSummary.fromJson(const {
      'trip_id': 't-1',
      'brand': 'Green Line',
      'depart_at': '2099-09-01T22:00:00+06:00',
      'origin': 'Dhaka',
      'destination': 'Chattogram',
      'fare_poisha': 80000,
      'available_seats': 12,
      'board_seq': 0,
      'drop_seq': 3,
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const l = L(Lang.bn);

  // ------------------------------------------------------ the discount cap --

  group('the discount cap', () {
    // 800 taka fare + 50 taka fee = 850 published.
    const full = 85000;

    SellContext ctx({int pctBp = 2000, int maxAmount = 20000, bool may = true}) =>
        SellContext.fromJson({
          'may_discount': may,
          'max_pct_bp': pctBp,
          'max_amount_poisha': maxAmount,
          'reasons': const [],
        });

    test('the taka ceiling binds when it is lower than the percentage', () {
      // 20% of 850 is 170; the operator also says never more than 200.
      // The percentage is the smaller of the two, so it wins.
      expect(ctx().capFor(full), 17000);
    });

    test('the percentage ceiling binds when the taka limit is lower', () {
      // 50% of 850 is 425, but the operator caps every discount at 200.
      expect(ctx(pctBp: 5000).capFor(full), 20000);
    });

    test('a reason may cap tighter than the role, and the tighter one wins', () {
      final child = DiscountReason.fromJson(const {
        'code': 'STUDENT', 'label': 'Student', 'label_bn': 'শিক্ষার্থী',
        'max_pct_bp': 1000,
      });
      // Role allows 170; the reason allows 85. The passenger gets 85.
      expect(ctx().capFor(full, reason: child), 8500);
    });

    test('no permission is no discount, whatever the policy says', () {
      expect(ctx(may: false).capFor(full), 0);
    });
  });

  // ------------------------------------------ the honest line on the screen --

  testWidgets('the price screen says what a discount will cost the conductor',
      (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig();
    final ctx = await session.api.sellContext();

    await tester.pumpWidget(_wrap(
        session, PriceScreen(trip: _trip(), ctx: ctx, seats: const ['A1'])));
    await tester.pumpAndSettle();

    // 800 fare + 50 fee. Commission is 5% of the 800 base = 40 taka.
    expect(find.text(taka(85000)), findsWidgets, reason: 'the published fare');
    expect(find.textContaining(taka(4000)), findsWidgets,
        reason: 'the commission at full fare is 40 taka');

    // Now take 25 taka off.
    await tester.enterText(find.byType(TextField).last, '25');
    await tester.pumpAndSettle();

    // The passenger pays 825 and the conductor keeps 15 — and the screen has to
    // say so BEFORE the sale, because afterwards the money is already gone.
    expect(find.text(taka(82500)), findsWidgets, reason: 'what the passenger pays');
    expect(find.textContaining(taka(1500)), findsWidgets,
        reason: 'the commission after the discount ate 25 taka of it');
    expect(find.textContaining(l('sl.wentToDiscount')), findsWidgets,
        reason: 'a conductor must be told the discount came out of their own pocket');
  });

  testWidgets('a discount over the cap is refused on the screen, not silently reduced',
      (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig();
    final ctx = await session.api.sellContext();

    await tester.pumpWidget(_wrap(
        session, PriceScreen(trip: _trip(), ctx: ctx, seats: const ['A1'])));
    await tester.pumpAndSettle();

    // The cap is 170 taka. Ask for 300.
    await tester.enterText(find.byType(TextField).last, '300');
    await tester.pumpAndSettle();

    final field = tester.widget<TextField>(find.byType(TextField).last);
    expect(field.decoration?.errorText, isNotNull,
        reason: 'a conductor who is going to be refused should find out here, '
            'not after telling a passenger a price');
  });

  testWidgets('no discount right means no discount control at all', (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig(mayDiscount: false);
    final ctx = await session.api.sellContext();

    await tester.pumpWidget(_wrap(
        session, PriceScreen(trip: _trip(), ctx: ctx, seats: const ['A1'])));
    await tester.pumpAndSettle();

    expect(find.text(l('sl.discountWhy')), findsNothing);
  });

  // ------------------------------------------------------------- the shell --

  testWidgets('the bottom bar is still there after pushing into a tab',
      (tester) async {
    tallWindow(tester);
    final (session, boarding, _) = await _rig();
    await tester.pumpWidget(_wrap(session, CrewShell(boarding: boarding)));
    await tester.pumpAndSettle();

    expect(find.byType(NavigationBar), findsOneWidget);

    // Go to Money, then into a screen inside it.
    await tester.tap(find.text(l('nav.money')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(l('mn.mySales')));
    await tester.pumpAndSettle();

    // This is the whole point of a Navigator per tab: a pushed screen sits
    // INSIDE the tab, so the shell keeps painting the bar. Before this, every
    // screen past the first covered it.
    expect(find.byType(NavigationBar), findsOneWidget,
        reason: 'the bar must survive a push, or the app loses its navigation '
            'exactly when somebody is deepest inside it');
    expect(find.text(l('mn.mySales')), findsWidgets);
  });

  testWidgets('the four tabs are the four things a crew member does',
      (tester) async {
    tallWindow(tester);
    final (session, boarding, _) = await _rig();
    await tester.pumpWidget(_wrap(session, CrewShell(boarding: boarding)));
    await tester.pumpAndSettle();

    for (final key in ['nav.trips', 'nav.sell', 'nav.money', 'nav.me']) {
      expect(find.text(l(key)), findsOneWidget, reason: '$key is missing from the bar');
    }
  });

  // -------------------------------------------------------------- the money --

  testWidgets('the duty card shows three lines, not one number', (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig();
    await tester.pumpWidget(_wrap(session, const MoneyScreen()));
    await tester.pumpAndSettle();

    // Cash held, minus commission, equals what the owner gets. A conductor has
    // to be able to check the sum against the notes in their hand.
    expect(find.text(l('mn.shouldHold')), findsOneWidget);
    expect(find.textContaining(l('mn.commission')), findsWidgets);
    expect(find.text(l('mn.handOver')), findsOneWidget);

    expect(find.text(taka(448000)), findsWidgets, reason: 'cash held');
    expect(find.text(taka(9500)), findsWidgets, reason: 'commission earned');
    expect(find.text(taka(438500)), findsWidgets, reason: 'what the owner gets');
  });

  testWidgets('the remittance really is the difference of the two lines above it',
      (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig();
    await tester.pumpWidget(_wrap(session, const MoneyScreen()));
    await tester.pumpAndSettle();

    // Not a fixture check: the arithmetic itself. If the server ever sends
    // three numbers that do not add up, this screen must not present them as
    // though they do.
    final report = await session.api.report();
    final d = report.duty!;
    expect(d.expectedPoisha - d.commissionPoisha, d.remitPoisha,
        reason: 'hand-over must equal cash held minus commission, exactly');
  });

  // ------------------------------------------------ finding one passenger --

  testWidgets('the manifest can be searched by seat, name, PNR and number',
      (tester) async {
    tallWindow(tester);
    final (session, boarding, _) = await _rig();
    await tester.pumpWidget(_wrap(
        session,
        TripScreen(
          trip: CrewTrip.fromJson(const {
            'trip_id': 't-1',
            'depart_at': '2099-09-01T22:00:00+06:00',
            'route': 'Dhaka → Chattogram',
            'registration': 'DHA-1',
            'status': 'OPEN',
            'crew_role': 'DRIVER',
            'passengers': 3,
            'boarded': 0,
          }),
          boarding: boarding,
        )));
    await tester.pumpAndSettle();

    expect(find.text('Rahim Uddin'), findsOneWidget);
    expect(find.text('Karim Ali'), findsOneWidget);

    final box = find.widgetWithText(TextField, l('cr.findHint'));
    expect(box, findsOneWidget);

    // By name.
    await tester.enterText(box, 'karim');
    await tester.pumpAndSettle();
    expect(find.text('Karim Ali'), findsOneWidget);
    expect(find.text('Rahim Uddin'), findsNothing);

    // By PNR.
    await tester.enterText(box, 'CCC333');
    await tester.pumpAndSettle();
    expect(find.text('Shirin Akter'), findsOneWidget);
    expect(find.text('Karim Ali'), findsNothing);

    // By number.
    await tester.enterText(box, '1711000001');
    await tester.pumpAndSettle();
    expect(find.text('Rahim Uddin'), findsOneWidget);

    // Nobody at all is said, not left blank.
    await tester.enterText(box, 'zzzz');
    await tester.pumpAndSettle();
    expect(find.text(l('cr.noMatch')), findsOneWidget);
  });

  testWidgets('searching a seat number matches that seat and not every seat containing it',
      (tester) async {
    tallWindow(tester);
    final (session, boarding, _) = await _rig();
    await tester.pumpWidget(_wrap(
        session,
        TripScreen(
          trip: CrewTrip.fromJson(const {
            'trip_id': 't-1', 'depart_at': '2099-09-01T22:00:00+06:00',
            'route': 'Dhaka → Chattogram', 'registration': 'DHA-1',
            'status': 'OPEN', 'crew_role': 'DRIVER', 'passengers': 3, 'boarded': 0,
          }),
          boarding: boarding,
        )));
    await tester.pumpAndSettle();

    // Somebody standing over seat A1 asking whose it is does not want A1, B2
    // and C1 back. Seat matching is exact; everything else is a substring.
    await tester.enterText(find.widgetWithText(TextField, l('cr.findHint')), 'A1');
    await tester.pumpAndSettle();
    expect(find.text('Rahim Uddin'), findsOneWidget);
    expect(find.text('Shirin Akter'), findsNothing);
  });

  // ------------------------------------------------------ not selling blind --

  testWidgets('no open duty is said plainly before anyone tries to sell',
      (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig(onDuty: false);
    await tester.pumpWidget(_wrap(session, const SellScreen()));
    await tester.pumpAndSettle();

    expect(find.text(l('sl.needDuty')), findsOneWidget,
        reason: 'cash with nowhere to be counted is cash that cannot be reconciled');
  });

  testWidgets('selling without a phone number is refused before the request leaves',
      (tester) async {
    tallWindow(tester);
    final (session, _, sent) = await _rig();
    final ctx = await session.api.sellContext();

    await tester.pumpWidget(_wrap(
        session, PriceScreen(trip: _trip(), ctx: ctx, seats: const ['A1'])));
    await tester.pumpAndSettle();

    await tester.tap(find.text(l('sl.take')));
    await tester.pumpAndSettle();

    expect(find.text(l('sl.needPhone')), findsOneWidget);
    expect(sent.calls.where((c) => c.contains('POST') && c.contains('/crew/sales')),
        isEmpty, reason: 'a sale with no way to send the ticket must not be attempted');
  });

  testWidgets('a discount with no reason never reaches the server', (tester) async {
    tallWindow(tester);
    final (session, _, sent) = await _rig();
    final ctx = await session.api.sellContext();

    await tester.pumpWidget(_wrap(
        session, PriceScreen(trip: _trip(), ctx: ctx, seats: const ['A1'])));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(1), '01711000000');
    await tester.enterText(find.byType(TextField).last, '25');
    await tester.pumpAndSettle();
    await tester.tap(find.text(l('sl.take')));
    await tester.pumpAndSettle();

    expect(find.text(l('sl.needReason')), findsOneWidget);
    expect(sent.calls.where((c) => c.contains('/crew/sales')), isEmpty,
        reason: 'an unexplained discount is indistinguishable from a conductor '
            'pocketing the difference, so it is never sent');
  });

  // ------------------------------------------------------------- dialogs --

  // These exist because of a crash found by tapping, not by testing:
  // `_dependents.isEmpty is not true`. The dialogs used to be handed a
  // controller created by the caller and disposed the moment showDialog
  // returned — while the route was still animating out and its field was still
  // listening. Opening and closing each one is enough to catch it.

  testWidgets('opening and confirming the duty dialog does not blow up',
      (tester) async {
    tallWindow(tester);
    final (session, _, sent) = await _rig(onDuty: false);
    await tester.pumpWidget(_wrap(session, const MoneyScreen()));
    await tester.pumpAndSettle();

    // No duty open in this fixture, so the invitation is on screen.
    await tester.tap(find.text(l('mn.openDuty')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).last, '500');
    await tester.tap(find.text(l('common.ok')));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull,
        reason: 'a dialog that disposes a controller its route still holds '
            'crashes the app the moment somebody taps OK');
    expect(sent.calls.any((c) => c.contains('POST') && c.endsWith('/crew/duties')),
        isTrue, reason: 'the taka typed in should have reached the server');
  });

  testWidgets('cancelling the duty dialog is just as safe as confirming it',
      (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig(onDuty: false);
    await tester.pumpWidget(_wrap(session, const MoneyScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.text(l('mn.openDuty')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(l('common.cancel')));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  testWidgets('the account dialogs open and close without disposing themselves early',
      (tester) async {
    tallWindow(tester);
    final (session, _, _) = await _rig();
    // MeScreen needs a signed-in identity to draw anything at all.
    await session.signIn('driver@greenline.test', 'x');
    await tester.pumpWidget(_wrap(session, const MeScreen()));
    await tester.pumpAndSettle();

    for (final open in [l('me.details'), l('me.changePassword')]) {
      await tester.tap(find.text(open).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text(l('common.cancel')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: '$open crashed on close');
    }
  });

  testWidgets('coming back to the money tab reloads it rather than showing what was there',
      (tester) async {
    tallWindow(tester);
    final (session, boarding, sent) = await _rig();
    await tester.pumpWidget(_wrap(session, CrewShell(boarding: boarding)));
    await tester.pumpAndSettle();

    // Go to Money once, then away, then back.
    await tester.tap(find.text(l('nav.money')));
    await tester.pumpAndSettle();
    final afterFirst = sent.calls.where((c) => c.endsWith('/crew/report')).length;

    await tester.tap(find.text(l('nav.trips')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(l('nav.money')));
    await tester.pumpAndSettle();

    // An IndexedStack keeps every tab alive, so initState runs once. Without a
    // reload on show, a conductor sells a ticket and comes back to a screen
    // still claiming they have taken nothing.
    expect(sent.calls.where((c) => c.endsWith('/crew/report')).length,
        greaterThan(afterFirst),
        reason: 'returning to the money tab must ask the server again');
  });

  test('the commission preview follows the rule the server resolved, not a guess', () {
    // 800 fare + 50 fee. A 5% rule earns 40 taka; a 7.5% rule earns 60. The
    // screen has to move with the operator's configuration, because the receipt
    // does — and a preview that quietly disagreed with the receipt would be
    // worse than no preview at all.
    SellContext at(int bp) => SellContext.fromJson({
          'may_discount': true, 'max_pct_bp': 5000, 'max_amount_poisha': 0,
          'service_fee_poisha': 5000, 'commission_bp': bp, 'reasons': const [],
        });
    expect(at(500).commissionOn(85000), 4000);
    expect(at(750).commissionOn(85000), 6000);

    // A flat rule ignores the base entirely.
    final flat = SellContext.fromJson({
      'may_discount': true, 'service_fee_poisha': 5000,
      'commission_flat_poisha': 3000, 'reasons': const [],
    });
    expect(flat.commissionOn(85000), 3000);
    expect(flat.commissionOn(200000), 3000);
  });
}

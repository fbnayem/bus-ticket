import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_owner/owner_api.dart';
import 'package:jatra_owner/screens/costs.dart';
import 'package:jatra_owner/screens/pnl.dart';
import 'package:jatra_owner/screens/sign_in.dart';
import 'package:jatra_owner/screens/staff_sales.dart';
import 'package:jatra_owner/session.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Mounting the owner screens against a stand-in platform. The fixtures copy
/// the real endpoints' field names — the crew app once learned the hard way
/// that a test agreeing with the app while both disagree with the server is
/// worse than no test.

http.Response _json(Object body, [int code = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// A P&L where the first bus profits and the second makes a loss, so the loss
/// path is actually exercised rather than assumed.
MockClient _platform() => MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('/owner/pnl')) {
        return _json({
          'buses': [
            {
              'bus_id': 'b-1', 'registration': 'DHAKA METRO-7788', 'bookings': 283,
              'gross_poisha': 32337875, 'platform_commission_poisha': 4531500,
              'staff_commission_poisha': 610825, 'net_fare_poisha': 27195550,
              'fuel_poisha': 3570000, 'maintenance_poisha': 640000, 'wages_poisha': 1200000,
              'other_poisha': 538000, 'costs_poisha': 5948000, 'profit_poisha': 21247550,
            },
            {
              'bus_id': 'b-2', 'registration': 'DHAKA METRO-2233', 'bookings': 4,
              'gross_poisha': 200000, 'platform_commission_poisha': 25000,
              'staff_commission_poisha': 0, 'net_fare_poisha': 175000,
              'fuel_poisha': 900000, 'maintenance_poisha': 0, 'wages_poisha': 0,
              'other_poisha': 0, 'costs_poisha': 900000, 'profit_poisha': -725000,
            },
          ],
          'overhead': {'costs_poisha': 0},
          'totals': {
            'bookings': 287, 'gross_poisha': 32537875, 'platform_commission_poisha': 4556500,
            'staff_commission_poisha': 610825, 'net_fare_poisha': 27370550,
            'costs_poisha': 6848000, 'profit_poisha': 20522550,
          },
        });
      }
      if (p.endsWith('/owner/sales-by-staff')) {
        return _json({
          'staff': [
            {'staff_id': 's-1', 'full_name': 'Jamal Uddin', 'roles': 'COUNTER_AGENT',
             'tickets': 203, 'gross_poisha': 20680000, 'discount_poisha': 0, 'commission_poisha': 0},
            {'staff_id': 's-2', 'full_name': 'Abdul Karim', 'roles': 'DRIVER',
             'tickets': 97, 'gross_poisha': 11349800, 'discount_poisha': 50000, 'commission_poisha': 299800},
          ],
          'totals': {'tickets': 300, 'gross_poisha': 32029800, 'discount_poisha': 50000, 'commission_poisha': 299800},
        });
      }
      if (p.endsWith('/owner/costs')) {
        return _json({
          'costs': [
            {'expense_id': 'e-1', 'registration': 'DHAKA METRO-7788', 'bus_id': 'b-1',
             'category': 'FUEL', 'amount_poisha': 1850000, 'incurred_on': '2026-08-16',
             'note': 'Diesel, Dhaka depot', 'recorded_by': 'Kamrul'},
          ],
          'total_poisha': 1850000,
        });
      }
      if (p.endsWith('/operator/buses')) {
        return _json({'buses': [
          {'bus_id': 'b-1', 'registration': 'DHAKA METRO-7788'},
          {'bus_id': 'b-2', 'registration': 'DHAKA METRO-2233'},
        ]});
      }
      return _json(const {});
    });

Future<Session> _rig() async {
  SharedPreferences.setMockInitialValues({});
  final store = await Store.open();
  final api = OwnerApi(ApiClient(base: 'http://test/api/v1', httpClient: _platform()));
  return Session(api: api, store: store);
}

Widget _wrap(Session session, Widget child) => LangScope(
      lang: Lang.bn,
      setLang: (_) {},
      child: SessionScope(
        session: session,
        child: MaterialApp(theme: jatraTheme(seed: J.owner), home: child),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the sign-in screen asks for the two things it needs', (tester) async {
    final session = await _rig();
    await tester.pumpWidget(_wrap(session, const SignInScreen()));
    await tester.pump();
    const l = L(Lang.bn);
    expect(find.text(l('cr.email')), findsOneWidget);
    expect(find.text(l('cr.password')), findsOneWidget);
    expect(find.text(l('cr.code')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the P&L shows each bus and its profit or loss', (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final session = await _rig();
    await tester.pumpWidget(_wrap(session, PnlScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('DHAKA METRO-7788'), findsOneWidget);
    expect(find.text('DHAKA METRO-2233'), findsOneWidget);
    // The profitable bus's profit and the loss-making bus's loss both appear,
    // the loss carrying a minus that the colour alone does not have to convey.
    expect(find.text('৳212,475'), findsOneWidget);
    expect(find.text('−৳7,250'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a negative profit is drawn in the danger colour, not just signed',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final session = await _rig();
    await tester.pumpWidget(_wrap(session, PnlScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final loss = tester.widget<Text>(find.text('−৳7,250'));
    expect(loss.style?.color, J.danger,
        reason: 'a loss a tired owner reads at midnight must not depend on spotting a minus');
  });

  testWidgets('sales-by-staff lists who sold and what they earned', (tester) async {
    final session = await _rig();
    await tester.pumpWidget(_wrap(session, StaffSalesScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Jamal Uddin'), findsOneWidget);
    expect(find.text('Abdul Karim'), findsOneWidget);
    // The driver's gross and commission are shown; the counter clerk earns no
    // commission, so none is shown for them.
    expect(find.text('৳113,498'), findsOneWidget);
    expect(find.textContaining('৳2,998'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('recording zero taka is refused before any request leaves',
      (tester) async {
    final session = await _rig();
    await tester.pumpWidget(_wrap(session, CostsScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    const l = L(Lang.bn);
    // Open the record sheet and submit with an empty amount.
    await tester.tap(find.text(l('own.costs.record')).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text(l('own.costs.add')));
    await tester.pump();
    expect(find.text(l('own.costs.badAmount')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

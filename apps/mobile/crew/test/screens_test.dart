import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:jatra_crew/boarding.dart';
import 'package:jatra_crew/screens/sign_in.dart';
import 'package:jatra_crew/screens/trips.dart';
import 'package:jatra_crew/session.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Mounting the crew screens.
///
/// Same reason as the passenger app's: the analyzer is happy with
/// `SessionScope.of(context)` inside `initState`, and Flutter is not. Only
/// pumping a widget finds it.

http.Response _json(Object body, [int code = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

MockClient _platform() => MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('/driver/trips')) {
        return _json({
          'trips': [
            {
              'trip_id': 't-1',
              'depart_at': '2099-09-01T22:00:00+06:00',
              'route': 'Dhaka → Chattogram',
              'registration': 'DHA-METRO-B-11-2288',
              'status': 'SCHEDULED',
              'role': 'DRIVER',
            }
          ]
        });
      }
      if (p.contains('/manifest')) {
        return _json({
          'trip': {'route': 'Dhaka → Chattogram', 'operator': 'Green Line',
                   'registration': 'DHA-1', 'depart_at': '2099-09-01T22:00:00+06:00',
                   'status': 'SCHEDULED'},
          'total': 0, 'boarded': 0, 'passengers': [],
        });
      }
      return _json(const {});
    });

Future<(Session, Boarding)> _rig() async {
  SharedPreferences.setMockInitialValues({});
  final store = await Store.open();
  final api = CrewApi(ApiClient(base: 'http://test/api/v1', httpClient: _platform()));
  return (Session(api: api, store: store), Boarding(api: api, store: store));
}

Widget _wrap(Session session, Widget child) => LangScope(
      lang: Lang.bn,
      setLang: (_) {},
      child: SessionScope(
        session: session,
        child: MaterialApp(theme: jatraTheme(seed: J.crew), home: child),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the sign-in screen mounts and asks for the two things it needs',
      (tester) async {
    final (session, _) = await _rig();
    await tester.pumpWidget(_wrap(session, const SignInScreen()));
    await tester.pump();

    const l = L(Lang.bn);
    expect(find.text(l('cr.email')), findsOneWidget);
    expect(find.text(l('cr.password')), findsOneWidget);
    // Not offered until the platform says this account has one.
    expect(find.text(l('cr.code')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the roster mounts and puts the departure time first',
      (tester) async {
    final (session, boarding) = await _rig();
    await tester.pumpWidget(_wrap(session, TripsScreen(boarding: boarding)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('22:00'), findsOneWidget,
        reason: 'the time is the question a driver at a terminal is asking');
    expect(find.text('Dhaka → Chattogram'), findsOneWidget);
    expect(find.text(const L(Lang.bn)('cr.role.DRIVER')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('nothing queued means no queue bar', (tester) async {
    final (session, boarding) = await _rig();
    await tester.pumpWidget(_wrap(session, TripsScreen(boarding: boarding)));
    await tester.pump();

    expect(find.byType(QueueBar), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a check taken without a line raises the queue bar', (tester) async {
    SharedPreferences.setMockInitialValues({
      'jatra.scan.queue': [jsonEncode({'client_ref': 'scan-1', 'trip_id': 't-1', 'pnr': 'K7W4VP'})],
    });
    final store = await Store.open();
    final api = CrewApi(ApiClient(base: 'http://test/api/v1', httpClient: _platform()));
    final session = Session(api: api, store: store);
    final boarding = Boarding(api: api, store: store);

    await tester.pumpWidget(_wrap(session, TripsScreen(boarding: boarding)));
    await tester.pump();

    expect(find.byType(QueueBar), findsOneWidget);
    expect(find.text(const L(Lang.bn)('sc.waiting1')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

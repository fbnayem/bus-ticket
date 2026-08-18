import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:jatra_core/jatra_core.dart';

/// What the apps do when something goes wrong that nobody planned for.
///
/// Two separate obligations, and a test for each: the person holding the phone
/// gets a sentence instead of a red stack trace, and somebody at the office
/// finds out it happened.

http.Response _ok(Object body, [int code = 202]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)), code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// Records what actually left the phone.
class _Sink {
  final List<Map<String, dynamic>> reports = [];
  late final ApiClient client = ApiClient(
    base: 'http://test/api/v1',
    httpClient: MockClient((req) async {
      if (req.url.path.endsWith('/client-errors')) {
        reports.add(jsonDecode(req.body) as Map<String, dynamic>);
        return _ok(const {});
      }
      return _ok(const {});
    }),
  );
}

void main() {
  testWidgets('what replaces the red screen is a sentence, not a stack trace',
      (tester) async {
    // The screen itself, pumped directly. CrashGuard installs it as
    // ErrorWidget.builder; what a conductor sees is this widget, and testing it
    // here keeps the test out of a wrestle with the harness's own bookkeeping
    // about who is allowed to replace that builder.
    await tester.pumpWidget(const MaterialApp(
      home: CrashScreen(
        details: FlutterErrorDetails(exception: 'StateError: the manifest exploded'),
      ),
    ));
    await tester.pump();

    // Flutter's own error widget renders the exception text on screen. A
    // conductor at a roadside stop reading "StateError: the manifest exploded"
    // learns nothing they can act on.
    expect(find.text(kStrings['crash.title']!(Lang.bn)), findsOneWidget);
    expect(find.textContaining('StateError: the manifest exploded'), findsNothing,
        reason: 'the raw exception must not be the headline');

    // It is available, folded away, for the person the conductor rings.
    expect(find.text(kStrings['crash.detail']!(Lang.bn)), findsOneWidget);
  });

  testWidgets('and the office is told, with enough to act on', (tester) async {
    final sink = _Sink();
    CrashGuard.currentScreen = 'sell/price';
    final guard = CrashGuard(app: 'crew', client: sink.client, version: '1.4.0');
    await guard.report(StateError('boom'), StackTrace.current);

    expect(sink.reports, hasLength(1));
    final r = sink.reports.single;
    expect(r['app'], 'crew');
    expect(r['app_version'], '1.4.0',
        reason: 'a bug has to be tied to a release, not to "the version in June"');
    expect(r['screen'], 'sell/price',
        reason: 'a stack names our functions; this names where somebody stood');
    expect(r['kind'], 'StateError');
    expect((r['stack'] as String).isNotEmpty, isTrue);
    expect((r['fingerprint'] as String).isNotEmpty, isTrue);
  });

  test('the same fault is reported once per run, not once per frame', () async {
    final sink = _Sink();
    final guard = CrashGuard(app: 'crew', client: sink.client);
    final trace = StackTrace.current;
    for (var i = 0; i < 50; i++) {
      await guard.report(StateError('a build loop'), trace);
    }
    expect(sink.reports, hasLength(1),
        reason: 'a widget that throws on every frame would otherwise be a '
            'denial of service we wrote ourselves');
  });

  test('the fingerprint groups by fault, not by passenger', () async {
    final sink = _Sink();
    final guard = CrashGuard(app: 'crew', client: sink.client);
    final trace = StackTrace.current;

    // The same bug, hit by two passengers. The message differs; the fault does
    // not. Grouping on the message would file it once per passenger — and would
    // put a PNR and a seat number into the grouping key.
    await guard.report(StateError('seat A1 for PNR ABC123'), trace);
    await guard.report(StateError('seat B2 for PNR XYZ789'), trace);

    expect(sink.reports, hasLength(1),
        reason: 'two reports of one bug should be one row with a count of two');
    expect(sink.reports.single['fingerprint'], isNot(contains('ABC123')));
    expect(sink.reports.single['fingerprint'], isNot(contains('A1')));
  });

  test('a report that cannot be sent does not become a second crash', () async {
    final dead = ApiClient(
      base: 'http://test/api/v1',
      httpClient: MockClient((_) async => throw Exception('no network on a bus')),
    );
    final guard = CrashGuard(app: 'crew', client: dead);
    // The whole point: this must complete rather than throw. An exception out
    // of the error handler replaces a bug we could have fixed with one we
    // cannot see.
    await guard.report(StateError('boom'), StackTrace.current);
  });
}

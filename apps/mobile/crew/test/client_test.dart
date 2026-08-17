import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jatra_core/jatra_core.dart';

/// The transport, and the two questions it has to keep straight.
///
/// **What kind of 401 is this?** The platform answers 401 to an expired session
/// *and* to a sign-in it is refusing, and those are opposite events. The client
/// used to throw one sentence for both and drop the body. Somebody who mistyped
/// a password was told their session had ended, when they had never had one —
/// and `mfa_required`, which the platform sends as a 401, never reached the
/// screen watching for it, so the six-digit field never appeared and an account
/// with MFA turned on could not sign in by any route.
///
/// **Whose words does a person read?** This file cannot speak Bangla and should
/// never try; it carries a code, and `L.error` does the talking. The apps are
/// Bangla for people who work in Bangla, and the moment they must not fall back
/// to English is the moment something has gone wrong.

http.Response _fail(int code, String err, String message) => http.Response.bytes(
      utf8.encode(jsonEncode({'error': err, 'message': message})),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

ApiClient _client(http.Response Function(http.BaseRequest) answer) => ApiClient(
      base: 'http://test/api/v1',
      httpClient: MockClient((req) async => answer(req)),
    );

Future<ApiError> _errorFrom(Future<void> Function() f) async {
  try {
    await f();
  } on ApiError catch (e) {
    return e;
  }
  fail('expected the call to be refused');
}

void main() {
  group('a 401 with no session is an answer, not an eviction', () {
    test('mfa_required survives the trip to the caller', () async {
      final c = _client((_) => _fail(
          401, 'mfa_required', 'Enter the six-digit code from your authenticator app.'));

      final e = await _errorFrom(() => c.post('/staff/login', body: const {}));

      // The code is the whole point: it is what raises the six-digit field.
      expect(e.code, 'mfa_required',
          reason: 'swallowing this locks every MFA account out of the app');
      expect(e.status, 401);
    });

    test('a wrong password says so, and does not evict a session', () async {
      var signedOut = false;
      final c = _client((_) =>
          _fail(401, 'bad_credentials', 'That email and password do not match.'))
        ..onUnauthenticated = () => signedOut = true;

      final e = await _errorFrom(() => c.post('/staff/login', body: const {}));

      expect(e.code, 'bad_credentials');
      expect(signedOut, isFalse,
          reason: 'there was no session to end — nobody was signed in');
    });
  });

  group('a 401 while holding a token really is the session ending', () {
    test('the token is dropped and the app is told', () async {
      var signedOut = false;
      final c = _client((_) => _fail(401, 'unauthenticated', 'Please sign in again.'))
        ..bearer = 'a-token-that-has-expired'
        ..onUnauthenticated = () => signedOut = true;

      await _errorFrom(() => c.get('/driver/trips'));

      expect(c.bearer, isNull, reason: 'a token the platform rejects is not kept');
      expect(signedOut, isTrue);
    });

    test('an empty-bodied 401 still reads as the session ending', () async {
      final c = _client((_) => http.Response('', 401))..bearer = 'expired';
      final e = await _errorFrom(() => c.get('/driver/trips'));
      expect(e.code, 'unauthenticated');
    });
  });

  group('the words a person actually reads', () {
    test('the transport\'s own failures are translated, not passed through', () {
      // These carry English only for a log file. What reaches a screen is
      // whatever the catalogue says in the reader's language.
      const bn = L(Lang.bn);
      final offline = ApiError(0, 'network', 'We could not reach the service.');

      expect(bn.error(offline), bn('err.network'));
      expect(bn.error(offline), isNot(contains('service')),
          reason: 'the fallback English must not reach a Bangla screen');
      expect(const L(Lang.en).error(offline), const L(Lang.en)('err.network'));
    });

    test('the platform\'s sign-in vocabulary is translated too', () {
      const bn = L(Lang.bn);
      for (final code in [
        'bad_credentials', 'mfa_required', 'mfa_invalid', 'mfa_replayed',
        'unauthenticated', 'timeout', 'refused', 'bad_response',
      ]) {
        final shown = bn.error(ApiError(401, code, 'some English from the server'));
        expect(shown, bn('err.$code'), reason: '$code should be spoken in Bangla');
        expect(shown, isNot('some English from the server'));
      }
    });

    test('a specific refusal the catalogue does not know is preferred to a shrug', () {
      // A named seat beats a correctly translated generic sentence.
      const bn = L(Lang.bn);
      final specific = ApiError(409, 'seat_gone', 'Seat A1 has just been taken.');
      expect(bn.error(specific), 'Seat A1 has just been taken.');
    });

    test('and something with no words at all still says something', () {
      const bn = L(Lang.bn);
      expect(bn.error(ApiError(500, 'weird', '')), bn('err.unknown'));
      expect(bn.error(Exception('not an ApiError')), bn('err.unknown'));
    });
  });
}

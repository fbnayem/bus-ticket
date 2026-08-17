import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

/// The base the apps talk to.
///
/// Overridable at build time so a QA build can point at staging without a code
/// change: `flutter run --dart-define=JATRA_API=https://api.staging.jatra.bd/api/v1`.
const String kApiBase = String.fromEnvironment(
  'JATRA_API',
  // 10.0.2.2 is the host machine as seen from the Android emulator. A phone on
  // the same wifi needs the machine's LAN address, which is what the dart-define
  // above is for.
  defaultValue: 'http://10.0.2.2:8080/api/v1',
);

/// A refusal from the platform.
///
/// [body] is kept whole, because some refusals are *answers*: a boarding scan
/// that comes back ALREADY_BOARDED arrives with a 409 and is exactly the verdict
/// the crew needs to read. Throwing away the body would throw away the answer.
class ApiError implements Exception {
  ApiError(this.status, this.code, this.message, [this.body]);

  final int status;
  final String code;
  final String message;
  final Map<String, dynamic>? body;

  /// No line at all, as opposed to a refusal from the other end. The apps
  /// branch on this to decide whether to fall back to what is on the device.
  bool get offline => status == 0;

  @override
  String toString() => 'ApiError($status $code): $message';
}

/// Mints the identity a mutation is deduplicated on.
///
/// Minted on the device *before* the request is sent, and reused for every
/// retry of that same intent, so a flaky line cannot turn one sale into two.
/// The server stores it against the response and replays rather than re-runs.
String newIdempotencyKey([String prefix = 'm']) {
  final r = Random.secure();
  final bytes = List<int>.generate(9, (_) => r.nextInt(256));
  return '$prefix-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-'
      '${base64Url.encode(bytes).replaceAll('=', '')}';
}

/// The transport. Everything the apps know about HTTP lives here.
class ApiClient {
  ApiClient({this.base = kApiBase, http.Client? httpClient, this.timeout = const Duration(seconds: 20)})
      : _http = httpClient ?? http.Client();

  final String base;
  final http.Client _http;
  final Duration timeout;

  /// Set once a passenger or a staff member signs in. Cleared on 401.
  String? bearer;

  /// Called when the platform says the session is over, so the app can send the
  /// person back to a sign-in screen instead of showing half a workspace.
  void Function()? onUnauthenticated;

  Map<String, String> _headers([String? idempotencyKey]) => {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        if (bearer != null) 'Authorization': 'Bearer $bearer',
        if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey,
      };

  Future<Map<String, dynamic>> get(String path) => _send('GET', path);

  Future<Map<String, dynamic>> post(String path, {Object? body, String? idempotencyKey}) =>
      _send('POST', path, body: body, idempotencyKey: idempotencyKey);

  Future<Map<String, dynamic>> delete(String path) => _send('DELETE', path);

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    String? idempotencyKey,
  }) async {
    final uri = Uri.parse('$base$path');
    late http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(_headers(idempotencyKey));
      if (body != null) req.body = jsonEncode(body);
      final streamed = await _http.send(req).timeout(timeout);
      res = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiError(0, 'timeout', 'The service did not answer in time. Check the connection and try again.');
    } catch (_) {
      throw ApiError(0, 'network', 'We could not reach the service. Check the connection and try again.');
    }

    if (res.statusCode == 401) {
      bearer = null;
      onUnauthenticated?.call();
      throw ApiError(401, 'unauthenticated', 'Your session has ended. Please sign in again.');
    }
    // Status first, body second. This used to shortcut on an empty body before
    // looking at the status, which meant a 400 or a 502 with nothing in it
    // returned an empty map that every caller read as a successful, empty
    // answer — a search with no buses, a wallet with no money, a booking with
    // no tickets. A refusal with no words is still a refusal.
    if (res.statusCode >= 400 && res.bodyBytes.isEmpty) {
      throw ApiError(res.statusCode, 'http_${res.statusCode}',
          'The service refused that request. Please try again.');
    }
    if (res.statusCode == 204 || res.bodyBytes.isEmpty) return const {};

    Map<String, dynamic> parsed;
    try {
      // utf8.decode, not res.body: res.body guesses latin-1 unless the server
      // names a charset, which turns every Bangla message into mojibake.
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      parsed = decoded is Map<String, dynamic> ? decoded : {'data': decoded};
    } catch (_) {
      throw ApiError(res.statusCode, 'bad_response', 'The service returned something unexpected.');
    }

    if (res.statusCode >= 400) {
      throw ApiError(
        res.statusCode,
        (parsed['error'] as String?) ?? 'error',
        (parsed['message'] as String?) ?? 'Something went wrong. Please try again.',
        parsed,
      );
    }
    return parsed;
  }

  void close() => _http.close();
}

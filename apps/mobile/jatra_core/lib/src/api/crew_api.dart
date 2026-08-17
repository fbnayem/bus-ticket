import '../models.dart';
import 'client.dart';

/// Everything the crew app asks of the platform.
///
/// Every call here is refusable by the server on a permission this app does not
/// get to evaluate. What the app hides from a helper is a courtesy; what stops
/// them is the server checking the same permission again on every request.
class CrewApi {
  CrewApi(this.c);
  final ApiClient c;

  Future<Map<String, dynamic>> signIn(String email, String password, {String? totp}) =>
      c.post('/staff/login', body: {
        'email': email,
        'password': password,
        if (totp != null && totp.isNotEmpty) 'totp': totp,
      });

  Future<Map<String, dynamic>> me() => c.get('/staff/me');

  Future<void> signOut() async {
    try {
      await c.post('/staff/logout');
    } on ApiError {
      // Same reasoning as the passenger app: the local session goes either way.
    }
  }

  Future<List<CrewTrip>> trips() async {
    final r = await c.get('/driver/trips');
    return (r['trips'] as List? ?? const [])
        .map((e) => CrewTrip.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<Manifest> manifest(String tripId) async =>
      Manifest.fromJson(await c.get('/driver/trips/$tripId/manifest'));

  /// Check one ticket at the door.
  ///
  /// [clientRef] is minted on this device before the request leaves it and is
  /// reused for every retry, which is what makes flushing a queue twice
  /// harmless. A 409 is not a failure here — ALREADY_BOARDED and WRONG_TRIP are
  /// answers the crew needs — so the caller unwraps the body rather than
  /// treating any non-2xx as an error.
  Future<ScanVerdict> scan({
    required String clientRef,
    required String tripId,
    required String pnr,
    String seatNo = '',
    required String deviceRef,
  }) async {
    final body = {
      'client_ref': clientRef,
      'trip_id': tripId,
      'pnr': pnr.trim().toUpperCase(),
      'seat_no': seatNo.trim().toUpperCase(),
      'device_ref': deviceRef,
      'scanned_at': DateTime.now().toUtc().toIso8601String(),
    };
    try {
      return ScanVerdict.fromJson(await c.post('/driver/scan', body: body));
    } on ApiError catch (e) {
      if (e.status == 409 && e.body != null) return ScanVerdict.fromJson(e.body!);
      rethrow;
    }
  }

  /// Replays a queued scan. Same shape, already-built body, same idempotency.
  Future<ScanVerdict> replayScan(Map<String, dynamic> body) async {
    try {
      return ScanVerdict.fromJson(await c.post('/driver/scan', body: body));
    } on ApiError catch (e) {
      if (e.status == 409 && e.body != null) return ScanVerdict.fromJson(e.body!);
      rethrow;
    }
  }

  Future<void> setTripStatus(String tripId, String status) async =>
      c.post('/driver/trips/$tripId/status', body: {'status': status});

  /// Tell the platform where the bus is.
  ///
  /// This is the difference between a passenger seeing where the bus actually
  /// is and seeing what the timetable hoped. Failures are swallowed by the
  /// caller on purpose: a missed position is a gap in a stream, not an error
  /// worth interrupting a driver for.
  /// No timestamp is sent, deliberately.
  ///
  /// The platform stamps the position when it records it. A phone in a bus
  /// cradle can have a clock that is minutes or hours out, and a position that
  /// claims to be from the future is worse than one that is a second late —
  /// it reorders the trail and moves the bus backwards on a passenger's screen.
  Future<void> reportPosition(
    String tripId,
    double lat,
    double lng, {
    double? speedKph,
    int? heading,
  }) async =>
      c.post('/driver/trips/$tripId/position', body: {
        'lat': lat,
        'lng': lng,
        if (speedKph != null) 'speed_kph': speedKph,
        if (heading != null) 'heading': heading,
      });

  Future<List<Incident>> incidents() async {
    final r = await c.get('/driver/incidents');
    return (r['incidents'] as List? ?? const [])
        .map((e) => Incident.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<void> reportIncident({
    required String tripId,
    required String kind,
    required String severity,
    required String note,
  }) async =>
      c.post('/driver/incidents',
          body: {'trip_id': tripId, 'kind': kind, 'severity': severity, 'note': note});
}

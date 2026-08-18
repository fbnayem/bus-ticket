import '../models.dart';
import 'client.dart';
import 'discovery_api.dart';

/// Everything the crew app asks of the platform.
///
/// Every call here is refusable by the server on a permission this app does not
/// get to evaluate. What the app hides from a helper is a courtesy; what stops
/// them is the server checking the same permission again on every request.
class CrewApi extends DiscoveryApi {
  CrewApi(super.c);

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

  // ------------------------------------------------------------ selling --

  /// What this conductor may do on this bus.
  ///
  /// Fetched rather than assumed. The discount ceiling is an operator setting
  /// that can change between one trip and the next, and an app that cached it
  /// would happily offer a discount the server is about to refuse.
  Future<SellContext> sellContext() async =>
      SellContext.fromJson(await c.get('/crew/sell/context'));

  /// Sell a seat on board.
  ///
  /// The seats come from the same inventory service the website uses. Nothing
  /// in this app decides whether a seat is free, and passing a discount here is
  /// a request, not an instruction: the server refuses anything over the cap
  /// rather than quietly reducing it.
  Future<CrewSaleResult> sell({
    required String dutyId,
    required String tripId,
    required List<String> seats,
    required int boardSeq,
    required int dropSeq,
    required String phone,
    List<Map<String, dynamic>> passengers = const [],
    int discountPoisha = 0,
    String discountReason = '',
  }) async =>
      CrewSaleResult.fromJson(await c.post('/crew/sales', body: {
        'duty_id': dutyId,
        'trip_id': tripId,
        'seats': seats,
        'board_seq': boardSeq,
        'drop_seq': dropSeq,
        'phone': phone,
        'passengers': passengers,
        'discount_poisha': discountPoisha,
        'discount_reason': discountReason,
      }));

  // --------------------------------------------------------------- duty --

  /// Open the cash bag. Returns the one already open if there is one, because
  /// somebody tapping this twice meant to be selling, not to be told off.
  Future<String> openDuty(int openingFloatPoisha) async {
    final r = await c.post('/crew/duties',
        body: {'opening_float_poisha': openingFloatPoisha});
    return '${r['duty_id'] ?? ''}';
  }

  Future<Map<String, dynamic>> closeDuty({
    required String dutyId,
    required int countedCashPoisha,
    String note = '',
  }) =>
      c.post('/crew/duties/close', body: {
        'duty_id': dutyId,
        'counted_cash_poisha': countedCashPoisha,
        'note': note,
      });

  /// Seal one bus run inside the duty. A snapshot, not a count.
  Future<void> closeDutyTrip({required String dutyId, required String tripId}) async =>
      c.post('/crew/duties/trips/close', body: {'duty_id': dutyId, 'trip_id': tripId});

  Future<(List<CrewDuty>, DutySummary?)> duties() async {
    final r = await c.get('/crew/duties');
    final list = (r['duties'] as List? ?? const [])
        .map((e) => CrewDuty.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
    final open = r['open'] == null
        ? null
        : DutySummary.fromJson(r['open'] as Map<String, dynamic>);
    return (list, open);
  }

  // ------------------------------------------------------------- money --

  Future<CrewReport> report() async => CrewReport.fromJson(await c.get('/crew/report'));

  /// Their own sales, searchable. The server scopes this to the person asking;
  /// there is no parameter that widens it.
  Future<List<CrewSaleRow>> sales({String q = '', String from = '', String to = ''}) async {
    final query = [
      if (q.isNotEmpty) 'q=${Uri.encodeQueryComponent(q)}',
      if (from.isNotEmpty) 'from=$from',
      if (to.isNotEmpty) 'to=$to',
    ].join('&');
    final r = await c.get('/crew/sales${query.isEmpty ? '' : '?$query'}');
    return (r['sales'] as List? ?? const [])
        .map((e) => CrewSaleRow.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<(List<CrewCommissionRow>, int, int)> commissions() async {
    final r = await c.get('/crew/commissions');
    final list = (r['commissions'] as List? ?? const [])
        .map((e) => CrewCommissionRow.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
    return (list, _asInt(r['earned_poisha']), _asInt(r['forfeited_poisha']));
  }

  // ----------------------------------------------------------- profile --

  Future<void> updateProfile({String fullName = '', String phone = ''}) async =>
      c.patch('/staff/profile', body: {'full_name': fullName, 'phone': phone});

  Future<void> changePassword(String current, String next) async =>
      c.post('/staff/password/change',
          body: {'current_password': current, 'new_password': next});

  Future<List<StaffSessionInfo>> sessions() async {
    final r = await c.get('/staff/sessions');
    return (r['sessions'] as List? ?? const [])
        .map((e) => StaffSessionInfo.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<int> signOutEverywhereElse() async {
    final r = await c.post('/staff/sessions/revoke-all');
    return _asInt(r['revoked']);
  }
}

int _asInt(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;

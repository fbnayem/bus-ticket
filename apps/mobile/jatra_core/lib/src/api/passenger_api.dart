import '../models.dart';
import 'client.dart';

/// Everything the passenger app asks of the platform.
///
/// The rule this file exists to keep: **no seat logic lives in the app.** There
/// is no local notion of which seat is free, no optimistic reservation, no
/// client-side hold. `createHold` posts to the same inventory service the
/// website, the counter, the agent portal and the partner API all post to, and
/// the answer it returns is the only truth about that seat.
class PassengerApi {
  PassengerApi(this.c);
  final ApiClient c;

  Future<List<Place>> places([String q = '']) async {
    final r = await c.get('/locations?q=${Uri.encodeQueryComponent(q)}');
    return (r['locations'] as List? ?? const [])
        .map((e) => Place.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<List<TripSummary>> search(String from, String to, String isoDate) async {
    final r = await c.get('/search?from=${Uri.encodeQueryComponent(from)}'
        '&to=${Uri.encodeQueryComponent(to)}&date=$isoDate');
    return (r['results'] as List? ?? const [])
        .map((e) => TripSummary.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<TripDetail> trip(String id, {int board = 0, int drop = 0}) async =>
      TripDetail.fromJson(await c.get('/trips/$id?board=$board&drop=$drop'));

  Future<SeatMap> seatMap(String id, int board, int drop) async =>
      SeatMap.fromJson(await c.get('/trips/$id/seatmap?board=$board&drop=$drop'));

  /// Ask the central inventory to hold seats.
  ///
  /// The idempotency key is minted by the caller and reused across retries, so
  /// a tap that times out and is tried again cannot take two sets of seats.
  Future<Hold> createHold({
    required String tripId,
    required List<String> seats,
    required int boardSeq,
    required int dropSeq,
    required String idempotencyKey,
  }) async =>
      Hold.fromJson(await c.post('/holds', idempotencyKey: idempotencyKey, body: {
        'trip_id': tripId,
        'seats': seats,
        'board_seq': boardSeq,
        'drop_seq': dropSeq,
        'channel': 'APP',
      }));

  Future<Map<String, dynamic>> hold(String id) => c.get('/holds/$id');

  Future<void> releaseHold(String id) async => c.delete('/holds/$id');

  Future<Booking> createBooking({
    required String holdId,
    required List<PassengerDetail> passengers,
    required String phone,
    String? email,
    String? couponCode,
    required String idempotencyKey,
  }) async {
    final r = await c.post('/bookings', idempotencyKey: idempotencyKey, body: {
      'hold_id': holdId,
      'passengers': passengers.map((p) => p.toJson()).toList(),
      'phone': phone,
      if (email != null && email.isNotEmpty) 'email': email,
      if (couponCode != null && couponCode.isNotEmpty) 'coupon_code': couponCode,
    });
    // The create response is a receipt, not the booking. Read the booking back
    // so the app holds one shape, and so the status shown is the server's.
    return booking(r['pnr'] as String);
  }

  Future<Booking> booking(String pnr) async =>
      Booking.fromJson(await c.get('/bookings/$pnr'));

  Future<Map<String, dynamic>> paymentIntent(String bookingId, String provider) =>
      c.post('/payments/intent', body: {'booking_id': bookingId, 'provider': provider});

  /// The sandbox provider's "customer finished paying" callback.
  ///
  /// Note what this does NOT do: it does not confirm the booking. It tells the
  /// sandbox the customer finished, and the platform confirms only through its
  /// own verified webhook chain. The app then re-reads the booking to find out
  /// what actually happened — the same rule the website follows, and the reason
  /// a screenshot of a success page has never been proof of payment here.
  Future<Map<String, dynamic>> completeSandboxPayment(String paymentRef, {bool success = true}) =>
      c.post('/payments/sandbox/complete',
          body: {'payment_ref': paymentRef, 'outcome': success ? 'success' : 'failure'});

  Future<CancellationQuote> cancellationQuote(String pnr) async =>
      CancellationQuote.fromJson(await c.get('/bookings/$pnr/cancellation-quote'));

  Future<CancellationQuote> cancel(String pnr, String reason, {required String idempotencyKey}) async =>
      CancellationQuote.fromJson(
          await c.post('/bookings/$pnr/cancel', idempotencyKey: idempotencyKey, body: {'reason': reason}));

  Future<Map<String, dynamic>> rescheduleOptions(String pnr) =>
      c.get('/bookings/$pnr/reschedule-options');

  Future<Map<String, dynamic>> reschedule(
    String pnr, {
    required String tripId,
    required List<String> seats,
    required int boardSeq,
    required int dropSeq,
    required String idempotencyKey,
  }) =>
      c.post('/bookings/$pnr/reschedule', idempotencyKey: idempotencyKey, body: {
        'trip_id': tripId, 'seats': seats, 'board_seq': boardSeq, 'drop_seq': dropSeq,
      });

  Future<Tracking> tracking(String pnr) async =>
      Tracking.fromJson(await c.get('/tracking/$pnr'));

  Future<List<Offer>> offers() async {
    final r = await c.get('/offers');
    return (r['offers'] as List? ?? const [])
        .map((e) => Offer.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  /* --------------------------------------------------------------- account */

  Future<Map<String, dynamic>> requestOtp(String phone) =>
      c.post('/auth/otp/request', body: {'phone': phone});

  Future<Map<String, dynamic>> verifyOtp(String phone, String code, String device) =>
      c.post('/auth/otp/verify', body: {'phone': phone, 'code': code, 'device': device});

  Future<Map<String, dynamic>> refresh(String refreshToken, String device) =>
      c.post('/auth/refresh', body: {'refresh_token': refreshToken, 'device': device});

  Future<void> logout() async {
    try {
      await c.post('/auth/logout');
    } on ApiError {
      // Signing out locally must succeed even when the line does not. The
      // token is cleared either way; a stranded server session expires on its
      // own, and refusing to sign out would be the worse failure.
    }
  }

  Future<Map<String, dynamic>> accountBookings() => c.get('/account/bookings');

  Future<Map<String, dynamic>> profile() => c.get('/account/profile');
}

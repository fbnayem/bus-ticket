@Tags(['live'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The apps' own client code, driven against the running platform.
///
/// Everything else in this suite is hermetic. This one is not, on purpose: unit
/// tests prove the app agrees with itself, and this proves it agrees with the
/// server. It walks the whole passenger journey — search, seat map, hold,
/// booking, payment, ticket, cancellation — using exactly the code the app
/// ships, so a field the platform renamed shows up here rather than on a phone.
///
///   flutter test --tags live --dart-define=JATRA_API=http://localhost:8080/api/v1
///
/// Tagged, so an ordinary `flutter test` run does not fail on a machine with no
/// platform in front of it.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The test binding installs an HttpOverrides that answers every request with
  // an empty 400, so that a widget test cannot quietly reach the network. This
  // file exists precisely to reach it, so the override is removed.
  //
  // Worth recording why this was not obvious: with the override in place the
  // client returned an empty map rather than an error, because it shortcut on
  // an empty body before it looked at the status. That was a real defect in
  // the client and this test is what found it.
  HttpOverrides.global = null;

  late PassengerApi api;
  late Store store;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    store = await Store.open();
    api = PassengerApi(ApiClient(
      base: const String.fromEnvironment('JATRA_API',
          defaultValue: 'http://localhost:8080/api/v1'),
      timeout: const Duration(seconds: 30),
    ));
  });

  String isoIn(int days) => isoDate(DateTime.now().add(Duration(days: days)));

  test('the platform is there and knows where places are', () async {
    final places = await api.places('dha');
    expect(places, isNotEmpty);
  });

  test('a whole journey: search → seats → hold → book → pay → ticket → cancel',
      () async {
    /* -------------------------------------------------------- search --- */
    // Two days out, which keeps the departure inside the window the crew app
    // shows and lets a later boarding check find it.
    var trips = await api.search('Dhaka', 'Chattogram', isoIn(2));
    trips = trips.where((t) => t.availableSeats > 1).toList();
    expect(trips, isNotEmpty, reason: 'no departure with room; reset the fixtures');

    // The emptiest departure, so this test does not slowly exhaust one bus.
    trips.sort((a, b) => b.availableSeats.compareTo(a.availableSeats));
    final trip = trips.first;
    expect(trip.farePoisha, greaterThan(0));

    /* ------------------------------------------------------ seat map --- */
    final map = await api.seatMap(trip.tripId, trip.boardSeq, trip.dropSeq);
    final free = map.seats.where((s) => s.available).toList();
    expect(free, isNotEmpty);
    final seat = free.first.seatNo;

    /* ---------------------------------------------------------- hold --- */
    final hold = await api.createHold(
      tripId: trip.tripId,
      seats: [seat],
      boardSeq: trip.boardSeq,
      dropSeq: trip.dropSeq,
      idempotencyKey: newIdempotencyKey('livehold'),
    );
    expect(hold.holdId, isNotEmpty);
    expect(hold.seats, [seat]);
    expect(hold.price, isNotNull, reason: 'the price is frozen at hold time by the server');
    expect(hold.price!.totalPoisha, greaterThan(0));
    expect(hold.remaining.inSeconds, greaterThan(0), reason: 'a hold that is already expired is useless');

    // The same seat cannot be held twice. This is the platform's central rule
    // and the app must be able to rely on it rather than guarding locally.
    await expectLater(
      api.createHold(
        tripId: trip.tripId, seats: [seat],
        boardSeq: trip.boardSeq, dropSeq: trip.dropSeq,
        idempotencyKey: newIdempotencyKey('livehold2'),
      ),
      throwsA(isA<ApiError>().having((e) => e.status, 'status', 409)),
    );

    /* ------------------------------------------------------- booking --- */
    final booking = await api.createBooking(
      holdId: hold.holdId,
      passengers: [PassengerDetail(seatNo: seat, fullName: 'Mobile Test Passenger')],
      // A fresh number per run: the platform rate-limits sign-in codes per
      // number, and a suite that reuses one starts failing on its sixth run.
      phone: '01799${(DateTime.now().millisecondsSinceEpoch % 1000000).toString().padLeft(6, '0')}',
      idempotencyKey: newIdempotencyKey('livebook'),
    );
    expect(booking.pnr, isNotEmpty);
    expect(booking.status, 'PAYMENT_PENDING',
        reason: 'a booking is not confirmed by creating it');
    expect(booking.totalPoisha, hold.price!.totalPoisha,
        reason: 'the frozen price must survive into the booking unchanged');

    /* ------------------------------------------------------- payment --- */
    final intent = await api.paymentIntent(booking.bookingId, 'BKASH');
    final ref = '${intent['payment_ref']}';
    expect(ref, isNotEmpty);

    await api.completeSandboxPayment(ref, success: true);

    // The app does not decide this. It asks the platform what happened, and
    // the platform only says yes once its own verified webhook chain has run.
    Booking? confirmed;
    for (var attempt = 0; attempt < 20; attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 700));
      final fresh = await api.booking(booking.pnr);
      if (fresh.confirmed) {
        confirmed = fresh;
        break;
      }
    }
    expect(confirmed, isNotNull, reason: 'the platform never confirmed the payment');
    expect(confirmed!.tickets, isNotEmpty);
    expect(confirmed.tickets.first.qrToken, isNotEmpty,
        reason: 'no token means no QR at the bus door, which is the whole app');

    /* --------------------------------------------- the offline promise --- */
    await store.cacheTicket(confirmed);
    final onDevice = store.cachedTicket(confirmed.pnr);
    expect(onDevice, isNotNull);
    expect(onDevice!.tickets.first.qrToken, confirmed.tickets.first.qrToken);

    /* ------------------------------------------------------ tracking --- */
    final tracking = await api.tracking(confirmed.pnr);
    expect(tracking.stops, isNotEmpty);

    /* ----------------------------------------------------- cancelling --- */
    final quote = await api.cancellationQuote(confirmed.pnr);
    expect(quote.cancellable, isTrue);
    expect(quote.refundPoisha, lessThanOrEqualTo(quote.totalPoisha));

    final done = await api.cancel(confirmed.pnr, 'mobile suite',
        idempotencyKey: newIdempotencyKey('livecancel'));
    expect(done.refundPoisha, quote.refundPoisha,
        reason: 'the quote a passenger was shown must be the amount they get');

    final after = await api.booking(confirmed.pnr);
    expect(['CANCELLED', 'REFUND_PENDING', 'REFUNDED'], contains(after.status));

    // And the seat goes back on sale, which is what makes cancelling safe for
    // the operator as well as the passenger.
    final reopened = await api.seatMap(trip.tripId, trip.boardSeq, trip.dropSeq);
    expect(reopened.seats.firstWhere((s) => s.seatNo == seat).available, isTrue,
        reason: 'a cancelled seat that stays blocked is revenue nobody can sell');
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('offers arrive with Bangla copy', () async {
    final offers = await api.offers();
    expect(offers, isNotEmpty);
    expect(offers.any((o) => o.titleBn.isNotEmpty), isTrue,
        reason: 'campaign copy is content, and a Bangla reader needs it');
  });
}

import 'package:jatra_core/jatra_core.dart';

/// Checking tickets at the door of a bus, on a network that comes and goes.
///
/// Two decisions shape everything here.
///
/// **The identity is minted before the request leaves.** `client_ref` is
/// created on this device, stored with the queued scan, and reused on every
/// retry. That is what makes flushing a queue twice harmless: the platform
/// deduplicates on it and the second attempt is a no-op, not a second boarding.
///
/// **A provisional yes is never dressed up as a confirmed one.** When there is
/// no line the check is made against the list downloaded before departure and
/// the verdict says so, in words, on the screen. The crew is told the office
/// has not confirmed it yet, because the alternative — a green tick that might
/// be wrong — is how a passenger with a cancelled ticket rides for free and
/// nobody finds out until reconciliation.
class Boarding {
  Boarding({required this.api, required this.store});

  final CrewApi api;
  final Store store;

  int get waiting => store.queuedScans().length;

  /// Check one ticket.
  ///
  /// Returns a verdict in every case, including refusal and including no
  /// network. The crew never sees an exception; they see an instruction.
  Future<ScanVerdict> check({
    required String tripId,
    required String pnr,
    String seatNo = '',
    required L l,
  }) async {
    final clientRef = 'scan-${store.deviceRef}-${DateTime.now().microsecondsSinceEpoch}';
    final cleanPnr = pnr.trim().toUpperCase();
    final cleanSeat = seatNo.trim().toUpperCase();

    try {
      return await api.scan(
        clientRef: clientRef,
        tripId: tripId,
        pnr: cleanPnr,
        seatNo: cleanSeat,
        deviceRef: store.deviceRef,
      );
    } on ApiError catch (e) {
      if (!e.offline) rethrow;
      return _offlineVerdict(
        clientRef: clientRef,
        tripId: tripId,
        pnr: cleanPnr,
        seatNo: cleanSeat,
        l: l,
      );
    }
  }

  Future<ScanVerdict> _offlineVerdict({
    required String clientRef,
    required String tripId,
    required String pnr,
    required String seatNo,
    required L l,
  }) async {
    final manifest = store.cachedManifest(tripId);
    ManifestPassenger? row;
    for (final p in manifest?.passengers ?? const <ManifestPassenger>[]) {
      if (p.pnr == pnr && (seatNo.isEmpty || p.seatNo == seatNo)) {
        row = p;
        break;
      }
    }

    if (row == null) {
      // Not on the list. Nothing is queued: the device has no basis for
      // asserting this person may board, and guessing yes is the one mistake
      // that cannot be taken back once the bus has left.
      return ScanVerdict(
        result: 'NOT_FOUND',
        seatNo: '',
        pnr: pnr,
        message: l('sc.notOnList'),
        queued: true,
      );
    }

    if (row.boarded) {
      return ScanVerdict(
        result: 'ALREADY_BOARDED',
        seatNo: row.seatNo,
        pnr: row.pnr,
        passenger: row.passenger,
        message: l('sc.offAlready', {'seat': row.seatNo}),
        queued: true,
      );
    }

    await store.queueScan({
      'client_ref': clientRef,
      'trip_id': tripId,
      'pnr': pnr,
      'seat_no': seatNo,
      'device_ref': store.deviceRef,
      'scanned_at': DateTime.now().toUtc().toIso8601String(),
    });

    return ScanVerdict(
      result: 'BOARDED',
      seatNo: row.seatNo,
      pnr: row.pnr,
      passenger: row.passenger,
      message: l('sc.offBoarded', {'seat': row.seatNo}),
      queued: true,
    );
  }

  /// Send everything that was taken without a line.
  ///
  /// Returns how many the platform accepted. An entry that fails on the network
  /// stays queued; an entry the platform *refuses* is dropped, because a
  /// refusal is a decision and re-sending it forever would only hide it.
  Future<int> flush() async {
    final queued = store.queuedScans();
    if (queued.isEmpty) return 0;

    final done = <String>{};
    for (final body in queued) {
      final ref = '${body['client_ref']}';
      try {
        await api.replayScan(body);
        done.add(ref);
      } on ApiError catch (e) {
        if (e.offline) break; // still no line; stop trying and keep the rest
        done.add(ref); // answered, even if the answer was no
      }
    }
    if (done.isNotEmpty) await store.dropQueuedScans(done);
    return done.length;
  }
}

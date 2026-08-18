import '../models.dart';
import 'client.dart';

/// The four questions any channel asks before it can sell a seat: where can I
/// go, what is running, what is that trip, and which seats are free.
///
/// These endpoints are public — the same ones the website calls — because
/// availability is not a secret. Pulling them out as their own class is what
/// lets the crew app reuse the passenger app's place picker rather than owning
/// a second copy of it, and a second copy of a typo-tolerance table is exactly
/// the kind of duplication that drifts apart quietly.
///
/// It carries no authority. Everything a conductor is allowed to *do* with the
/// answers is checked on the server against a permission this class never sees.
class DiscoveryApi {
  DiscoveryApi(this.c);
  final ApiClient c;

  Future<List<Place>> places([String q = '', int limit = 0]) async {
    final r = await c.get('/locations?q=${Uri.encodeQueryComponent(q)}'
        '${limit > 0 ? '&limit=$limit' : ''}');
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
}

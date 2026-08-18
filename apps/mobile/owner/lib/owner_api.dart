import 'package:jatra_core/jatra_core.dart';

import 'owner_models.dart';

/// The owner app's calls, all of them against the same endpoints the web ERP
/// uses. The app decides nothing: it asks the server, which scopes every answer
/// to the operator the token belongs to and refuses anything the role does not
/// permit. `.c` is the shared client, exposed so the session can set the bearer
/// and register the device the same way the other apps do.
class OwnerApi {
  OwnerApi(this.c);

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
      // Signing out locally must succeed even if the server never hears about
      // it; the token is cleared regardless.
    }
  }

  String _window(String from, String to) {
    final q = <String>[];
    if (from.isNotEmpty) q.add('from=$from');
    if (to.isNotEmpty) q.add('to=$to');
    return q.isEmpty ? '' : '?${q.join('&')}';
  }

  Future<OwnerPnl> pnl({String from = '', String to = ''}) async =>
      OwnerPnl.fromJson(await c.get('/owner/pnl${_window(from, to)}'));

  Future<StaffSales> salesByStaff({String from = '', String to = ''}) async =>
      StaffSales.fromJson(await c.get('/owner/sales-by-staff${_window(from, to)}'));

  Future<OwnerCosts> costs({String from = '', String to = ''}) async =>
      OwnerCosts.fromJson(await c.get('/owner/costs${_window(from, to)}'));

  Future<void> addCost({
    required String busId,
    required String category,
    required int amountPoisha,
    required String incurredOn,
    String note = '',
  }) =>
      c.post('/owner/costs', body: {
        'bus_id': busId,
        'category': category,
        'amount_poisha': amountPoisha,
        'incurred_on': incurredOn,
        'note': note,
      });

  Future<void> deleteCost(String expenseId) => c.delete('/owner/costs/$expenseId');

  Future<List<OwnerBus>> buses() async {
    final r = await c.get('/operator/buses');
    return ((r['buses'] as List?) ?? const [])
        .map((e) => OwnerBus.fromJson(e as Map<String, dynamic>))
        .toList();
  }
}

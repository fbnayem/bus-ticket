// The shapes the owner API returns. Money is always an integer count of
// poisha, never a double — the same rule the platform keeps everywhere.

int _int(Object? v) => v is int ? v : (v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0);
String _str(Object? v) => v?.toString() ?? '';

class BusPnl {
  BusPnl.fromJson(Map<String, dynamic> j)
      : registration = _str(j['registration']),
        bookings = _int(j['bookings']),
        gross = _int(j['gross_poisha']),
        platform = _int(j['platform_commission_poisha']),
        staffCommission = _int(j['staff_commission_poisha']),
        netFare = _int(j['net_fare_poisha']),
        costs = _int(j['costs_poisha']),
        profit = _int(j['profit_poisha']);
  final String registration;
  final int bookings, gross, platform, staffCommission, netFare, costs, profit;
}

class OwnerTotals {
  OwnerTotals.fromJson(Map<String, dynamic> j)
      : bookings = _int(j['bookings']),
        gross = _int(j['gross_poisha']),
        platform = _int(j['platform_commission_poisha']),
        staffCommission = _int(j['staff_commission_poisha']),
        netFare = _int(j['net_fare_poisha']),
        costs = _int(j['costs_poisha']),
        profit = _int(j['profit_poisha']);
  final int bookings, gross, platform, staffCommission, netFare, costs, profit;
}

class OwnerPnl {
  OwnerPnl.fromJson(Map<String, dynamic> j)
      : buses = ((j['buses'] as List?) ?? const [])
            .map((e) => BusPnl.fromJson(e as Map<String, dynamic>))
            .toList(),
        overheadCosts = _int((j['overhead'] as Map<String, dynamic>?)?['costs_poisha']),
        totals = OwnerTotals.fromJson((j['totals'] as Map<String, dynamic>?) ?? const {});
  final List<BusPnl> buses;
  final int overheadCosts;
  final OwnerTotals totals;
}

class StaffSalesRow {
  StaffSalesRow.fromJson(Map<String, dynamic> j)
      : name = _str(j['full_name']),
        roles = _str(j['roles']),
        tickets = _int(j['tickets']),
        gross = _int(j['gross_poisha']),
        discount = _int(j['discount_poisha']),
        commission = _int(j['commission_poisha']);
  final String name, roles;
  final int tickets, gross, discount, commission;
}

class StaffSales {
  StaffSales.fromJson(Map<String, dynamic> j)
      : staff = ((j['staff'] as List?) ?? const [])
            .map((e) => StaffSalesRow.fromJson(e as Map<String, dynamic>))
            .toList(),
        totalTickets = _int((j['totals'] as Map<String, dynamic>?)?['tickets']),
        totalGross = _int((j['totals'] as Map<String, dynamic>?)?['gross_poisha']),
        totalCommission = _int((j['totals'] as Map<String, dynamic>?)?['commission_poisha']);
  final List<StaffSalesRow> staff;
  final int totalTickets, totalGross, totalCommission;
}

class OwnerCost {
  OwnerCost.fromJson(Map<String, dynamic> j)
      : expenseId = _str(j['expense_id']),
        registration = _str(j['registration']),
        busId = _str(j['bus_id']),
        category = _str(j['category']),
        amount = _int(j['amount_poisha']),
        incurredOn = _str(j['incurred_on']),
        note = _str(j['note']);
  final String expenseId, registration, busId, category, incurredOn, note;
  final int amount;
}

class OwnerCosts {
  OwnerCosts.fromJson(Map<String, dynamic> j)
      : costs = ((j['costs'] as List?) ?? const [])
            .map((e) => OwnerCost.fromJson(e as Map<String, dynamic>))
            .toList(),
        total = _int(j['total_poisha']);
  final List<OwnerCost> costs;
  final int total;
}

class OwnerBus {
  OwnerBus.fromJson(Map<String, dynamic> j)
      : busId = _str(j['bus_id']),
        registration = _str(j['registration']);
  final String busId, registration;
}

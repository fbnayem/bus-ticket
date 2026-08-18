import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../owner_models.dart';
import '../session.dart';
import 'report.dart';

/// Who sold how many tickets, and what they earned. One row per staff member
/// who sold anything in the window, biggest seller first.
class StaffSalesScreen extends StatefulWidget {
  const StaffSalesScreen({super.key, this.shown, this.index = -1});

  final ValueListenable<int>? shown;
  final int index;

  @override
  State<StaffSalesScreen> createState() => _StaffSalesScreenState();
}

class _StaffSalesScreenState extends State<StaffSalesScreen> {
  late String _from;
  late String _to;
  StaffSales? _data;
  String _error = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    final w0 = defaultWindow();
    _from = w0.$1;
    _to = w0.$2;
    _load();
    widget.shown?.addListener(_onShown);
  }

  void _onShown() {
    if (widget.shown?.value == widget.index && mounted) _load();
  }

  @override
  void dispose() {
    widget.shown?.removeListener(_onShown);
    super.dispose();
  }

  Future<void> _load() async {
    final session = SessionScope.read(context);
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final d = await session.api.salesByStaff(from: _from, to: _to);
      if (mounted) setState(() => _data = d);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = L.of(context).error(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setWindow(String from, String to) {
    setState(() {
      _from = from;
      _to = to;
    });
    _load();
  }

  static const _roleLabel = {
    'COUNTER_AGENT': 'Counter', 'DRIVER': 'Driver', 'HELPER': 'Helper',
    'SUPERVISOR': 'Supervisor', 'AGENT_OWNER': 'Agent', 'SUB_AGENT': 'Sub-agent',
    'OPERATOR_MANAGER': 'Manager', 'OPERATOR_OWNER': 'Owner',
  };

  String _roles(String roles) => roles
      .split(', ')
      .map((r) => _roleLabel[r] ?? r)
      .where((r) => r.isNotEmpty)
      .join(', ');

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.owner,
        title: Text(l('own.staff.title')),
        actions: [WindowPicker(from: _from, to: _to, onChanged: _setWindow)],
      ),
      body: RefreshIndicator(onRefresh: _load, child: _body(l)),
    );
  }

  Widget _body(L l) {
    if (_loading && _data == null) return const Waiting();
    if (_error.isNotEmpty && _data == null) {
      return ListView(children: [const SizedBox(height: 40), ErrorNotice(_error)]);
    }
    final d = _data;
    if (d == null) return const SizedBox.shrink();
    if (d.staff.isEmpty) {
      return ListView(children: [const SizedBox(height: 60), Nothing(title: l('own.staff.none'))]);
    }
    final maxGross = d.staff.fold<int>(1, (m, s) => s.gross > m ? s.gross : m);

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
      children: [
        Row(
          children: [
            Expanded(child: Stat(label: l('own.staff.tickets'), value: '${d.totalTickets}')),
            const SizedBox(width: 10),
            Expanded(child: Stat(label: l('own.staff.sales'), value: taka(d.totalGross))),
            const SizedBox(width: 10),
            Expanded(child: Stat(label: l('own.staff.commission'), value: taka(d.totalCommission))),
          ],
        ),
        const SizedBox(height: 16),
        for (final s in d.staff) _row(l, s, maxGross),
      ],
    );
  }

  Widget _row(L l, StaffSalesRow s, int maxGross) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: J.plate,
        borderRadius: BorderRadius.circular(J.radius),
        border: Border.all(color: J.rule),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                    if (_roles(s.roles).isNotEmpty)
                      Text(_roles(s.roles),
                          style: const TextStyle(color: J.muted, fontSize: 12)),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(taka(s.gross),
                      style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontFeatures: [FontFeature.tabularFigures()])),
                  Text(l('own.pnl.bookings', {'n': s.tickets}),
                      style: const TextStyle(color: J.muted, fontSize: 12)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              value: maxGross == 0 ? 0 : s.gross / maxGross,
              minHeight: 5,
              backgroundColor: J.fieldTint,
              valueColor: const AlwaysStoppedAnimation(J.owner),
            ),
          ),
          if (s.discount > 0 || s.commission > 0) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                if (s.discount > 0)
                  Text('${l('own.staff.discount')}: ${taka(s.discount)}',
                      style: const TextStyle(color: J.muted, fontSize: 12)),
                if (s.discount > 0 && s.commission > 0) const SizedBox(width: 14),
                if (s.commission > 0)
                  Text('${l('own.staff.commission')}: ${taka(s.commission)}',
                      style: const TextStyle(color: J.ok, fontSize: 12)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

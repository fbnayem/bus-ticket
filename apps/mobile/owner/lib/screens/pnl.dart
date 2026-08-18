import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../owner_models.dart';
import '../session.dart';
import 'report.dart';

/// The profit and loss, one card per bus: what it sold, what came out, and the
/// profit or loss left. The same arithmetic the web ERP shows and the server
/// proves — this screen only draws it.
class PnlScreen extends StatefulWidget {
  const PnlScreen({super.key, this.shown, this.index = -1});

  final ValueListenable<int>? shown;
  final int index;

  @override
  State<PnlScreen> createState() => _PnlScreenState();
}

class _PnlScreenState extends State<PnlScreen> {
  late String _from;
  late String _to;
  OwnerPnl? _pnl;
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
      final p = await session.api.pnl(from: _from, to: _to);
      if (mounted) setState(() => _pnl = p);
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

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.owner,
        title: Text(l('own.pnl.title')),
        actions: [WindowPicker(from: _from, to: _to, onChanged: _setWindow)],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _body(l),
      ),
    );
  }

  Widget _body(L l) {
    if (_loading && _pnl == null) return const Waiting();
    if (_error.isNotEmpty && _pnl == null) {
      return ListView(children: [const SizedBox(height: 40), ErrorNotice(_error)]);
    }
    final p = _pnl;
    if (p == null) return const SizedBox.shrink();
    final t = p.totals;

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
      children: [
        // Two rows of two, each tile sized to its own content. A fixed-aspect
        // grid clipped these headline numbers in Bangla — the taller script and
        // a six-figure taka value together overran the tile — so the height is
        // left to the content and the value scales down if it must.
        _statRow(
          Stat(label: l('own.pnl.ticketSales'), value: taka(t.gross)),
          Stat(label: l('own.pnl.netFare'), value: taka(t.netFare)),
        ),
        const SizedBox(height: 10),
        _statRow(
          Stat(label: l('own.pnl.costs'), value: taka(t.costs)),
          Stat(
            label: t.profit < 0 ? l('own.pnl.loss') : l('own.pnl.profit'),
            value: '${t.profit < 0 ? '−' : ''}${taka(t.profit.abs())}',
            tone: t.profit < 0 ? J.danger : J.ok,
          ),
        ),
        const SizedBox(height: 16),
        for (final b in p.buses) _busCard(l, b),
        if (p.overheadCosts > 0) ...[
          const SizedBox(height: 4),
          _line(l('own.pnl.overhead'), '−${taka(p.overheadCosts)}', muted: true),
        ],
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(l('own.pnl.note'),
              style: const TextStyle(color: J.muted, fontSize: 12, height: 1.5)),
        ),
      ],
    );
  }

  // Two equal-height tiles side by side. IntrinsicHeight keeps the shorter one
  // matched to the taller so the pair reads as a row, not two ragged boxes.
  Widget _statRow(Widget left, Widget right) => IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: left),
            const SizedBox(width: 10),
            Expanded(child: right),
          ],
        ),
      );

  Widget _busCard(L l, BusPnl b) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
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
                child: Text(b.registration,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              ),
              ProfitText(poisha: b.profit, size: 17),
            ],
          ),
          Text(l('own.pnl.bookings', {'n': b.bookings}),
              style: const TextStyle(color: J.muted, fontSize: 12)),
          const Divider(height: 18),
          _line(l('own.pnl.ticketSales'), taka(b.gross)),
          _line(l('own.pnl.platform'), '−${taka(b.platform)}', muted: true),
          _line(l('own.pnl.staffComm'), '−${taka(b.staffCommission)}', muted: true),
          _line(l('own.pnl.netFare'), taka(b.netFare), strong: true),
          _line(l('own.pnl.costs'), '−${taka(b.costs)}', muted: true),
        ],
      ),
    );
  }

  Widget _line(String label, String value, {bool muted = false, bool strong = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: TextStyle(
                  color: muted ? J.muted : J.ink2,
                  fontWeight: strong ? FontWeight.w700 : FontWeight.w400)),
          Text(value,
              style: TextStyle(
                  color: muted ? J.muted : J.ink,
                  fontFeatures: const [FontFeature.tabularFigures()],
                  fontWeight: strong ? FontWeight.w700 : FontWeight.w500)),
        ],
      ),
    );
  }
}

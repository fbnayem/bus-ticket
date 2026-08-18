import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../owner_models.dart';
import '../session.dart';
import 'report.dart';

const _categories = ['FUEL', 'MAINTENANCE', 'WAGES', 'INSURANCE', 'TOLL', 'PERMIT', 'OTHER'];

/// Running costs: record fuel, wages and upkeep, and see what the profit
/// subtracts. A cost is corrected by removing it, never by a negative amount.
class CostsScreen extends StatefulWidget {
  const CostsScreen({super.key, this.shown, this.index = -1});

  final ValueListenable<int>? shown;
  final int index;

  @override
  State<CostsScreen> createState() => _CostsScreenState();
}

class _CostsScreenState extends State<CostsScreen> {
  late String _from;
  late String _to;
  OwnerCosts? _data;
  List<OwnerBus> _buses = const [];
  String _error = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    final w0 = defaultWindow();
    _from = w0.$1;
    _to = w0.$2;
    _load();
    _loadBuses();
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
      final d = await session.api.costs(from: _from, to: _to);
      if (mounted) setState(() => _data = d);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = L.of(context).error(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadBuses() async {
    try {
      final b = await SessionScope.read(context).api.buses();
      if (mounted) setState(() => _buses = b);
    } on ApiError {
      // The bus list is a convenience; a cost can still be recorded as
      // operator-wide without it.
    }
  }

  void _setWindow(String from, String to) {
    setState(() {
      _from = from;
      _to = to;
    });
    _load();
  }

  Future<void> _remove(OwnerCost c) async {
    try {
      await SessionScope.read(context).api.deleteCost(c.expenseId);
      _load();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = L.of(context).error(e));
    }
  }

  Future<void> _openForm() async {
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _CostForm(buses: _buses),
    );
    if (added == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.owner,
        title: Text(l('own.costs.title')),
        actions: [WindowPicker(from: _from, to: _to, onChanged: _setWindow)],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openForm,
        backgroundColor: J.owner,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: Text(l('own.costs.record')),
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

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 96),
      children: [
        if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
        Stat(label: l('own.costs.total'), value: taka(d.total)),
        const SizedBox(height: 16),
        if (d.costs.isEmpty)
          Nothing(title: l('own.costs.none'))
        else
          for (final c in d.costs) _costRow(l, c),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(l('own.costs.corrNote'),
              style: const TextStyle(color: J.muted, fontSize: 12, height: 1.5)),
        ),
      ],
    );
  }

  Widget _costRow(L l, OwnerCost c) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      decoration: BoxDecoration(
        color: J.plate,
        borderRadius: BorderRadius.circular(J.radius),
        border: Border.all(color: J.rule),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(l('own.cat.${c.category}'),
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(width: 8),
                    Text(c.incurredOn, style: const TextStyle(color: J.muted, fontSize: 12)),
                  ],
                ),
                Text(
                  c.registration.isEmpty ? l('own.costs.operatorWide') : c.registration,
                  style: const TextStyle(color: J.ink2, fontSize: 13),
                ),
                if (c.note.isNotEmpty)
                  Text(c.note, style: const TextStyle(color: J.muted, fontSize: 12)),
              ],
            ),
          ),
          Text(taka(c.amount),
              style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontFeatures: [FontFeature.tabularFigures()])),
          IconButton(
            onPressed: () => _remove(c),
            icon: const Icon(Icons.close, size: 18, color: J.muted),
            tooltip: l('own.costs.remove'),
          ),
        ],
      ),
    );
  }
}

/// The record form, shown as a bottom sheet so it does not need its own route.
class _CostForm extends StatefulWidget {
  const _CostForm({required this.buses});
  final List<OwnerBus> buses;

  @override
  State<_CostForm> createState() => _CostFormState();
}

class _CostFormState extends State<_CostForm> {
  String _busId = '';
  String _category = 'FUEL';
  final _amount = TextEditingController();
  final _note = TextEditingController();
  late DateTime _date = DateTime.now();
  bool _busy = false;
  String _error = '';

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  String _iso(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _submit() async {
    final l = L.of(context);
    final taka100 = (double.tryParse(_amount.text.trim()) ?? 0) * 100;
    final amountPoisha = taka100.round();
    if (amountPoisha <= 0) {
      setState(() => _error = l('own.costs.badAmount'));
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await SessionScope.read(context).api.addCost(
            busId: _busId,
            category: _category,
            amountPoisha: amountPoisha,
            incurredOn: _iso(_date),
            note: _note.text.trim(),
          );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      setState(() {
        _error = L.of(context).error(e);
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l('own.costs.record'),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 14),
          if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
          DropdownButtonFormField<String>(
            initialValue: _busId,
            isExpanded: true,
            decoration: InputDecoration(labelText: l('own.costs.bus')),
            items: [
              DropdownMenuItem(value: '', child: Text(l('own.costs.operatorWide'))),
              for (final b in widget.buses)
                DropdownMenuItem(value: b.busId, child: Text(b.registration)),
            ],
            onChanged: (v) => setState(() => _busId = v ?? ''),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _category,
            isExpanded: true,
            decoration: InputDecoration(labelText: l('own.costs.category')),
            items: [
              for (final c in _categories)
                DropdownMenuItem(value: c, child: Text(l('own.cat.$c'))),
            ],
            onChanged: (v) => setState(() => _category = v ?? 'FUEL'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: l('own.costs.amount')),
          ),
          const SizedBox(height: 12),
          InkWell(
            onTap: _pickDate,
            child: InputDecorator(
              decoration: InputDecoration(labelText: l('own.costs.date')),
              child: Text(_iso(_date)),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _note,
            decoration: InputDecoration(labelText: l('own.costs.noteField')),
          ),
          const SizedBox(height: 18),
          FilledButton(
            onPressed: _busy ? null : _submit,
            style: FilledButton.styleFrom(backgroundColor: J.owner),
            child: Text(_busy ? l('common.loading') : l('own.costs.add')),
          ),
        ],
      ),
    );
  }
}

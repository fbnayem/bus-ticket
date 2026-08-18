import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../session.dart';

/// The money a conductor is responsible for.
///
/// Everything on this screen answers one of three questions they actually have
/// at the end of a run: how much have I taken, how much of it is mine, and how
/// much do I hand to the owner. The third is never shown as a single figure —
/// cash held, minus commission earned, equals what the owner gets, so it is a
/// sum somebody can check against the notes in their hand rather than a number
/// they have to trust.
class MoneyScreen extends StatefulWidget {
  const MoneyScreen({super.key, this.shown, this.index = -1});

  /// The tab currently on screen, and which tab this is. See CrewShell: an
  /// IndexedStack never re-runs initState, so without this the numbers here
  /// are whatever they were when the app started.
  final ValueListenable<int>? shown;
  final int index;

  @override
  State<MoneyScreen> createState() => _MoneyScreenState();
}

class _MoneyScreenState extends State<MoneyScreen> {
  CrewReport? _report;
  List<CrewDuty> _duties = const [];
  DutySummary? _openFromDuties;
  String _error = '';
  bool _loading = true;

  /// Two endpoints report the open duty, and either can be the one that
  /// answered. Taking whichever arrived means a conductor is never told they
  /// have no bag open while the screen above is already showing its takings —
  /// which is how somebody ends up opening a second one.
  DutySummary? get _open => _openFromDuties ?? _report?.duty;

  @override
  void initState() {
    super.initState();
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

  /// Each part loads on its own. One failing request should not blank a screen
  /// somebody is standing at a roadside trying to read.
  Future<void> _load() async {
    final session = SessionScope.read(context);
    setState(() => _loading = true);
    try {
      final r = await session.api.report();
      if (mounted) setState(() => _report = r);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    try {
      final (list, open) = await session.api.duties();
      if (mounted) {
        setState(() {
          _duties = list;
          _openFromDuties = open;
        });
      }
    } on ApiError {
      // The report above already said what it could. A second failure here
      // should not overwrite that message with a vaguer one.
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final report = _report;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.crew,
        title: Text(l('mn.title')),
        actions: [
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
          const SizedBox(width: 4),
        ],
      ),
      body: _loading
          ? Waiting(note: l('common.loading'))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
                children: [
                  if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],

                  _dutyCard(l),
                  const SizedBox(height: 14),

                  if (report != null) ...[
                    _periodCard(l, l('mn.today'), report.today),
                    const SizedBox(height: 10),
                    _periodCard(l, l('mn.week'), report.week),
                    const SizedBox(height: 14),
                    if (report.trips.isNotEmpty) _perTrip(l, report.trips),
                  ],

                  const SizedBox(height: 14),
                  _linkCard(l, Icons.receipt_long, l('mn.mySales'),
                      () => const CrewSalesScreen()),
                  _linkCard(l, Icons.percent, l('mn.commissions'),
                      () => const CrewCommissionsScreen()),

                  if (_duties.isNotEmpty) ...[
                    const SizedBox(height: 18),
                    _sectionTitle(l('mn.dutyHistory')),
                    for (final d in _duties.where((d) => !d.open)) _dutyRow(l, d),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _sectionTitle(String s) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
        child: Text(s, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
      );

  /// The open bag, or — when there is none — the same three lines computed for
  /// today, which is the question a conductor is actually asking.
  ///
  /// A cash bag is optional. Showing an empty invitation here would have meant
  /// somebody who never opens one is told nothing about their own money, when
  /// the platform knows exactly what they sold and exactly what is theirs. The
  /// bag adds the opening float, pay-ins and a physical count on top; without
  /// it the day is the honest boundary, and it is labelled as the day.
  Widget _dutyCard(L l) {
    final open = _open;
    if (open == null) {
      final today = _report?.today;
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l('mn.todayHandover'),
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: 14),
              _row(l('mn.taken'), taka(today?.grossPoisha ?? 0)),
              _row('- ${l('mn.commission')}', taka(today?.commissionPoisha ?? 0), tone: J.ok),
              const Divider(height: 20),
              _row(l('mn.handOver'), taka(today?.handoverPoisha ?? 0), strong: true),
              const SizedBox(height: 12),
              Text(l('mn.openDutyWhy'),
                  style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.4)),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: _openDuty,
                child: Text(l('mn.openDuty')),
              ),
            ],
          ),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(l('mn.duty'),
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                ),
                const Pill('OPEN', tone: PillTone.ok),
              ],
            ),
            const SizedBox(height: 14),
            // Three lines, in this order, and never collapsed into one.
            _row(l('mn.shouldHold'), taka(open.expectedPoisha)),
            _row('− ${l('mn.commission')}', taka(open.commissionPoisha), tone: J.ok),
            const Divider(height: 20),
            _row(l('mn.handOver'), taka(open.remitPoisha), strong: true),
            const SizedBox(height: 8),
            Text(
              '${l('mn.float')} ${taka(open.floatPoisha)} · '
              '${open.salesCount} ${l('mn.sales').toLowerCase()}'
              '${open.discountPoisha > 0 ? ' · ${l('mn.given')} ${taka(open.discountPoisha)}' : ''}',
              style: const TextStyle(color: J.muted, fontSize: 12.5),
            ),
            const SizedBox(height: 14),
            OutlinedButton(
              onPressed: () => _closeDuty(open),
              child: Text(l('mn.closeDuty')),
            ),
          ],
        ),
      ),
    );
  }

  Widget _periodCard(L l, String title, CrewPeriod p) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 10),
              _row(l('mn.sales'), '${p.salesCount}'),
              _row(l('mn.taken'), taka(p.grossPoisha)),
              if (p.discountPoisha > 0)
                _row(l('mn.given'), taka(p.discountPoisha), tone: J.warn),
              _row(l('mn.commission'), taka(p.commissionPoisha), tone: J.ok),
            ],
          ),
        ),
      );

  Widget _perTrip(L l, List<CrewTripTotals> trips) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l('mn.perTrip'), style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              for (final t in trips) ...[
                const Divider(height: 18),
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${timeOf(t.departAt, l.lang)} · ${t.route}',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13.5)),
                          Text(
                            '${t.salesCount} ${l('mn.sales').toLowerCase()} · '
                            '${l('mn.commission')} ${taka(t.commissionPoisha)}',
                            style: const TextStyle(color: J.muted, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(taka(t.grossPoisha),
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                  ],
                ),
                if (!t.closed)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: () => _closeTrip(t),
                      child: Text(l('mn.closeTrip')),
                    ),
                  ),
              ],
            ],
          ),
        ),
      );

  Widget _dutyRow(L l, CrewDuty d) => Card(
        child: ListTile(
          title: Text(dateTimeOf(d.openedAt, l.lang)),
          subtitle: Text(
            '${l('mn.expected')} ${taka(d.expectedPoisha)} · '
            '${l('mn.counted')} ${taka(d.countedPoisha)}',
          ),
          trailing: d.variancePoisha == 0
              ? Pill(l('mn.balanced'), tone: PillTone.ok)
              : Pill(
                  '${taka(d.variancePoisha.abs())} '
                  '${d.variancePoisha < 0 ? l('mn.short') : l('mn.over')}',
                  tone: PillTone.warn,
                ),
        ),
      );

  Widget _linkCard(L l, IconData icon, String title, Widget Function() page) => Card(
        child: ListTile(
          leading: Icon(icon, color: J.crew),
          title: Text(title),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.of(context)
              .push(MaterialPageRoute(builder: (_) => page())),
        ),
      );

  Widget _row(String label, String amount, {bool strong = false, Color? tone}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(label,
                  style: TextStyle(
                      color: strong ? J.ink : J.muted,
                      fontWeight: strong ? FontWeight.w700 : FontWeight.w400)),
            ),
            Text(amount,
                style: TextStyle(
                    color: tone ?? J.ink,
                    fontSize: strong ? 22 : 15,
                    fontWeight: strong ? FontWeight.w800 : FontWeight.w600)),
          ],
        ),
      );

  Future<void> _openDuty() async {
    final l = L.of(context);
    final session = SessionScope.read(context);
    final amount = await _askTaka(l('mn.openDuty'), l('mn.float'));
    if (amount == null) return;
    try {
      await session.api.openDuty(amount);
      await _load();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _closeDuty(DutySummary open) async {
    final l = L.of(context);
    final session = SessionScope.read(context);
    final messenger = ScaffoldMessenger.of(context);
    final counted = await _askTaka(l('mn.closeDuty'), l('mn.count'));
    if (counted == null) return;
    try {
      final r = await session.api.closeDuty(dutyId: open.dutyId, countedCashPoisha: counted);
      if (!mounted) return;
      final variance = (r['variance_poisha'] as num? ?? 0).toInt();
      messenger.showSnackBar(SnackBar(
        content: Text(variance == 0
            ? l('mn.balanced')
            : '${l('mn.variance')}: ${taka(variance.abs())} '
              '${variance < 0 ? l('mn.short') : l('mn.over')}'),
      ));
      await _load();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _closeTrip(CrewTripTotals t) async {
    final session = SessionScope.read(context);
    final open = _open;
    if (open == null) return;
    try {
      await session.api.closeDutyTrip(dutyId: open.dutyId, tripId: t.tripId);
      await _load();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Taka in, poisha out. Nobody counting notes on a bus thinks in poisha.
  Future<int?> _askTaka(String title, String label) => showDialog<int>(
        context: context,
        builder: (_) => _AmountDialog(title: title, label: label),
      );
}

/// The amount dialog owns its own controller.
///
/// Creating one in the calling method and disposing it after `showDialog`
/// returns crashes with `_dependents.isEmpty is not true`: the route is still
/// animating out and its TextField is still listening when dispose lands. Found
/// on a device, not in a test — no test had opened this dialog.
class _AmountDialog extends StatefulWidget {
  const _AmountDialog({required this.title, required this.label});
  final String title, label;

  @override
  State<_AmountDialog> createState() => _AmountDialogState();
}

class _AmountDialogState extends State<_AmountDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: widget.label, prefixText: '৳ '),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l('common.cancel')),
        ),
        FilledButton(
          onPressed: () {
            final v = int.tryParse(_controller.text.trim());
            Navigator.of(context).pop(v == null ? null : v * 100);
          },
          child: Text(l('common.ok')),
        ),
      ],
    );
  }
}

/// Every ticket this person sold, searchable.
///
/// The server scopes the list to whoever is asking; there is no parameter that
/// widens it, so the search box cannot become a way to read somebody else's
/// sales.
class CrewSalesScreen extends StatefulWidget {
  const CrewSalesScreen({super.key});

  @override
  State<CrewSalesScreen> createState() => _CrewSalesScreenState();
}

class _CrewSalesScreenState extends State<CrewSalesScreen> {
  final _q = TextEditingController();
  List<CrewSaleRow> _rows = const [];
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final session = SessionScope.read(context);
    try {
      final r = await session.api.sales(q: _q.text.trim());
      if (mounted) setState(() => _rows = r);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('mn.mySales'))),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
            child: TextField(
              controller: _q,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _load(),
              decoration: InputDecoration(
                hintText: l('mn.searchSales'),
                prefixIcon: const Icon(Icons.search),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.arrow_forward),
                  onPressed: _load,
                ),
              ),
            ),
          ),
          if (_error.isNotEmpty)
            Padding(padding: const EdgeInsets.all(14), child: ErrorNotice(_error)),
          Expanded(
            child: _loading
                ? Waiting(note: l('common.loading'))
                : _rows.isEmpty
                    ? Nothing(title: l('mn.noSales'))
                    : ListView.builder(
                        padding: const EdgeInsets.fromLTRB(14, 6, 14, 24),
                        itemCount: _rows.length,
                        itemBuilder: (_, i) => _saleCard(l, _rows[i]),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _saleCard(L l, CrewSaleRow s) => Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(s.pnr,
                        style: const TextStyle(
                            fontWeight: FontWeight.w800, letterSpacing: 1.2, fontSize: 16)),
                  ),
                  Text(taka(s.totalPoisha),
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 4),
              Text('${s.route} · ${s.seats}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: J.muted, fontSize: 13)),
              Text('${dateTimeOf(s.createdAt, l.lang)}'
                  '${s.phone.isEmpty ? '' : ' · ${s.phone}'}',
                  style: const TextStyle(color: J.muted, fontSize: 12)),
              if (s.discountPoisha > 0) ...[
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  children: [
                    Pill('− ${taka(s.discountPoisha)}', tone: PillTone.warn),
                    if (s.discountReason.isNotEmpty)
                      Pill(l('sl.reason.${s.discountReason}')),
                  ],
                ),
              ],
            ],
          ),
        ),
      );
}

/// What each sale earned, and what each discount cost.
class CrewCommissionsScreen extends StatefulWidget {
  const CrewCommissionsScreen({super.key});

  @override
  State<CrewCommissionsScreen> createState() => _CrewCommissionsScreenState();
}

class _CrewCommissionsScreenState extends State<CrewCommissionsScreen> {
  List<CrewCommissionRow> _rows = const [];
  int _earned = 0;
  int _forfeited = 0;
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final session = SessionScope.read(context);
    try {
      final (rows, earned, forfeited) = await session.api.commissions();
      if (mounted) {
        setState(() {
          _rows = rows;
          _earned = earned;
          _forfeited = forfeited;
        });
      }
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('mn.commissions'))),
      body: _loading
          ? Waiting(note: l('common.loading'))
          : ListView(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 24),
              children: [
                if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: Row(
                      children: [
                        Expanded(child: MoneyLine(what: l('mn.earned'), amount: taka(_earned))),
                        if (_forfeited > 0)
                          Expanded(
                            child: MoneyLine(
                                what: l('mn.gaveUp'), amount: taka(_forfeited), size: 24),
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                if (_rows.isEmpty) Nothing(title: l('mn.noSales')),
                for (final c in _rows)
                  Card(
                    child: ListTile(
                      title: Text(c.pnr,
                          style: const TextStyle(fontWeight: FontWeight.w700, letterSpacing: 1)),
                      subtitle: Text(
                        // Both numbers, because only the pair explains itself.
                        c.forfeitPoisha > 0
                            ? '${taka(c.grossPoisha)} ${l('sl.wasCut')} · '
                              '${taka(c.forfeitPoisha)} ${l('sl.wentToDiscount')}'
                            : dateTimeOf(c.createdAt, l.lang),
                      ),
                      trailing: Text(taka(c.amountPoisha),
                          style: const TextStyle(
                              fontWeight: FontWeight.w800, fontSize: 16, color: J.ok)),
                    ),
                  ),
              ],
            ),
    );
  }
}

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../session.dart';

/// Selling a seat on the bus.
///
/// Four steps, each on its own screen so nothing important shares space with
/// anything else: find the bus, pick the seats, agree the price, take the cash.
///
/// The seats come from the same inventory service the website uses. Nothing
/// here decides whether a seat is free, and nothing here decides what a
/// discount is allowed to be — the server refuses anything over the cap. What
/// this screen does is make sure a conductor knows the answer before they say
/// a price out loud to somebody standing in front of them.
class SellScreen extends StatefulWidget {
  const SellScreen({super.key, this.shown, this.index = -1});

  /// The tab currently on screen, and which tab this is. See CrewShell: an
  /// IndexedStack never re-runs initState, so without this the numbers here
  /// are whatever they were when the app started.
  final ValueListenable<int>? shown;
  final int index;

  @override
  State<SellScreen> createState() => _SellScreenState();
}

class _SellScreenState extends State<SellScreen> {
  SellContext? _ctx;
  String _error = '';
  bool _loading = true;

  Place? _from;
  Place? _to;
  DateTime _date = DateTime.now();
  List<TripSummary>? _results;
  bool _searching = false;

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

  Future<void> _load() async {
    final session = SessionScope.read(context);
    try {
      final ctx = await session.api.sellContext();
      if (mounted) setState(() => _ctx = ctx);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _search() async {
    final from = _from, to = _to;
    if (from == null || to == null) return;
    setState(() {
      _searching = true;
      _error = '';
    });
    final session = SessionScope.read(context);
    try {
      final r = await session.api.search(from.name, to.name, isoDate(_date));
      // Only their own company buses. The server refuses the rest outright;
      // this keeps a conductor from picking a seat they will then be told they
      // cannot sell. An empty brand means the server did not say, and hiding
      // everything would be worse than showing it.
      final brand = _ctx?.operatorBrand ?? '';
      if (mounted) {
        setState(() => _results =
            brand.isEmpty ? r : r.where((t) => t.brand == brand).toList(growable: false));
      }
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _searching = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final session = SessionScope.of(context);
    final ctx = _ctx;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.crew,
        title: Text(l('sl.title')),
        actions: const [LanguageToggle(), SizedBox(width: 8)],
      ),
      body: _loading
          ? Waiting(note: l('common.loading'))
          : ListView(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
              children: [
                if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],

                // A conductor who cannot sell is told so plainly rather than
                // being shown a form that will be refused.
                if (ctx != null && !ctx.maySell)
                  Nothing(title: l('sl.noDiscountRight'))
                else ...[
                  if (ctx != null && !ctx.onDuty) _noDutyNote(l),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(l('sl.find'),
                              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                          const SizedBox(height: 12),
                          // The same picker the passenger app uses, over the
                          // same gazetteer: old spellings, Bangla names and
                          // typos all resolve to one canonical place.
                          PlaceField(
                            label: l('sl.from'),
                            value: _from?.name ?? '',
                            valueBn: _from?.nameBn ?? '',
                            api: session.api,
                            store: session.store,
                            onChanged: (p) => setState(() => _from = p),
                          ),
                          const SizedBox(height: 10),
                          PlaceField(
                            label: l('sl.to'),
                            value: _to?.name ?? '',
                            valueBn: _to?.nameBn ?? '',
                            api: session.api,
                            store: session.store,
                            onChanged: (p) => setState(() => _to = p),
                          ),
                          const SizedBox(height: 10),
                          OutlinedButton.icon(
                            onPressed: _pickDate,
                            icon: const Icon(Icons.calendar_today, size: 18),
                            label: Text('${l('sl.date')}: ${dateOf(_date.toIso8601String(), l.lang)}'),
                          ),
                          const SizedBox(height: 12),
                          FilledButton(
                            onPressed: (_from == null || _to == null || _searching) ? null : _search,
                            child: Text(_searching ? l('sl.searching') : l('sl.search')),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  if (_results != null && _results!.isEmpty) Nothing(title: l('sl.noTrips')),
                  for (final t in _results ?? const <TripSummary>[]) _tripCard(l, ctx, t),
                ],
              ],
            ),
    );
  }

  /// A note, not a barrier.
  ///
  /// This card used to be a warning above a form that could not be used: no
  /// duty, no selling. That had the invariant backwards. Whoever is signed in
  /// is who the sale belongs to — the duty is an optional reconciliation on top
  /// of that, and making it a precondition meant a conductor could not sell a
  /// ticket until a ceremony had been performed for the benefit of a count
  /// nobody had asked for.
  Widget _noDutyNote(L l) => Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              const Icon(Icons.account_balance_wallet_outlined, color: J.muted),
              const SizedBox(width: 10),
              Expanded(
                child: Text(l('sl.noDutyOk'),
                    style: const TextStyle(color: J.muted, fontSize: 13)),
              ),
            ],
          ),
        ),
      );

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: now.subtract(const Duration(days: 1)),
      lastDate: now.add(const Duration(days: 30)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Widget _tripCard(L l, SellContext? ctx, TripSummary t) => Card(
        child: ListTile(
          contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
          title: Text('${timeOf(t.departAt, l.lang)}  ${t.brand}',
              style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('${t.origin} → ${t.destination}\n'
                '${taka(t.farePoisha)} · ${t.availableSeats} ${l('sl.seatsFree')}'),
          ),
          isThreeLine: true,
          trailing: const Icon(Icons.chevron_right),
          onTap: ctx == null
              ? null
              : () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => SeatPickScreen(trip: t, ctx: ctx),
                  )),
        ),
      );
}

/// Step two: which seats.
class SeatPickScreen extends StatefulWidget {
  const SeatPickScreen({super.key, required this.trip, required this.ctx});
  final TripSummary trip;
  final SellContext ctx;

  @override
  State<SeatPickScreen> createState() => _SeatPickScreenState();
}

class _SeatPickScreenState extends State<SeatPickScreen> {
  SeatMap? _map;
  final _picked = <String>{};
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final session = SessionScope.read(context);
    try {
      final m = await session.api.seatMap(
          widget.trip.tripId, widget.trip.boardSeq, widget.trip.dropSeq);
      if (mounted) setState(() => _map = m);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final map = _map;
    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('sl.pickSeats'))),
      body: map == null
          ? (_error.isEmpty ? Waiting(note: l('common.loading')) : ErrorNotice(_error))
          : ListView(
              padding: const EdgeInsets.all(14),
              children: [
                if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [for (final s in map.seats) _seat(s)],
                ),
              ],
            ),
      bottomNavigationBar: _picked.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: FilledButton(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => PriceScreen(
                      trip: widget.trip,
                      ctx: widget.ctx,
                      seats: _picked.toList()..sort(),
                    ),
                  )),
                  child: Text('${l('common.next')} · ${_picked.length}'),
                ),
              ),
            ),
    );
  }

  /// Free, taken and picked have to be told apart at arm's length in daylight,
  /// which is the same reason the passenger seat map uses solid fills rather
  /// than a translucent wash.
  Widget _seat(Seat s) {
    final chosen = _picked.contains(s.seatNo);
    final free = s.available;
    return SizedBox(
      width: 62,
      height: 46,
      child: Material(
        color: chosen
            ? J.crew
            : free
                ? J.plate
                : J.seatSold,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: BorderSide(color: free ? J.rule : J.seatSoldLine),
        ),
        child: InkWell(
          onTap: !free
              ? null
              : () => setState(() {
                    if (!_picked.remove(s.seatNo)) _picked.add(s.seatNo);
                  }),
          child: Center(
            child: Text(
              s.seatNo,
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: chosen
                    ? Colors.white
                    : free
                        ? J.ink
                        : J.seatSoldInk,
                decoration: free ? null : TextDecoration.lineThrough,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Step three: the price, and the one line that makes a discount honest.
class PriceScreen extends StatefulWidget {
  const PriceScreen({super.key, required this.trip, required this.ctx, required this.seats});
  final TripSummary trip;
  final SellContext ctx;
  final List<String> seats;

  @override
  State<PriceScreen> createState() => _PriceScreenState();
}

class _PriceScreenState extends State<PriceScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _discount = TextEditingController(text: '0');
  DiscountReason? _reason;
  bool _busy = false;
  String _error = '';

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _discount.dispose();
    super.dispose();
  }

  int get _full =>
      widget.trip.farePoisha * widget.seats.length + widget.ctx.serviceFeePoisha;

  /// Taka in the box, poisha in the arithmetic. Nobody types poisha.
  int get _discountPoisha => (int.tryParse(_discount.text.trim()) ?? 0) * 100;

  int get _cap => widget.ctx.capFor(_full, reason: _reason);

  /// The commission preview, under the rule the server says will settle it.
  ///
  /// Shown before the sale rather than after, because a discount comes out of
  /// the conductor's own commission first. Finding that out at handover, when
  /// the money is already given away, is what this line exists to prevent.
  (int gross, int forfeit, int net) get _commission =>
      widget.ctx.commissionAfter(_full, _discountPoisha);

  Future<void> _sell() async {
    final l = L.of(context);
    if (_phone.text.trim().isEmpty) {
      setState(() => _error = l('sl.needPhone'));
      return;
    }
    if (_discountPoisha > 0 && _reason == null) {
      setState(() => _error = l('sl.needReason'));
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    final session = SessionScope.read(context);
    try {
      final result = await session.api.sell(
        dutyId: widget.ctx.dutyId,
        tripId: widget.trip.tripId,
        seats: widget.seats,
        boardSeq: widget.trip.boardSeq,
        dropSeq: widget.trip.dropSeq,
        phone: _phone.text.trim(),
        passengers: [
          for (final s in widget.seats)
            {'seat_no': s, 'full_name': _name.text.trim()},
        ],
        discountPoisha: _discountPoisha,
        discountReason: _reason?.code ?? '',
      );
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => SoldScreen(result: result, trip: widget.trip),
      ));
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final ctx = widget.ctx;
    final (gross, forfeit, net) = _commission;

    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('sl.title'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
        children: [
          if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${widget.trip.brand} · ${timeOf(widget.trip.departAt, l.lang)}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 4),
                  Text('${widget.trip.origin} → ${widget.trip.destination}',
                      style: const TextStyle(color: J.muted)),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    children: [for (final s in widget.seats) Pill(s)],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: _name,
                    textCapitalization: TextCapitalization.words,
                    decoration: InputDecoration(labelText: l('sl.name')),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    decoration: InputDecoration(
                      labelText: l('sl.phone'),
                      helperText: l('sl.phoneWhy'),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          if (ctx.mayDiscount) _discountCard(l),
          if (ctx.mayDiscount) const SizedBox(height: 12),

          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  _row(l('sl.published'), taka(_full)),
                  if (_discountPoisha > 0)
                    _row(
                      "${l('sl.discount')}"
                          "${_reason == null ? '' : ' · ${_reason!.labelFor(l.lang)}'}",
                      '- ${taka(_discountPoisha)}',
                      tone: J.warn,
                    ),
                  const Divider(height: 20),
                  _row(l('sl.pays'), taka(_full - _discountPoisha), strong: true),
                  const SizedBox(height: 10),
                  // The honest line. A conductor should learn what a discount
                  // costs them here, not at the end of the day.
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      forfeit > 0
                          ? '${l('sl.yourCut')}: ${taka(net)}'
                            '  (${l('sl.wasCut')} ${taka(gross)} — '
                            '${taka(forfeit)} ${l('sl.wentToDiscount')})'
                          : '${l('sl.yourCut')}: ${taka(net)}',
                      style: TextStyle(
                        color: forfeit > 0 ? J.warn : J.muted,
                        fontSize: 13,
                        fontWeight: forfeit > 0 ? FontWeight.w600 : FontWeight.w400,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _sell,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(52),
              backgroundColor: J.crew,
            ),
            child: Text(_busy ? l('sl.selling') : l('sl.take')),
          ),
        ],
      ),
    );
  }

  /// A label and an amount on one line. Deliberately not MoneyLine, which is
  /// built for a single headline figure rather than a column of them.
  Widget _row(String label, String amount, {bool strong = false, Color? tone}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(label,
                  style: TextStyle(
                      color: tone ?? (strong ? J.ink : J.muted),
                      fontSize: strong ? 15 : 14,
                      fontWeight: strong ? FontWeight.w700 : FontWeight.w400)),
            ),
            Text(amount,
                style: TextStyle(
                    color: tone ?? J.ink,
                    fontSize: strong ? 20 : 15,
                    fontWeight: strong ? FontWeight.w800 : FontWeight.w600)),
          ],
        ),
      );

  Widget _discountCard(L l) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l('sl.discountWhy'),
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  for (final r in widget.ctx.reasons)
                    ChoiceChip(
                      label: Text(r.labelFor(l.lang)),
                      selected: _reason?.code == r.code,
                      onSelected: (on) => setState(() => _reason = on ? r : null),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _discount,
                keyboardType: TextInputType.number,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  labelText: l('sl.discount'),
                  prefixText: '৳ ',
                  // The ceiling in taka, not a percentage. A percentage is not
                  // what gets argued about at the side of a road.
                  helperText: '${l('sl.mostOff')}: ${taka(_cap)}',
                  errorText: _discountPoisha > _cap ? '${l('sl.mostOff')}: ${taka(_cap)}' : null,
                ),
              ),
            ],
          ),
        ),
      );
}

/// Step four: the receipt.
class SoldScreen extends StatelessWidget {
  const SoldScreen({super.key, required this.result, required this.trip});
  final CrewSaleResult result;
  final TripSummary trip;

  Widget _receiptRow(String label, String amount, {bool strong = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label,
                style: TextStyle(
                    color: strong ? J.ink : J.muted,
                    fontWeight: strong ? FontWeight.w700 : FontWeight.w400)),
            Text(amount,
                style: TextStyle(
                    fontSize: strong ? 20 : 15,
                    fontWeight: strong ? FontWeight.w800 : FontWeight.w600)),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('sl.sold'))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  const Icon(Icons.check_circle, color: J.ok, size: 44),
                  const SizedBox(height: 12),
                  Text(result.pnr,
                      style: const TextStyle(
                          fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: 2)),
                  const SizedBox(height: 6),
                  Text(result.seats.join(', '), style: const TextStyle(color: J.muted)),
                  const SizedBox(height: 16),
                  _receiptRow(l('sl.published'), taka(result.fullPoisha)),
                  if (result.discountPoisha > 0)
                    _receiptRow(l('sl.discount'), '- ${taka(result.discountPoisha)}'),
                  const Divider(height: 20),
                  _receiptRow(l('sl.collect'), taka(result.totalPoisha), strong: true),
                  const SizedBox(height: 8),
                  // What the server actually decided, not what the preview
                  // guessed. If those two ever disagree, this is where a
                  // conductor sees it.
                  Text(
                    result.forfeitPoisha > 0
                        ? '${l('sl.yourCut')}: ${taka(result.commissionPoisha)}'
                          '  (${taka(result.forfeitPoisha)} ${l('sl.wentToDiscount')})'
                        : '${l('sl.yourCut')}: ${taka(result.commissionPoisha)}',
                    style: const TextStyle(color: J.muted, fontSize: 13),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
            child: Text(l('sl.another')),
          ),
        ],
      ),
    );
  }
}

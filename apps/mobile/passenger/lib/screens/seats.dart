import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import 'passengers.dart';

/// The seat map.
///
/// Nothing on this screen decides whether a seat is free. The map is drawn from
/// what the central inventory says at the moment it was asked, and tapping
/// "continue" asks that same inventory to hold them. If two people tap the same
/// seat within the same second, exactly one hold is granted, and it is granted
/// by one conditional UPDATE in the inventory service — not by anything here,
/// and not by whoever's phone is faster.
///
/// So the map is honest about being a photograph: the note under it says a seat
/// can go while you are looking at it, and losing the race produces a plain
/// sentence rather than an error.
class SeatsScreen extends StatefulWidget {
  const SeatsScreen({super.key, required this.trip});
  final TripSummary trip;

  @override
  State<SeatsScreen> createState() => _SeatsScreenState();
}

class _SeatsScreenState extends State<SeatsScreen> {
  SeatMap? _map;
  final _picked = <String>[];
  String _error = '';
  bool _holding = false;

  static const _maxSeats = 4;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = '');
    try {
      final m = await AppScope.read(context)
          .api
          .seatMap(widget.trip.tripId, widget.trip.boardSeq, widget.trip.dropSeq);
      if (mounted) setState(() => _map = m);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _toggle(Seat s) {
    if (!s.available) return;
    setState(() {
      if (_picked.contains(s.seatNo)) {
        _picked.remove(s.seatNo);
      } else if (_picked.length < _maxSeats) {
        _picked.add(s.seatNo);
      }
    });
  }

  Future<void> _hold() async {
    if (_picked.isEmpty) return;
    setState(() {
      _holding = true;
      _error = '';
    });
    final app = AppScope.of(context);
    try {
      final hold = await app.api.createHold(
        tripId: widget.trip.tripId,
        seats: List.of(_picked),
        boardSeq: widget.trip.boardSeq,
        dropSeq: widget.trip.dropSeq,
        // Minted here and reused if this call has to be retried, so a tap that
        // times out and is tried again cannot take two sets of seats.
        idempotencyKey: newIdempotencyKey('hold'),
      );
      if (!mounted) return;
      setState(() => _holding = false);
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => PassengersScreen(trip: widget.trip, hold: hold),
      ));
      // Coming back means the booking was abandoned or the hold expired; the
      // map may have moved on without us.
      if (mounted) {
        setState(() => _picked.clear());
        await _load();
      }
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        // 409 is the inventory saying somebody else got there first. That is
        // the system working, not an error, and it is said in those words.
        _error = e.status == 409 ? L.of(context)('hold.taken') : e.message;
        _holding = false;
        _picked.clear();
      });
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final total = widget.trip.farePoisha * _picked.length;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l('seat.pick'), style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            Text('${widget.trip.brand} · ${timeOf(widget.trip.departAt, l.lang)}',
                style: const TextStyle(fontSize: 13, color: Colors.white70)),
          ],
        ),
      ),
      body: _error.isNotEmpty && _map == null
          ? ListView(children: [
              Padding(padding: const EdgeInsets.all(16), child: ErrorNotice(_error, onRetry: _load)),
            ])
          : _map == null
              ? const Waiting()
              : ListView(
                  padding: const EdgeInsets.fromLTRB(14, 14, 14, 24),
                  children: [
                    if (_error.isNotEmpty) ...[
                      ErrorNotice(_error),
                      const SizedBox(height: 12),
                    ],
                    const _Legend(),
                    const SizedBox(height: 14),
                    _Bus(map: _map!, picked: _picked, onTap: _toggle),
                    const SizedBox(height: 14),
                    Text(l('seat.livemap'),
                        style: const TextStyle(color: J.muted, fontSize: 13, height: 1.4)),
                    const SizedBox(height: 4),
                    Text(l('seat.max'), style: const TextStyle(color: J.muted, fontSize: 13)),
                  ],
                ),
      bottomNavigationBar: _picked.isEmpty
          ? null
          : SafeArea(
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: const BoxDecoration(
                  color: J.plate,
                  border: Border(top: BorderSide(color: J.rule)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(_picked.join(', '),
                              style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                  fontFeatures: [FontFeature.tabularFigures()])),
                          Text(taka(total),
                              style: const TextStyle(
                                  fontSize: 20,
                                  fontWeight: FontWeight.w700,
                                  fontFeatures: [FontFeature.tabularFigures()])),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: _holding ? null : _hold,
                        child: Text(l('seat.continue', {'n': _picked.length})),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend();

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    Widget swatch(Color c, Color border, String label) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 15,
              height: 15,
              decoration: BoxDecoration(
                color: c,
                border: Border.all(color: border),
                borderRadius: BorderRadius.circular(J.radiusSm),
              ),
            ),
            const SizedBox(width: 5),
            Text(label, style: const TextStyle(fontSize: 12.5, color: J.ink2)),
          ],
        );

    return Wrap(spacing: 14, runSpacing: 8, children: [
      swatch(J.plate, J.ruleStrong, l('seat.free')),
      swatch(J.field, J.field, l('seat.yours')),
      swatch(J.plate2, J.rule, l('seat.taken')),
      swatch(J.plum.withValues(alpha: .14), J.plum, l('seat.women')),
    ]);
  }
}

class _Bus extends StatelessWidget {
  const _Bus({required this.map, required this.picked, required this.onTap});

  final SeatMap map;
  final List<String> picked;
  final void Function(Seat) onTap;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    if (map.seats.isEmpty) return Nothing(title: l('find.full'));

    final maxRow = map.seats.map((s) => s.row).reduce((a, b) => a > b ? a : b);
    final maxCol = map.seats.map((s) => s.col).reduce((a, b) => a > b ? a : b);

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
      decoration: BoxDecoration(
        color: J.plate,
        border: Border.all(color: J.ruleStrong, width: 1.5),
        borderRadius: const BorderRadius.vertical(
          top: Radius.circular(26),
          bottom: Radius.circular(J.radius),
        ),
      ),
      child: Column(
        children: [
          // The driver, drawn, so the map has an orientation and a passenger
          // knows which end of the bus a seat number is at.
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: J.plate2,
                  border: Border.all(color: J.rule),
                  borderRadius: BorderRadius.circular(J.radiusSm),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.airline_seat_recline_normal, size: 15, color: J.muted),
                  const SizedBox(width: 4),
                  Text(l('seat.driver'), style: const TextStyle(fontSize: 12, color: J.muted)),
                ]),
              ),
            ],
          ),
          const SizedBox(height: 12),
          for (var r = 1; r <= maxRow; r++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var c = 1; c <= maxCol; c++) ...[
                    // The aisle. A bus is not a grid, and a map without a gap
                    // down the middle makes people count squares to find 3B.
                    if (c == (maxCol ~/ 2) + 1) const SizedBox(width: 26),
                    _SeatBox(
                      seat: _at(r, c),
                      picked: picked,
                      onTap: onTap,
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  Seat? _at(int row, int col) {
    for (final s in map.seats) {
      if (s.row == row && s.col == col) return s;
    }
    return null;
  }
}

class _SeatBox extends StatelessWidget {
  const _SeatBox({required this.seat, required this.picked, required this.onTap});

  final Seat? seat;
  final List<String> picked;
  final void Function(Seat) onTap;

  @override
  Widget build(BuildContext context) {
    final s = seat;
    if (s == null) return const SizedBox(width: 44, height: 44);

    final mine = picked.contains(s.seatNo);
    final free = s.available;

    final (bg, border, ink) = mine
        ? (J.field, J.field, Colors.white)
        : !free
            ? (J.plate2, J.rule, J.muted)
            : s.femaleReserved
                ? (J.plum.withValues(alpha: .12), J.plum, J.plum)
                : (J.plate, J.ruleStrong, J.ink);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Semantics(
        button: free,
        selected: mine,
        label: s.seatNo,
        child: InkWell(
          onTap: free ? () => onTap(s) : null,
          borderRadius: BorderRadius.circular(J.radius),
          child: Container(
            // 44 square. Below that a thumb on a moving bus taps the seat next
            // to the one it meant, and this is a screen where that costs money.
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: bg,
              border: Border.all(color: border, width: mine ? 2 : 1),
              borderRadius: BorderRadius.circular(J.radius),
            ),
            child: Text(
              s.seatNo,
              style: TextStyle(
                color: ink,
                fontSize: 13,
                fontWeight: mine ? FontWeight.w700 : FontWeight.w500,
                decoration: free ? null : TextDecoration.lineThrough,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import 'seats.dart';

/// The buses.
///
/// One card per departure, and the two facts that decide between them — when it
/// leaves and what it costs — carry the weight. Amenity icons, star ratings and
/// operator logos all lost that argument: a passenger picks a bus by time and
/// price, then checks it is air-conditioned.
class ResultsScreen extends StatefulWidget {
  const ResultsScreen({super.key, required this.from, required this.to, required this.date});

  final String from, to, date;

  @override
  State<ResultsScreen> createState() => _ResultsScreenState();
}

class _ResultsScreenState extends State<ResultsScreen> {
  List<TripSummary>? _trips;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = '');
    try {
      final trips = await AppScope.read(context).api.search(widget.from, widget.to, widget.date);
      if (mounted) setState(() => _trips = trips);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = L.of(context).error(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final app = AppScope.of(context);
    final saved = app.store.savedRoutes()
        .any((r) => r.from == widget.from && r.to == widget.to);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${widget.from} → ${widget.to}',
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            Text(dayOf(widget.date, l),
                style: const TextStyle(fontSize: 13, color: Colors.white70)),
          ],
        ),
        actions: [
          IconButton(
            tooltip: l('ac.saveRoute'),
            icon: Icon(saved ? Icons.bookmark : Icons.bookmark_border),
            onPressed: () async {
              if (saved) {
                await app.forgetRoute(widget.from, widget.to);
              } else {
                await app.saveRoute(widget.from, widget.to);
                if (context.mounted) {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(SnackBar(content: Text(l('ac.routeSaved'))));
                }
              }
              if (mounted) setState(() {});
            },
          ),
        ],
      ),
      body: RefreshIndicator(onRefresh: _load, child: _body(l)),
    );
  }

  Widget _body(L l) {
    if (_error.isNotEmpty) {
      return ListView(children: [
        Padding(padding: const EdgeInsets.all(16), child: ErrorNotice(_error, onRetry: _load)),
      ]);
    }
    if (_trips == null) return Waiting(note: l('find.searching'));
    if (_trips!.isEmpty) {
      return ListView(children: [
        Nothing(title: l('find.none'), hint: l('find.noneHint')),
      ]);
    }
    return ListView.separated(
      padding: const EdgeInsets.all(14),
      itemCount: _trips!.length + 1,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (_, i) {
        if (i == 0) {
          return Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Text(l('find.results', {'n': _trips!.length}),
                style: const TextStyle(color: J.muted, fontSize: 14)),
          );
        }
        return _TripCard(trip: _trips![i - 1]);
      },
    );
  }
}

class _TripCard extends StatelessWidget {
  const _TripCard({required this.trip});
  final TripSummary trip;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final full = trip.availableSeats == 0;

    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(J.radius),
        onTap: full
            ? null
            : () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => SeatsScreen(trip: trip))),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Departure and arrival, joined by the journey length. Read
                  // as one line: leaves 22:00, takes 6h 10m, gets in 04:10.
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(timeOf(trip.departAt, l.lang),
                          style: const TextStyle(
                              fontSize: 26, fontWeight: FontWeight.w700, height: 1.05)),
                      const SizedBox(height: 2),
                      Text(durationOf(trip.durationMin, l.lang),
                          style: const TextStyle(color: J.muted, fontSize: 12.5)),
                      const SizedBox(height: 2),
                      Text(timeOf(trip.arriveAt, l.lang),
                          style: const TextStyle(color: J.ink2, fontSize: 15)),
                    ],
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(trip.brand,
                            style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 3),
                        Text(trip.isAc ? '${trip.busType} · AC' : trip.busType,
                            style: const TextStyle(color: J.muted, fontSize: 13.5)),
                        const SizedBox(height: 8),
                        if (full)
                          Pill(l('find.full'), tone: PillTone.danger)
                        else
                          Pill(
                            trip.availableSeats == 1
                                ? l('find.oneSeatLeft')
                                : l('find.seatsLeft', {'n': trip.availableSeats}),
                            // Fewer than five left is worth noticing; it is not
                            // a warning, and dressing it as one would be a lie
                            // told to hurry somebody.
                            tone: trip.availableSeats <= 4 ? PillTone.warn : PillTone.neutral,
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(taka(trip.farePoisha),
                          style: const TextStyle(
                              fontSize: 21,
                              fontWeight: FontWeight.w700,
                              fontFeatures: [FontFeature.tabularFigures()])),
                      Text(l('common.seat').toLowerCase(),
                          style: const TextStyle(color: J.muted, fontSize: 12)),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

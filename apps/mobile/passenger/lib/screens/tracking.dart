import 'dart:async';

import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';

/// Where is my bus.
///
/// The provenance line is the point of this screen, not decoration. "The bus is
/// twenty minutes away" and "the bus is *scheduled* to be twenty minutes away"
/// are different promises, and a passenger standing at a stop in the rain
/// deserves to know which one they are being given. When no bus is reporting,
/// this says so in plain words rather than drawing a confident dot on a line.
class TrackingScreen extends StatefulWidget {
  const TrackingScreen({super.key, required this.pnr});
  final String pnr;

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  Tracking? _t;
  String _error = '';
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    // Twenty seconds. The bus does not move fast enough to justify more, and
    // this runs on somebody's data plan.
    _poll = Timer.periodic(const Duration(seconds: 20), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final t = await AppScope.of(context).api.tracking(widget.pnr);
      if (mounted) setState(() { _t = t; _error = ''; });
    } on ApiError catch (e) {
      if (mounted && _t == null) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final t = _t;

    return Scaffold(
      appBar: AppBar(title: Text(l('tr.title'))),
      body: t == null
          ? (_error.isNotEmpty
              ? ListView(children: [
                  Padding(padding: const EdgeInsets.all(16), child: ErrorNotice(_error, onRetry: _load)),
                ])
              : const Waiting())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
                children: [
                  // Where this position came from, before anything is drawn
                  // from it.
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: t.live ? J.okTint : J.plate2,
                      borderRadius: BorderRadius.circular(J.radius),
                      border: Border.all(color: t.live ? J.ok.withValues(alpha: .3) : J.rule),
                    ),
                    child: Row(
                      children: [
                        Icon(t.live ? Icons.gps_fixed : Icons.schedule,
                            size: 18, color: t.live ? J.ok : J.muted),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(t.live ? l('tr.live') : l('tr.scheduled'),
                              style: TextStyle(
                                  color: t.live ? J.ok : J.ink2,
                                  fontSize: 14,
                                  height: 1.35,
                                  fontWeight: t.live ? FontWeight.w600 : FontWeight.w400)),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),

                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (t.nextStop.isNotEmpty) ...[
                            Text(l('tr.next'),
                                style: const TextStyle(color: J.muted, fontSize: 13)),
                            Text(t.nextStop,
                                style: const TextStyle(
                                    fontSize: 24, fontWeight: FontWeight.w700, height: 1.15)),
                            if (t.eta.isNotEmpty) ...[
                              const SizedBox(height: 4),
                              Text(l('tr.eta', {'time': timeOf(t.eta, l.lang)}),
                                  style: const TextStyle(fontSize: 15, color: J.ink2)),
                            ],
                            const SizedBox(height: 14),
                          ],
                          ClipRRect(
                            borderRadius: BorderRadius.circular(J.radiusSm),
                            child: LinearProgressIndicator(
                              value: (t.progress.clamp(0, 100)) / 100,
                              minHeight: 8,
                              backgroundColor: J.plate2,
                              color: t.live ? J.ok : J.ruleStrong,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            t.state == 'ARRIVED'
                                ? l('tr.arrived')
                                : t.state == 'DEPARTED' || t.state == 'IN_PROGRESS'
                                    ? l('tr.departed', {'time': timeOf(t.departAt, l.lang)})
                                    : l('tr.departs', {'time': timeOf(t.departAt, l.lang)}),
                            style: const TextStyle(color: J.muted, fontSize: 13.5),
                          ),
                        ],
                      ),
                    ),
                  ),

                  if (t.stops.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Column(
                          children: [
                            for (final s in t.stops) _StopRow(stop: s),
                          ],
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}

class _StopRow extends StatelessWidget {
  const _StopRow({required this.stop});
  final Stop stop;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      child: Row(
        children: [
          // A rail down the left, so the stops read as a route rather than a
          // list of place names.
          SizedBox(
            width: 22,
            child: Icon(
              stop.passed ? Icons.check_circle : Icons.radio_button_unchecked,
              size: 17,
              color: stop.passed ? J.ok : J.ruleStrong,
            ),
          ),
          Expanded(
            child: Text(stop.name,
                style: TextStyle(
                    fontSize: 15.5,
                    color: stop.passed ? J.muted : J.ink,
                    fontWeight: stop.passed ? FontWeight.w400 : FontWeight.w600)),
          ),
          Text(timeOf(stop.at, l.lang),
              style: TextStyle(
                  fontSize: 14,
                  color: stop.passed ? J.muted : J.ink2,
                  fontFeatures: const [FontFeature.tabularFigures()])),
        ],
      ),
    );
  }
}

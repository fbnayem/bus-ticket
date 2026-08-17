import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../boarding.dart';
import '../session.dart';
import 'incident.dart';
import 'trip.dart';

/// What am I driving, and when.
///
/// The time is the largest thing on each card, because that is the question a
/// driver arriving at a terminal at half past four in the morning is actually
/// asking. Everything else on the card exists to confirm they are at the right
/// bus.
class TripsScreen extends StatefulWidget {
  const TripsScreen({super.key, required this.boarding});
  final Boarding boarding;

  @override
  State<TripsScreen> createState() => _TripsScreenState();
}

class _TripsScreenState extends State<TripsScreen> {
  List<CrewTrip>? _trips;
  String _error = '';
  int _waiting = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = '');
    try {
      final trips = await SessionScope.of(context).api.trips();
      if (!mounted) return;
      setState(() {
        _trips = trips;
        _waiting = widget.boarding.waiting;
      });
      // Pull each manifest in while there is a line, so the list is on the
      // phone before it is needed at a door with no signal.
      for (final t in trips) {
        try {
          final m = await SessionScope.of(context).api.manifest(t.tripId);
          await widget.boarding.store.cacheManifest(t.tripId, m.raw);
        } on ApiError {
          // Best effort. A trip whose list could not be fetched simply has no
          // cached copy, and the scanner says so at the door rather than here.
        }
      }
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _waiting = widget.boarding.waiting;
      });
    }
  }

  Future<void> _flush() async {
    final n = await widget.boarding.flush();
    if (!mounted) return;
    setState(() => _waiting = widget.boarding.waiting);
    final l = L.of(context);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(n == 1 ? l('sc.sent1') : l('sc.sent', {'n': n})),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final session = SessionScope.of(context);

    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.crew,
        title: Text(l('cr.myTrips')),
        actions: [
          const Padding(padding: EdgeInsets.only(right: 8), child: Center(child: LanguageToggle(onLight: true))),
          IconButton(
            tooltip: l('common.signOut'),
            icon: const Icon(Icons.logout),
            onPressed: session.signOut,
          ),
        ],
      ),
      body: Column(
        children: [
          if (_waiting > 0)
            QueueBar(
              label: _waiting == 1 ? l('sc.waiting1') : l('sc.waiting', {'n': _waiting}),
              action: l('sc.sendNow'),
              onAction: _flush,
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: _body(l),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: J.crew,
        foregroundColor: Colors.white,
        onPressed: () => Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => IncidentScreen(trips: _trips ?? const []),
        )),
        icon: const Icon(Icons.report_outlined),
        label: Text(l('cr.problem')),
      ),
    );
  }

  Widget _body(L l) {
    if (_error.isNotEmpty && _trips == null) {
      return ListView(children: [
        Padding(padding: const EdgeInsets.all(16), child: ErrorNotice(_error, onRetry: _load)),
      ]);
    }
    if (_trips == null) return const Waiting();
    if (_trips!.isEmpty) {
      return ListView(children: [Nothing(title: l('cr.none'))]);
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 96),
      itemCount: _trips!.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (_, i) => _TripCard(
        trip: _trips![i],
        boarding: widget.boarding,
        onChanged: _load,
      ),
    );
  }
}

class _TripCard extends StatelessWidget {
  const _TripCard({required this.trip, required this.boarding, required this.onChanged});

  final CrewTrip trip;
  final Boarding boarding;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final roleKey = 'cr.role.${trip.role}';
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(J.radius),
        onTap: () async {
          await Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => TripScreen(trip: trip, boarding: boarding),
          ));
          onChanged();
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // The departure time, at the size of the only question being asked.
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(timeOf(trip.departAt, l.lang),
                      style: const TextStyle(
                          fontSize: 30, fontWeight: FontWeight.w700, height: 1, color: J.ink)),
                  const SizedBox(height: 2),
                  Text(dayOf(trip.departAt, l),
                      style: const TextStyle(color: J.muted, fontSize: 13)),
                ],
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(trip.route,
                        style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(trip.registration,
                        style: const TextStyle(
                            color: J.ink2,
                            fontSize: 14,
                            fontFeatures: [FontFeature.tabularFigures()])),
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: [
                      Pill(kStrings.containsKey(roleKey) ? l(roleKey) : trip.role),
                      Pill(
                        kStrings.containsKey('status.${trip.status}')
                            ? l('status.${trip.status}')
                            : trip.status,
                        tone: toneOf(trip.status),
                      ),
                    ]),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: J.muted),
            ],
          ),
        ),
      ),
    );
  }
}

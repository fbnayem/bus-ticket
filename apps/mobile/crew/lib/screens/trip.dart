import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:jatra_core/jatra_core.dart';

import '../boarding.dart';
import '../session.dart';
import 'scan.dart';

/// One trip: who is on it, where it is in its own life, and where it is on the
/// road.
///
/// The manifest is cached on the way in. That is not an optimisation — it is
/// the entire reason a helper can check tickets in a place with no signal, and
/// it has to happen while the bus is still somewhere with one.
class TripScreen extends StatefulWidget {
  const TripScreen({super.key, required this.trip, required this.boarding});

  final CrewTrip trip;
  final Boarding boarding;

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  Manifest? _manifest;
  String _status = '';
  String _error = '';
  bool _stale = false;
  bool _busy = false;

  StreamSubscription<Position>? _positions;
  bool get _sharing => _positions != null;
  int _sent = 0;

  @override
  void initState() {
    super.initState();
    _status = widget.trip.status;
    _load();
  }

  @override
  void dispose() {
    _positions?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final m = await SessionScope.read(context).api.manifest(widget.trip.tripId);
      await widget.boarding.store.cacheManifest(widget.trip.tripId, m.raw);
      if (!mounted) return;
      setState(() {
        _manifest = m;
        _stale = false;
        _error = '';
      });
    } on ApiError catch (e) {
      final cached = widget.boarding.store.cachedManifest(widget.trip.tripId);
      if (!mounted) return;
      setState(() {
        if (cached != null) {
          _manifest = cached;
          _stale = true;
        } else {
          _error = L.of(context).error(e);
        }
      });
    }
  }

  /// The next legal state, and only that one.
  ///
  /// Offering a driver every state in a menu invites the wrong one at speed,
  /// and the platform would refuse it anyway. One button, named as a verb for
  /// what pressing it does.
  String? get _nextState => switch (_status) {
        'SCHEDULED' || 'OPEN' => 'BOARDING',
        'BOARDING' => 'DEPARTED',
        'DEPARTED' => 'IN_PROGRESS',
        'IN_PROGRESS' => 'ARRIVED',
        _ => null,
      };

  Future<void> _advance(String next) async {
    setState(() => _busy = true);
    try {
      await SessionScope.of(context).api.setTripStatus(widget.trip.tripId, next);
      if (!mounted) return;
      setState(() {
        _status = next;
        _busy = false;
      });
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(L.of(context)('cr.done'))));
      // Leaving the terminal is exactly when position sharing matters, so it
      // is offered at the moment it becomes useful rather than buried.
      if (next == 'DEPARTED' && !_sharing) await _startSharing();
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = L.of(context).error(e);
        _busy = false;
      });
    }
  }

  Future<void> _startSharing() async {
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(L.of(context)('cr.noGps'))));
      return;
    }

    // Asking for permission can take as long as the driver takes to answer,
    // and this screen may be gone by then.
    if (!mounted) return;

    // Captured before the stream starts. Reaching for the context inside an
    // async callback that fires for the next six hours is how a widget that
    // has been disposed gets asked for its inherited widgets.
    final api = SessionScope.of(context).api;

    final sub = Geolocator.getPositionStream(
      // 50 metres, not every fix. A bus in traffic that has not moved does not
      // need to say so ten times a minute, and the phone in the cradle is
      // running off the same battery all day.
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 50,
      ),
    ).listen((p) async {
      try {
        await api.reportPosition(
          widget.trip.tripId,
          p.latitude,
          p.longitude,
          // m/s from the platform, km/h on every road sign in the country.
          speedKph: p.speed * 3.6,
          heading: p.heading.isFinite ? p.heading.round() : null,
        );
        if (mounted) setState(() => _sent++);
      } on ApiError {
        // A missed position is a gap in a stream, not something to interrupt a
        // driver about. The next fix carries the bus forward anyway.
      }
    });

    if (!mounted) {
      await sub.cancel();
      return;
    }
    setState(() => _positions = sub);
  }

  Future<void> _stopSharing() async {
    await _positions?.cancel();
    if (!mounted) return;
    setState(() => _positions = null);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final m = _manifest;
    final next = _nextState;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.crew,
        title: Text(widget.trip.route, overflow: TextOverflow.ellipsis),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
          children: [
            if (_stale)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: J.warnTint,
                    borderRadius: BorderRadius.circular(J.radius),
                  ),
                  child: Text(l('tk.savedOnPhone'),
                      style: const TextStyle(color: J.warn, fontSize: 14)),
                ),
              ),
            if (_error.isNotEmpty) ...[
              ErrorNotice(_error, onRetry: _load),
              const SizedBox(height: 12),
            ],

            // When it leaves, at the size a driver reads across a cab.
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(timeOf(widget.trip.departAt, l.lang),
                        style: const TextStyle(
                            fontSize: 40, fontWeight: FontWeight.w700, height: 1)),
                    const SizedBox(height: 4),
                    Text('${dayOf(widget.trip.departAt, l)} · ${widget.trip.registration}',
                        style: const TextStyle(color: J.muted, fontSize: 14.5)),
                    if (m != null) ...[
                      const SizedBox(height: 14),
                      Text(l('cr.ofTotal', {'done': m.boarded, 'total': m.total}),
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(J.radiusSm),
                        child: LinearProgressIndicator(
                          value: m.total == 0 ? 0 : m.boarded / m.total,
                          minHeight: 8,
                          backgroundColor: J.plate2,
                          color: J.ok,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),

            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: J.field),
              onPressed: () async {
                await Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => ScanScreen(trip: widget.trip, boarding: widget.boarding),
                ));
                await _load();
              },
              icon: const Icon(Icons.qr_code_scanner),
              label: Text(l('cr.check')),
            ),

            if (next != null) ...[
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: _busy ? null : () => _advance(next),
                child: Text(l('cr.do.$next')),
              ),
            ],

            const SizedBox(height: 10),
            _SharingCard(
              sharing: _sharing,
              sent: _sent,
              onStart: _startSharing,
              onStop: _stopSharing,
            ),

            const SizedBox(height: 18),
            Text(l('cr.list'),
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (m == null)
              const Waiting()
            else if (m.passengers.isEmpty)
              Nothing(title: l('tk.none'))
            else
              Card(
                child: Column(
                  children: [
                    for (var i = 0; i < m.passengers.length; i++) ...[
                      if (i > 0) const Divider(height: 1),
                      _PassengerRow(p: m.passengers[i]),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SharingCard extends StatelessWidget {
  const _SharingCard({
    required this.sharing,
    required this.sent,
    required this.onStart,
    required this.onStop,
  });

  final bool sharing;
  final int sent;
  final VoidCallback onStart, onStop;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(sharing ? Icons.location_on : Icons.location_off_outlined,
                    color: sharing ? J.ok : J.muted),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(sharing ? l('cr.sharing') : l('cr.share'),
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
                Switch(
                  value: sharing,
                  activeThumbColor: J.ok,
                  onChanged: (v) => v ? onStart() : onStop(),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(l('cr.shareWhy'),
                style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.4)),
            if (sharing && sent > 0) ...[
              const SizedBox(height: 6),
              Text('$sent',
                  style: const TextStyle(
                      color: J.ok,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      fontFeatures: [FontFeature.tabularFigures()])),
            ],
          ],
        ),
      ),
    );
  }
}

class _PassengerRow extends StatelessWidget {
  const _PassengerRow({required this.p});
  final ManifestPassenger p;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          SizedBox(
            width: 46,
            child: Text(p.seatNo,
                style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    fontFeatures: [FontFeature.tabularFigures()])),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(p.passenger.isEmpty ? '—' : p.passenger,
                    style: const TextStyle(fontSize: 15.5)),
                const SizedBox(height: 2),
                // Not everyone gets on at the first stop. A passenger joining
                // at Cumilla is not a no-show in Dhaka, and this line is what
                // stops a helper marking them one.
                Text('${p.from} → ${p.to}',
                    style: const TextStyle(color: J.muted, fontSize: 13)),
              ],
            ),
          ),
          if (p.boarded) Pill(l('status.BOARDED'), tone: PillTone.ok),
        ],
      ),
    );
  }
}

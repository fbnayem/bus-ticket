import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../session.dart';

/// Telling the office what happened.
///
/// The order of the kinds is the order a driver would think of them in — worst
/// first — not alphabetical, and not the order the enum happens to be declared
/// in on the server.
const _kinds = [
  'BREAKDOWN',
  'ACCIDENT',
  'ROUTE_INTERRUPTION',
  'DELAY',
  'PASSENGER_ISSUE',
  'OTHER',
];
const _severities = ['LOW', 'MEDIUM', 'HIGH'];

class IncidentScreen extends StatefulWidget {
  const IncidentScreen({super.key, required this.trips});
  final List<CrewTrip> trips;

  @override
  State<IncidentScreen> createState() => _IncidentScreenState();
}

class _IncidentScreenState extends State<IncidentScreen> {
  late String _tripId = widget.trips.isEmpty ? '' : widget.trips.first.tripId;
  String _kind = 'DELAY';
  String _severity = 'LOW';
  final _note = TextEditingController();

  bool _busy = false;
  String _error = '';
  List<Incident>? _reported;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final rows = await SessionScope.read(context).api.incidents();
      if (mounted) setState(() => _reported = rows);
    } on ApiError {
      if (mounted) setState(() => _reported = const []);
    }
  }

  Future<void> _send() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await SessionScope.of(context).api.reportIncident(
            tripId: _tripId,
            kind: _kind,
            severity: _severity,
            note: _note.text.trim(),
          );
      if (!mounted) return;
      _note.clear();
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(L.of(context)('in.sent'))));
      await _load();
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('cr.problem'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
        children: [
          if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (widget.trips.isNotEmpty) ...[
                    DropdownButtonFormField<String>(
                      initialValue: _tripId,
                      decoration: InputDecoration(labelText: l('in.which')),
                      items: [
                        for (final t in widget.trips)
                          DropdownMenuItem(
                            value: t.tripId,
                            child: Text('${timeOf(t.departAt, l.lang)} · ${t.route}',
                                overflow: TextOverflow.ellipsis),
                          ),
                      ],
                      onChanged: (v) => setState(() => _tripId = v ?? _tripId),
                    ),
                    const SizedBox(height: 12),
                  ],
                  DropdownButtonFormField<String>(
                    initialValue: _kind,
                    decoration: InputDecoration(labelText: l('in.what')),
                    items: [
                      for (final k in _kinds)
                        DropdownMenuItem(value: k, child: Text(l('kind.$k'))),
                    ],
                    onChanged: (v) => setState(() => _kind = v ?? _kind),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _severity,
                    decoration: InputDecoration(labelText: l('in.serious')),
                    items: [
                      for (final s in _severities)
                        DropdownMenuItem(value: s, child: Text(l('sev.$s'))),
                    ],
                    onChanged: (v) => setState(() => _severity = v ?? _severity),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _note,
                    minLines: 2,
                    maxLines: 4,
                    decoration: InputDecoration(
                      labelText: l('in.details'),
                      hintText: l('in.hint'),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: J.crew),
                    onPressed: _busy || _note.text.trim().isEmpty || _tripId.isEmpty ? null : _send,
                    child: Text(l('in.send')),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          Text(l('in.foot'),
              style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.45)),
          if (_reported != null && _reported!.isNotEmpty) ...[
            const SizedBox(height: 18),
            Card(
              child: Column(
                children: [
                  for (var i = 0; i < _reported!.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    _IncidentRow(incident: _reported![i]),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _IncidentRow extends StatelessWidget {
  const _IncidentRow({required this.incident});
  final Incident incident;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final kindKey = 'kind.${incident.kind}';
    final sevKey = 'sev.${incident.severity}';
    return Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(kStrings.containsKey(kindKey) ? l(kindKey) : incident.kind,
                    style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
              ),
              Pill(
                kStrings.containsKey(sevKey) ? l(sevKey) : incident.severity,
                tone: switch (incident.severity) {
                  'HIGH' => PillTone.danger,
                  'MEDIUM' => PillTone.warn,
                  _ => PillTone.neutral,
                },
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(incident.note, style: const TextStyle(fontSize: 14.5, height: 1.35)),
          const SizedBox(height: 4),
          Text('${dateTimeOf(incident.createdAt, l.lang)} · ${incident.reportedBy}',
              style: const TextStyle(color: J.muted, fontSize: 12.5)),
        ],
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';

import 'api/passenger_api.dart';
import 'i18n.dart';
import 'models.dart';
import 'store.dart';
import 'theme.dart';

/// Choosing where you are going, on a phone.
///
/// The field this replaces was a bare `TextField` holding "Dhaka". Two people
/// out of three type their own city correctly and the third does not, and the
/// third one got "we don't recognise that departure city" — which is the
/// product blaming a passenger for its own seven-row gazetteer.
///
/// The shape here is deliberately not a dropdown under the field. On a phone
/// the keyboard takes half the screen, and a list wedged into the other half
/// shows three results above the fold. Tapping opens a full-height sheet
/// instead: search box at the top, the whole list under it, one tap to choose.
/// That is also what people already know from every other travel app they
/// have.
///
/// It is built to survive a bad connection, because that is where it is used.
/// Recently chosen places are kept on the device and shown when the platform
/// cannot be reached, so somebody standing at a counter with one bar can still
/// pick the route they took last month.

/// The tappable field. Shows the chosen place; opens [showPlacePicker].
class PlaceField extends StatelessWidget {
  const PlaceField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    required this.api,
    required this.store,
    this.valueBn = '',
  });

  final String label;
  final String value;

  /// The Bangla name of the current value, when it is known. Empty is fine —
  /// the field falls back to the canonical name rather than showing nothing.
  final String valueBn;
  final ValueChanged<Place> onChanged;
  final PassengerApi api;
  final Store store;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final shown = l.isBn && valueBn.isNotEmpty ? valueBn : value;
    return InkWell(
      onTap: () async {
        final picked = await showPlacePicker(
          context: context, api: api, store: store, title: label,
        );
        if (picked != null) onChanged(picked);
      },
      borderRadius: BorderRadius.circular(J.radius),
      child: InputDecorator(
        decoration: InputDecoration(labelText: label),
        child: Row(
          children: [
            Expanded(
              child: Text(
                shown.isEmpty ? l('place.search') : shown,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 16,
                  color: shown.isEmpty ? J.muted : J.ink,
                ),
              ),
            ),
            const Icon(Icons.expand_more, size: 20, color: J.muted),
          ],
        ),
      ),
    );
  }
}

/// Opens the search sheet. Returns the chosen place, or null if dismissed.
Future<Place?> showPlacePicker({
  required BuildContext context,
  required PassengerApi api,
  required Store store,
  required String title,
}) {
  return showModalBottomSheet<Place>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: J.plate,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _PlaceSheet(api: api, store: store, title: title),
  );
}

class _PlaceSheet extends StatefulWidget {
  const _PlaceSheet({required this.api, required this.store, required this.title});
  final PassengerApi api;
  final Store store;
  final String title;

  @override
  State<_PlaceSheet> createState() => _PlaceSheetState();
}

class _PlaceSheetState extends State<_PlaceSheet> {
  final _q = TextEditingController();
  Timer? _debounce;
  List<Place> _items = const [];
  bool _loading = true;
  bool _offline = false;

  /// Guards a slow answer from overwriting a newer one: without it a laggy
  /// reply for "ch" lands after "chattogram" and repopulates the old list.
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _fetch('');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _fetch(String q) async {
    final mine = ++_seq;
    setState(() => _loading = true);
    try {
      final r = await widget.api.places(q, 20);
      if (!mounted || mine != _seq) return;
      setState(() { _items = r; _offline = false; _loading = false; });
    } catch (_) {
      if (!mounted || mine != _seq) return;
      // No platform. Fall back to what this device already knows, which is
      // usually where this passenger actually goes.
      final recent = widget.store.recentPlaces();
      final n = q.trim().toLowerCase();
      final hits = recent
          .where((p) => n.isEmpty ||
              p.name.toLowerCase().contains(n) ||
              p.nameBn.toLowerCase().contains(n))
          .map((p) => Place('', p.name, 'CITY', nameBn: p.nameBn))
          .toList(growable: false);
      setState(() { _items = hits; _offline = true; _loading = false; });
    }
  }

  void _onTyped(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 180), () => _fetch(v.trim()));
  }

  Future<void> _choose(Place p) async {
    await widget.store.rememberPlace(p.name, p.nameBn);
    if (mounted) Navigator.of(context).pop(p);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final bn = l.isBn;
    final inset = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: inset),
      child: FractionallySizedBox(
        heightFactor: 0.92,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(widget.title,
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                    tooltip: l('common.close'),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
              child: TextField(
                controller: _q,
                autofocus: true,
                textInputAction: TextInputAction.search,
                onChanged: _onTyped,
                decoration: InputDecoration(
                  hintText: l('place.search'),
                  prefixIcon: const Icon(Icons.search, size: 20),
                  suffixIcon: _q.text.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.clear, size: 18),
                          onPressed: () { _q.clear(); _fetch(''); setState(() {}); },
                        ),
                ),
              ),
            ),
            if (_offline)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                decoration: BoxDecoration(
                  color: J.warnTint,
                  borderRadius: BorderRadius.circular(J.radius),
                ),
                child: Text(l('place.offline'),
                    style: const TextStyle(color: J.warn, fontSize: 13.5, height: 1.35)),
              ),
            Expanded(child: _body(l, bn)),
          ],
        ),
      ),
    );
  }

  Widget _body(L l, bool bn) {
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.search_off, size: 34, color: J.muted),
            const SizedBox(height: 10),
            Text(l('place.noMatch'),
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(l('place.noMatchHint'),
                textAlign: TextAlign.center,
                style: const TextStyle(color: J.muted)),
          ],
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 16),
      itemCount: _items.length,
      separatorBuilder: (_, __) => const Divider(height: 1, color: J.rule),
      itemBuilder: (_, i) {
        final p = _items[i];
        final alt = p.alt(bn);
        return ListTile(
          onTap: () => _choose(p),
          leading: Icon(
            p.isTerminal ? Icons.local_parking_outlined : Icons.location_city_outlined,
            size: 22, color: J.muted,
          ),
          title: Row(
            children: [
              Flexible(
                child: Text(p.label(bn),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ),
              if (alt.isNotEmpty) ...[
                const SizedBox(width: 8),
                Flexible(
                  child: Text(alt,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, color: J.muted)),
                ),
              ],
            ],
          ),
          subtitle: _sub(l, p),
          // Saying "no buses yet" here, on the row, is the whole point of
          // offering unserved places at all: a passenger learns it before they
          // commit to the route rather than from an empty results page.
          trailing: p.served
              ? null
              : Text(l('place.noBuses'),
                  style: const TextStyle(fontSize: 12, color: J.warn)),
        );
      },
    );
  }

  Widget? _sub(L l, Place p) {
    final bits = <String>[
      if (p.isTerminal) l('place.terminal'),
      if (p.parent.isNotEmpty) p.parent,
    ];
    if (bits.isEmpty) return null;
    return Text(bits.join(' · '), style: const TextStyle(fontSize: 12.5, color: J.muted));
  }
}

import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import 'results.dart';

/// Where a journey starts.
///
/// Three fields and one button. The temptation on a screen like this is a
/// carousel of destinations and a promotional banner; what somebody standing in
/// a shop actually wants is to type two place names and see buses. Everything
/// else on this screen is either a shortcut to that, or gone.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  // The canonical name is what goes to the platform; the Bangla one is only
  // ever for the reader. Keeping both means the field can be read in either
  // language without asking the platform what a place is called again.
  String _from = 'Dhaka', _fromBn = 'ঢাকা';
  String _to = 'Chattogram', _toBn = 'চট্টগ্রাম';
  DateTime _when = DateTime.now();

  void _swap() {
    setState(() {
      final n = _from, nb = _fromBn;
      _from = _to;
      _fromBn = _toBn;
      _to = n;
      _toBn = nb;
    });
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _when,
      firstDate: now.subtract(const Duration(days: 1)),
      // The platform generates trips on a rolling 30-day horizon, so offering
      // a date beyond it would only produce an empty result somebody blames on
      // the app rather than on the timetable.
      lastDate: now.add(const Duration(days: 30)),
    );
    if (picked != null) setState(() => _when = picked);
  }

  void _go() {
    if (_from.isEmpty || _to.isEmpty) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ResultsScreen(from: _from, to: _to, date: isoDate(_when)),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final app = AppScope.of(context);
    final saved = app.store.savedRoutes();

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          SliverAppBar(
            pinned: true,
            expandedHeight: 108,
            backgroundColor: J.field,
            flexibleSpace: FlexibleSpaceBar(
              titlePadding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              // Once this device has bought a ticket it knows whose it is, and
              // says so by name. Nothing is unlocked by this — see
              // Store.traveller — it is only the difference between an app that
              // recognises you and one that does not.
              title: Text(
                app.known && app.displayName != null
                    ? l('find.hello', {'name': app.displayName!.split(' ').first})
                    : l('app.passenger'),
                style: const TextStyle(
                    color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700),
              ),
            ),
            actions: const [
              Padding(padding: EdgeInsets.only(right: 12), child: Center(child: LanguageToggle(onLight: true))),
            ],
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: PlaceField(
                                  label: l('find.from'),
                                  value: _from,
                                  valueBn: _fromBn,
                                  api: app.api,
                                  store: app.store,
                                  onChanged: (p) => setState(() {
                                    _from = p.name;
                                    _fromBn = p.nameBn;
                                  }),
                                ),
                              ),
                              // The swap sits between the two fields because
                              // that is where the journey reverses, and half
                              // of all searches are a return trip typed again.
                              IconButton(
                                onPressed: _swap,
                                tooltip: l('find.swap'),
                                icon: const Icon(Icons.swap_horiz),
                              ),
                              Expanded(
                                child: PlaceField(
                                  label: l('find.to'),
                                  value: _to,
                                  valueBn: _toBn,
                                  api: app.api,
                                  store: app.store,
                                  onChanged: (p) => setState(() {
                                    _to = p.name;
                                    _toBn = p.nameBn;
                                  }),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          InkWell(
                            onTap: _pickDate,
                            borderRadius: BorderRadius.circular(J.radius),
                            child: InputDecorator(
                              decoration: InputDecoration(labelText: l('find.when')),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(dayOf(_when.toIso8601String(), l),
                                      style: const TextStyle(fontSize: 16)),
                                  const Icon(Icons.calendar_today_outlined, size: 18, color: J.muted),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(height: 16),
                          FilledButton(onPressed: _go, child: Text(l('find.go'))),
                        ],
                      ),
                    ),
                  ),
                  if (saved.isNotEmpty) ...[
                    const SizedBox(height: 20),
                    Text(l('ac.savedRoutes'),
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final r in saved)
                          ActionChip(
                            avatar: const Icon(Icons.directions_bus_outlined, size: 17),
                            label: Text('${r.from} → ${r.to}'),
                            onPressed: () {
                              // A saved route holds canonical names only, so
                              // the Bangla labels are cleared rather than left
                              // pointing at the previous pair of places.
                              setState(() {
                                _from = r.from;
                                _fromBn = '';
                                _to = r.to;
                                _toBn = '';
                              });
                              _go();
                            },
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

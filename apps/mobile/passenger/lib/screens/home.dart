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
  final _from = TextEditingController(text: 'Dhaka');
  final _to = TextEditingController(text: 'Chattogram');
  DateTime _when = DateTime.now();

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    super.dispose();
  }

  void _swap() {
    final a = _from.text;
    setState(() {
      _from.text = _to.text;
      _to.text = a;
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
    final from = _from.text.trim();
    final to = _to.text.trim();
    if (from.isEmpty || to.isEmpty) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ResultsScreen(from: from, to: to, date: isoDate(_when)),
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
              title: Text(l('app.passenger'),
                  style: const TextStyle(
                      color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700)),
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
                                child: TextField(
                                  controller: _from,
                                  textInputAction: TextInputAction.next,
                                  decoration: InputDecoration(labelText: l('find.from')),
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
                                child: TextField(
                                  controller: _to,
                                  textInputAction: TextInputAction.done,
                                  decoration: InputDecoration(labelText: l('find.to')),
                                  onSubmitted: (_) => _go(),
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
                              setState(() {
                                _from.text = r.from;
                                _to.text = r.to;
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

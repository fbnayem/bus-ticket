import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import 'ticket.dart';

/// Everything this phone can show at a bus door.
///
/// Read from the device, then refreshed from the platform — never the other way
/// round. A passenger opening this list in a basement terminal sees their
/// tickets, not a spinner.
class TicketsScreen extends StatefulWidget {
  const TicketsScreen({super.key});

  @override
  State<TicketsScreen> createState() => _TicketsScreenState();
}

class _TicketsScreenState extends State<TicketsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final app = AppScope.of(context);
      await app.refreshTickets();
      await app.pullAccountTickets();
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final app = AppScope.of(context);
    final all = app.tickets;

    final now = DateTime.now();
    final upcoming = all.where((b) {
      final d = b.departure;
      return d == null || d.isAfter(now.subtract(const Duration(hours: 6)));
    }).toList();
    final past = all.where((b) => !upcoming.contains(b)).toList().reversed.toList();

    return Scaffold(
      appBar: AppBar(title: Text(l('nav.tickets'))),
      body: RefreshIndicator(
        onRefresh: () async {
          await app.refreshTickets();
          await app.pullAccountTickets();
        },
        child: all.isEmpty
            ? ListView(children: [
                const SizedBox(height: 60),
                Nothing(title: l('tk.none'), hint: l('tk.noneHint')),
              ])
            : ListView(
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
                children: [
                  if (upcoming.isNotEmpty) ...[
                    _Heading(l('tk.upcoming')),
                    for (final b in upcoming) _Row(booking: b),
                  ],
                  if (past.isNotEmpty) ...[
                    const SizedBox(height: 18),
                    _Heading(l('tk.past')),
                    for (final b in past) _Row(booking: b, faded: true),
                  ],
                ],
              ),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: J.ink2)),
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.booking, this.faded = false});

  final Booking booking;
  final bool faded;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Opacity(
        opacity: faded ? .62 : 1,
        child: Card(
          child: InkWell(
            borderRadius: BorderRadius.circular(J.radius),
            onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => TicketScreen(pnr: booking.pnr))),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(timeOf(booking.departAt, l.lang),
                          style: const TextStyle(
                              fontSize: 22, fontWeight: FontWeight.w700, height: 1.05)),
                      Text(dayOf(booking.departAt, l),
                          style: const TextStyle(color: J.muted, fontSize: 12.5)),
                    ],
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${booking.origin} → ${booking.destination}',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 3),
                        Text('${booking.brand} · ${l('common.seats')} ${booking.seats.join(', ')}',
                            style: const TextStyle(color: J.muted, fontSize: 13)),
                        const SizedBox(height: 8),
                        Pill(
                          kStrings.containsKey('status.${booking.status}')
                              ? l('status.${booking.status}')
                              : booking.status,
                          tone: toneOf(booking.status),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right, color: J.muted),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

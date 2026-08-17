import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';

/// Cancelling.
///
/// The figure comes from the platform, which resolves the policy — operator,
/// then route, then schedule, then class, then channel, then time tier. It is
/// never worked out here, and it is shown *before* anything is asked, because
/// "are you sure?" is not a fair question until somebody knows what it costs.
///
/// The ladder underneath exists because the single number invites the same
/// follow-up every time: what if I had cancelled yesterday? Showing the rungs
/// with the passenger's own marked answers it without a support call.
class RefundScreen extends StatefulWidget {
  const RefundScreen({super.key, required this.booking});
  final Booking booking;

  @override
  State<RefundScreen> createState() => _RefundScreenState();
}

class _RefundScreenState extends State<RefundScreen> {
  CancellationQuote? _quote;
  String _error = '';
  bool _busy = false;
  bool _done = false;
  final _reason = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final q = await AppScope.of(context).api.cancellationQuote(widget.booking.pnr);
      if (mounted) setState(() => _quote = q);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _cancel() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final app = AppScope.of(context);
    try {
      final result = await app.api.cancel(
        widget.booking.pnr,
        _reason.text.trim(),
        idempotencyKey: newIdempotencyKey('cancel'),
      );
      // Re-read rather than assume: the booking's new state, and whether a
      // refund was raised, are the platform's to report.
      try {
        await app.keep(await app.api.booking(widget.booking.pnr));
      } on ApiError {
        await app.forget(widget.booking.pnr);
      }
      if (!mounted) return;
      setState(() {
        _quote = result;
        _done = true;
        _busy = false;
      });
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
    final q = _quote;

    return Scaffold(
      appBar: AppBar(title: Text(l('rf.title'))),
      body: q == null
          ? (_error.isNotEmpty
              ? ListView(children: [
                  Padding(padding: const EdgeInsets.all(16), child: ErrorNotice(_error, onRetry: _load)),
                ])
              : const Waiting())
          : ListView(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
              children: [
                if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],

                if (_done)
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: J.okTint,
                      borderRadius: BorderRadius.circular(J.radius),
                    ),
                    child: Text(l('rf.done', {'amount': taka(q.refundPoisha)}),
                        style: const TextStyle(color: J.ok, fontSize: 16, height: 1.4)),
                  )
                else if (!q.cancellable)
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: J.warnTint,
                      borderRadius: BorderRadius.circular(J.radius),
                    ),
                    child: Text(q.reason.isEmpty ? l('rf.cannot') : q.reason,
                        style: const TextStyle(color: J.warn, fontSize: 15, height: 1.4)),
                  )
                else ...[
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(18),
                      child: MoneyLine(
                        what: l('rf.getBack'),
                        amount: taka(q.refundPoisha),
                        how: '${l('rf.ofPaid', {'amount': taka(q.totalPoisha)})} · '
                            '${l('rf.becauseHours', {'hours': q.hoursBefore})}',
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(l('rf.ladder'),
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  _Ladder(current: q.refundPct),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _reason,
                    decoration: InputDecoration(labelText: l('rf.reason')),
                  ),
                  const SizedBox(height: 18),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: J.danger),
                    onPressed: _busy ? null : _cancel,
                    child: Text(l('rf.confirm')),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text(l('rf.keep')),
                  ),
                ],
              ],
            ),
    );
  }
}

/// The platform's default tiers, with the passenger's own rung marked.
///
/// These mirror the cancellation policy the platform applies; an operator can
/// override them, which is why the marked rung comes from the server's answer
/// rather than being computed from the hours here.
class _Ladder extends StatelessWidget {
  const _Ladder({required this.current});
  final int current;

  static const _rungs = [
    (hours: '24+', pct: 90),
    (hours: '12–24', pct: 70),
    (hours: '6–12', pct: 50),
    (hours: '<6', pct: 0),
  ];

  @override
  Widget build(BuildContext context) => Card(
        child: Column(
          children: [
            for (var i = 0; i < _rungs.length; i++) ...[
              if (i > 0) const Divider(height: 1),
              Container(
                color: _rungs[i].pct == current ? J.fieldTint : null,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                child: Row(
                  children: [
                    if (_rungs[i].pct == current)
                      const Padding(
                        padding: EdgeInsets.only(right: 8),
                        child: Icon(Icons.arrow_right_alt, size: 18, color: J.field),
                      ),
                    Expanded(
                      child: Text('${_rungs[i].hours} h',
                          style: TextStyle(
                              fontSize: 15,
                              fontWeight: _rungs[i].pct == current
                                  ? FontWeight.w700
                                  : FontWeight.w400,
                              fontFeatures: const [FontFeature.tabularFigures()])),
                    ),
                    Text('${_rungs[i].pct}%',
                        style: TextStyle(
                            fontSize: 15,
                            fontWeight: _rungs[i].pct == current
                                ? FontWeight.w700
                                : FontWeight.w500,
                            color: _rungs[i].pct == current ? J.field : J.ink2,
                            fontFeatures: const [FontFeature.tabularFigures()])),
                  ],
                ),
              ),
            ],
          ],
        ),
      );
}

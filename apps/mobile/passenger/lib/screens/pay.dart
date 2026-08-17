import 'dart:async';

import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import 'ticket.dart';

/// Paying.
///
/// The rule this screen exists to obey, and the one it would be easiest to
/// break: **this app never confirms a payment.** Tapping "approve" tells the
/// provider's sandbox that the customer finished. What issues the ticket is the
/// platform's own verified webhook chain — signature, then provider, then
/// amount, then currency, then booking, then idempotency — and this screen
/// finds out by *asking the platform what happened*, not by assuming.
///
/// That is why there is a waiting state here at all. It would be trivial to
/// jump straight to a success page, and it has been the cause of a great many
/// tickets that were never paid for.
class PayScreen extends StatefulWidget {
  const PayScreen({super.key, required this.booking, required this.trip});

  final Booking booking;
  final TripSummary trip;

  @override
  State<PayScreen> createState() => _PayScreenState();
}

enum _Stage { choosing, atProvider, waiting, failed }

class _PayScreenState extends State<PayScreen> {
  _Stage _stage = _Stage.choosing;
  String _provider = 'BKASH';
  String _paymentRef = '';
  String _error = '';
  bool _busy = false;
  int _asked = 0;

  Future<void> _startPayment() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final intent =
          await AppScope.of(context).api.paymentIntent(widget.booking.bookingId, _provider);
      if (!mounted) return;
      setState(() {
        _paymentRef = '${intent['payment_ref']}';
        _stage = _Stage.atProvider;
        _busy = false;
      });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = L.of(context).error(e);
        _busy = false;
      });
    }
  }

  Future<void> _finishAtProvider({required bool approve}) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final app = AppScope.of(context);
    try {
      await app.api.completeSandboxPayment(_paymentRef, success: approve);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = L.of(context).error(e);
        _busy = false;
      });
      return;
    }

    if (!mounted) return;
    if (!approve) {
      setState(() {
        _stage = _Stage.failed;
        _busy = false;
      });
      return;
    }
    setState(() {
      _stage = _Stage.waiting;
      _busy = false;
    });
    await _waitForTheWebhook();
  }

  /// Ask the platform what actually happened.
  ///
  /// The webhook arrives at the platform, not at this phone, so the only honest
  /// thing a client can do is re-read the booking until the platform says it is
  /// ticketed. Twenty attempts at one second is generous for a sandbox and
  /// still bounded, so a provider that never calls back produces a clear
  /// failure rather than a spinner forever.
  Future<void> _waitForTheWebhook() async {
    final app = AppScope.of(context);
    for (var attempt = 0; attempt < 20; attempt++) {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (!mounted) return;
      setState(() => _asked = attempt + 1);
      try {
        final fresh = await app.api.booking(widget.booking.pnr);
        if (fresh.confirmed) {
          await app.keep(fresh);
          if (!mounted) return;
          await Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => TicketScreen(pnr: fresh.pnr)),
          );
          return;
        }
        if (fresh.status == 'FAILED' || fresh.status == 'EXPIRED') {
          if (!mounted) return;
          setState(() => _stage = _Stage.failed);
          return;
        }
      } on ApiError {
        // Keep asking. A dropped request while the platform is confirming is
        // not evidence of anything either way.
      }
    }
    if (mounted) setState(() => _stage = _Stage.failed);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l('pay.title')),
        automaticallyImplyLeading: _stage == _Stage.choosing,
      ),
      body: switch (_stage) {
        _Stage.choosing => _choose(l),
        _Stage.atProvider => _atProvider(l),
        _Stage.waiting => _waiting(l),
        _Stage.failed => _failed(l),
      },
    );
  }

  Widget _choose(L l) => ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
        children: [
          if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: MoneyLine(
                what: l('common.total'),
                amount: taka(widget.booking.totalPoisha),
                how: '${widget.booking.seats.join(', ')} · '
                    '${widget.trip.brand} · ${timeOf(widget.trip.departAt, l.lang)}',
              ),
            ),
          ),
          const SizedBox(height: 18),
          Text(l('pay.how'), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          _Provider(
            id: 'BKASH',
            label: l('pay.bkash'),
            colour: J.bkash,
            selected: _provider == 'BKASH',
            onTap: () => setState(() => _provider = 'BKASH'),
          ),
          const SizedBox(height: 8),
          _Provider(
            id: 'NAGAD',
            label: l('pay.nagad'),
            colour: J.nagad,
            selected: _provider == 'NAGAD',
            onTap: () => setState(() => _provider = 'NAGAD'),
          ),
          const SizedBox(height: 8),
          _Provider(
            id: 'CARD',
            label: l('pay.card'),
            colour: J.ink2,
            selected: _provider == 'CARD',
            onTap: () => setState(() => _provider = 'CARD'),
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _startPayment,
            child: Text(l('pay.now', {'amount': taka(widget.booking.totalPoisha)})),
          ),
          const SizedBox(height: 12),
          Text(l('pay.confirmNote'),
              style: const TextStyle(color: J.muted, fontSize: 13, height: 1.45)),
        ],
      );

  /// Stands in for the provider's own page.
  ///
  /// In a live build this is where the passenger leaves for bKash and comes
  /// back; the platform's behaviour on return is identical either way, because
  /// it does not trust the return either.
  Widget _atProvider(L l) => ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: (_provider == 'BKASH' ? J.bkash : _provider == 'NAGAD' ? J.nagad : J.ink2)
                  .withValues(alpha: .08),
              borderRadius: BorderRadius.circular(J.radius),
              border: Border.all(
                  color: _provider == 'BKASH' ? J.bkash : _provider == 'NAGAD' ? J.nagad : J.ink2),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                    l('pay.working', {
                      'provider': _provider == 'BKASH'
                          ? l('pay.bkash')
                          : _provider == 'NAGAD'
                              ? l('pay.nagad')
                              : l('pay.card')
                    }),
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                Text(taka(widget.booking.totalPoisha),
                    style: const TextStyle(
                        fontSize: 30,
                        fontWeight: FontWeight.w700,
                        fontFeatures: [FontFeature.tabularFigures()])),
                const SizedBox(height: 8),
                Text(l('pay.sandbox'), style: const TextStyle(color: J.muted, fontSize: 13)),
              ],
            ),
          ),
          if (_error.isNotEmpty) ...[const SizedBox(height: 12), ErrorNotice(_error)],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : () => _finishAtProvider(approve: true),
            child: Text(l('pay.approve')),
          ),
          const SizedBox(height: 8),
          OutlinedButton(
            onPressed: _busy ? null : () => _finishAtProvider(approve: false),
            child: Text(l('pay.decline')),
          ),
        ],
      );

  Widget _waiting(L l) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(
                width: 34, height: 34,
                child: CircularProgressIndicator(strokeWidth: 3, color: J.field),
              ),
              const SizedBox(height: 20),
              Text(l('pay.checking'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              const SizedBox(height: 10),
              Text(l('pay.confirmNote'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: J.muted, fontSize: 14, height: 1.45)),
              if (_asked > 3) ...[
                const SizedBox(height: 12),
                Text('$_asked',
                    style: const TextStyle(
                        color: J.muted,
                        fontSize: 13,
                        fontFeatures: [FontFeature.tabularFigures()])),
              ],
            ],
          ),
        ),
      );

  Widget _failed(L l) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const SizedBox(height: 30),
          Nothing(
            title: l('pay.failed'),
            action: Column(
              children: [
                FilledButton(
                  onPressed: () => setState(() {
                    _stage = _Stage.choosing;
                    _error = '';
                    _asked = 0;
                  }),
                  child: Text(l('common.retry')),
                ),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: () => Navigator.of(context)
                      .popUntil((route) => route.isFirst),
                  child: Text(l('common.close')),
                ),
              ],
            ),
          ),
        ],
      );
}

class _Provider extends StatelessWidget {
  const _Provider({
    required this.id,
    required this.label,
    required this.colour,
    required this.selected,
    required this.onTap,
  });

  final String id, label;
  final Color colour;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(J.radius),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: J.plate,
            borderRadius: BorderRadius.circular(J.radius),
            border: Border.all(color: selected ? colour : J.rule, width: selected ? 2 : 1),
          ),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: colour,
                  borderRadius: BorderRadius.circular(J.radiusSm),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(label,
                    style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
              ),
              Icon(selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  color: selected ? colour : J.rule),
            ],
          ),
        ),
      );
}

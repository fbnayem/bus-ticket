import 'dart:async';

import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import 'pay.dart';

/// Who is travelling, and the countdown they are travelling against.
///
/// The clock at the top is the honest part of this screen. The seats are held
/// by the platform for a fixed window and then released to whoever wants them
/// next; showing that plainly is kinder than letting somebody fill in four
/// names and discover at the payment step that the seats went.
class PassengersScreen extends StatefulWidget {
  const PassengersScreen({super.key, required this.trip, required this.hold});

  final TripSummary trip;
  final Hold hold;

  @override
  State<PassengersScreen> createState() => _PassengersScreenState();
}

class _PassengersScreenState extends State<PassengersScreen> {
  late final List<TextEditingController> _names =
      widget.hold.seats.map((_) => TextEditingController()).toList();
  late final TextEditingController _phone =
      TextEditingController(text: AppScope.read(context).phone ?? '');
  final _genders = <String, String>{};

  Timer? _tick;
  Duration _left = Duration.zero;
  String _error = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _left = widget.hold.remaining;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _left = widget.hold.remaining);
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    for (final c in _names) {
      c.dispose();
    }
    _phone.dispose();
    super.dispose();
  }

  bool get _expired => _left.isNegative || _left == Duration.zero;

  Future<void> _continue() async {
    final l = L.of(context);
    if (_names.any((c) => c.text.trim().isEmpty)) {
      setState(() => _error = l('pax.needName'));
      return;
    }
    final phone = _phone.text.trim();
    if (phone.replaceAll(RegExp(r'\D'), '').length < 11) {
      setState(() => _error = l('pax.needPhone'));
      return;
    }

    setState(() {
      _busy = true;
      _error = '';
    });

    final app = AppScope.of(context);
    try {
      final booking = await app.api.createBooking(
        holdId: widget.hold.holdId,
        passengers: [
          for (var i = 0; i < widget.hold.seats.length; i++)
            PassengerDetail(
              seatNo: widget.hold.seats[i],
              fullName: _names[i].text.trim(),
              gender: _genders[widget.hold.seats[i]],
            ),
        ],
        phone: phone,
        idempotencyKey: newIdempotencyKey('book'),
      );
      if (!mounted) return;
      setState(() => _busy = false);
      await Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => PayScreen(booking: booking, trip: widget.trip),
      ));
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
    final price = widget.hold.price;

    return Scaffold(
      appBar: AppBar(title: Text(l('pax.title'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
        children: [
          _Countdown(left: _left, expired: _expired),
          const SizedBox(height: 12),
          if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],

          if (_expired)
            Nothing(
              title: l('hold.gone'),
              action: FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text(l('hold.pickAgain')),
              ),
            )
          else ...[
            for (var i = 0; i < widget.hold.seats.length; i++) ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                          decoration: BoxDecoration(
                            color: J.fieldTint,
                            borderRadius: BorderRadius.circular(J.radiusSm),
                          ),
                          child: Text(widget.hold.seats[i],
                              style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: J.field,
                                  fontFeatures: [FontFeature.tabularFigures()])),
                        ),
                      ]),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _names[i],
                        textCapitalization: TextCapitalization.words,
                        decoration: InputDecoration(
                          labelText: l('pax.name'),
                          helperText: i == 0 ? l('pax.nameHint') : null,
                          helperMaxLines: 2,
                        ),
                      ),
                      const SizedBox(height: 10),
                      SegmentedButton<String>(
                        segments: [
                          ButtonSegment(value: 'MALE', label: Text(l('pax.male'))),
                          ButtonSegment(value: 'FEMALE', label: Text(l('pax.female'))),
                        ],
                        selected: {_genders[widget.hold.seats[i]] ?? 'MALE'},
                        onSelectionChanged: (v) =>
                            setState(() => _genders[widget.hold.seats[i]] = v.first),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),
            ],
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: InputDecoration(
                    labelText: l('common.phone'),
                    helperText: l('pax.phoneHint'),
                    helperMaxLines: 2,
                    prefixText: '',
                  ),
                ),
              ),
            ),
            if (price != null) ...[
              const SizedBox(height: 14),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(children: [
                    KeyValue(l('pay.fare', {'n': price.seatCount}), taka(price.basePoisha)),
                    if (price.serviceFeePoisha > 0)
                      KeyValue(l('pay.fee'), taka(price.serviceFeePoisha)),
                    if (price.discountPoisha > 0)
                      KeyValue(l('pay.discount'), '− ${taka(price.discountPoisha)}', tone: J.ok),
                    const Divider(height: 18),
                    KeyValue(l('common.total'), taka(price.totalPoisha), strong: true),
                  ]),
                ),
              ),
            ],
            const SizedBox(height: 18),
            FilledButton(
              onPressed: _busy ? null : _continue,
              child: Text(l('common.next')),
            ),
          ],
        ],
      ),
    );
  }
}

class _Countdown extends StatelessWidget {
  const _Countdown({required this.left, required this.expired});

  final Duration left;
  final bool expired;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    if (expired) {
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: J.dangerTint,
          borderRadius: BorderRadius.circular(J.radius),
        ),
        child: Text(l('hold.gone'),
            style: const TextStyle(color: J.danger, fontSize: 15, fontWeight: FontWeight.w600)),
      );
    }

    final mins = left.inMinutes;
    final secs = left.inSeconds % 60;
    // Under two minutes the bar turns; above it, a countdown in red for ten
    // minutes is just an alarm nobody can act on.
    final urgent = left.inSeconds < 120;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: urgent ? J.warnTint : J.fieldTint,
        borderRadius: BorderRadius.circular(J.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l('hold.left', {
              'mins': '$mins',
              'secs': secs < 10 ? '0$secs' : '$secs',
            }),
            style: TextStyle(
              color: urgent ? J.warn : J.field,
              fontSize: 17,
              fontWeight: FontWeight.w700,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 2),
          Text(l('hold.why'),
              style: TextStyle(color: urgent ? J.warn : J.field, fontSize: 13)),
        ],
      ),
    );
  }
}

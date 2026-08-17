import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:screen_brightness/screen_brightness.dart';

import '../app_state.dart';
import 'refund.dart';
import 'tracking.dart';

/// The ticket.
///
/// This screen is the entire argument for the app existing rather than a
/// website. It reads from the device first and the platform second, so it opens
/// at the door of a bus in a place with no bars — which is where a ticket is
/// actually needed and precisely where a web page is a blank screen.
///
/// The QR is a signed opaque token issued by the platform. It carries no
/// personal details and no fare; it is a key the boarding scanner checks
/// against the central record, so a screenshot of it is worth nothing once the
/// seat is marked boarded.
class TicketScreen extends StatefulWidget {
  const TicketScreen({super.key, required this.pnr});
  final String pnr;

  @override
  State<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends State<TicketScreen> {
  Booking? _booking;
  bool _fromDevice = false;
  bool _brightened = false;

  @override
  void initState() {
    super.initState();
    _booking = AppScope.of(context).store.cachedTicket(widget.pnr);
    _fromDevice = _booking != null;
    _refresh();
    _brighten();
  }

  @override
  void dispose() {
    if (_brightened) ScreenBrightness().resetApplicationScreenBrightness();
    super.dispose();
  }

  /// A cheap phone at half brightness in a dark doorway is a QR a scanner
  /// cannot read, and the passenger gets blamed for it. Restored on the way
  /// out, because nobody asked for a torch.
  Future<void> _brighten() async {
    try {
      await ScreenBrightness().setApplicationScreenBrightness(1.0);
      if (mounted) setState(() => _brightened = true);
    } catch (_) {
      // Some devices refuse. The ticket is still perfectly valid.
    }
  }

  Future<void> _refresh() async {
    final app = AppScope.of(context);
    try {
      final fresh = await app.api.booking(widget.pnr);
      await app.keep(fresh);
      if (mounted) {
        setState(() {
          _booking = fresh;
          _fromDevice = false;
        });
      }
    } on ApiError {
      // No line, or the platform is unhappy. Either way the copy on the device
      // is what the passenger has, and it is shown rather than hidden.
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final b = _booking;

    if (b == null) {
      return Scaffold(
        appBar: AppBar(title: Text(l('tk.yours'))),
        body: const Waiting(),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(l('tk.yours')),
        actions: [
          IconButton(
            tooltip: l('tk.track'),
            icon: const Icon(Icons.travel_explore),
            onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => TrackingScreen(pnr: b.pnr))),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
          children: [
            _Stub(booking: b),
            const SizedBox(height: 12),
            if (_fromDevice)
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: J.fieldTint,
                  borderRadius: BorderRadius.circular(J.radius),
                ),
                child: Row(children: [
                  const Icon(Icons.offline_pin_outlined, size: 18, color: J.field),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(l('tk.savedOnPhone'),
                        style: const TextStyle(color: J.field, fontSize: 13.5, height: 1.35)),
                  ),
                ]),
              ),
            const SizedBox(height: 14),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(children: [
                  KeyValue(l('find.from'), b.origin),
                  KeyValue(l('find.to'), b.destination),
                  KeyValue(l('find.when'), dateTimeOf(b.departAt, l.lang)),
                  KeyValue(l('common.seats'), b.seats.join(', ')),
                  const Divider(height: 18),
                  KeyValue(l('common.total'), taka(b.totalPoisha), strong: true),
                ]),
              ),
            ),
            const SizedBox(height: 14),
            if (b.confirmed)
              OutlinedButton.icon(
                onPressed: () async {
                  await Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => RefundScreen(booking: b)));
                  await _refresh();
                },
                icon: const Icon(Icons.cancel_outlined),
                label: Text(l('tk.cancel')),
              ),
          ],
        ),
      ),
    );
  }
}

/// Drawn as a ticket stub, with a torn edge, because that is the object this
/// is standing in for and it is instantly recognisable at a bus door.
class _Stub extends StatelessWidget {
  const _Stub({required this.booking});
  final Booking booking;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final ticket = booking.tickets.isEmpty ? null : booking.tickets.first;

    return Container(
      decoration: BoxDecoration(
        color: J.plate,
        borderRadius: BorderRadius.circular(J.radius),
        border: Border.all(color: J.ruleStrong),
      ),
      child: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            decoration: const BoxDecoration(
              color: J.field,
              borderRadius: BorderRadius.vertical(top: Radius.circular(J.radius)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${booking.origin} → ${booking.destination}',
                          style: const TextStyle(
                              color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Text('${booking.brand} · ${dateTimeOf(booking.departAt, l.lang)}',
                          style: const TextStyle(color: Colors.white70, fontSize: 13)),
                    ],
                  ),
                ),
                Pill(
                  kStrings.containsKey('status.${booking.status}')
                      ? l('status.${booking.status}')
                      : booking.status,
                  tone: toneOf(booking.status),
                ),
              ],
            ),
          ),

          Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 8),
            child: Column(
              children: [
                Text(l('tk.show'),
                    style: const TextStyle(color: J.muted, fontSize: 14)),
                const SizedBox(height: 12),
                if (ticket != null && ticket.qrToken.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.all(10),
                    color: Colors.white,
                    child: QrImageView(
                      data: ticket.qrToken,
                      version: QrVersions.auto,
                      size: 210,
                      // Error correction high: this gets scanned off a cracked
                      // screen under a doorway light more often than not.
                      errorCorrectionLevel: QrErrorCorrectLevel.H,
                      backgroundColor: Colors.white,
                      eyeStyle: const QrEyeStyle(
                          eyeShape: QrEyeShape.square, color: Colors.black),
                      dataModuleStyle: const QrDataModuleStyle(
                          dataModuleShape: QrDataModuleShape.square, color: Colors.black),
                    ),
                  )
                else
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 30),
                    child: Text(l('status.PAYMENT_PENDING'),
                        style: const TextStyle(color: J.muted, fontSize: 15)),
                  ),
                const SizedBox(height: 14),
              ],
            ),
          ),

          // The tear. Two notches and a dashed rule — the same shape as the
          // paper ticket a counter prints, so the object is recognisable
          // before a single word is read.
          const _Tear(),

          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(l('common.ticketNo'),
                        style: const TextStyle(color: J.muted, fontSize: 12)),
                    Text(booking.pnr,
                        style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.5,
                            fontFeatures: [FontFeature.tabularFigures()])),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(l('common.seats'),
                        style: const TextStyle(color: J.muted, fontSize: 12)),
                    Text(booking.seats.join(', '),
                        style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            fontFeatures: [FontFeature.tabularFigures()])),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Tear extends StatelessWidget {
  const _Tear();

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 20,
        child: Row(
          children: [
            _notch(right: true),
            Expanded(child: CustomPaint(painter: _DashPainter(), size: const Size.fromHeight(1))),
            _notch(right: false),
          ],
        ),
      );

  Widget _notch({required bool right}) => Container(
        width: 18,
        height: 18,
        decoration: BoxDecoration(
          color: J.ground,
          shape: BoxShape.circle,
          border: Border.all(color: J.ruleStrong),
        ),
        transform: Matrix4.translationValues(right ? -9.5 : 9.5, 1, 0),
      );
}

class _DashPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = J.rule
      ..strokeWidth = 1.2;
    const dash = 6.0, gap = 5.0;
    var x = 0.0;
    final y = size.height / 2;
    while (x < size.width) {
      canvas.drawLine(Offset(x, y), Offset(x + dash, y), paint);
      x += dash + gap;
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

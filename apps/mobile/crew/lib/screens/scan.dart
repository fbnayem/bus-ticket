import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../boarding.dart';

/// The door.
///
/// Everything on this screen is arranged around one fact: the person holding
/// this phone has about half a second before the next passenger pushes forward.
/// So the verdict is an instruction — "Let them on" — at the size of the
/// screen, in the colour of the answer, and the platform's own sentence sits
/// underneath for the cases that need one. "BOARDED" is a database word that
/// answers a different question.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.trip, required this.boarding});

  final CrewTrip trip;
  final Boarding boarding;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );
  final _typed = TextEditingController();

  ScanVerdict? _last;
  final List<ScanVerdict> _recent = [];
  bool _checking = false;
  bool _typing = false;
  String _error = '';
  int _waiting = 0;

  @override
  void initState() {
    super.initState();
    _waiting = widget.boarding.waiting;
    // Anything queued from a stretch without signal goes out the moment this
    // screen opens, which is usually the moment the bus reaches a town.
    _flush(quiet: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    _typed.dispose();
    super.dispose();
  }

  Future<void> _check(String code) async {
    if (_checking || code.trim().isEmpty) return;
    setState(() {
      _checking = true;
      _error = '';
    });
    try {
      final v = await widget.boarding.check(
        tripId: widget.trip.tripId,
        pnr: code,
        l: L.of(context),
      );
      if (!mounted) return;
      setState(() {
        _last = v;
        _recent.insert(0, v);
        if (_recent.length > 12) _recent.removeLast();
        _waiting = widget.boarding.waiting;
        _checking = false;
        _typed.clear();
      });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = L.of(context).error(e);
        _checking = false;
      });
    }
  }

  Future<void> _flush({bool quiet = false}) async {
    final n = await widget.boarding.flush();
    if (!mounted) return;
    setState(() => _waiting = widget.boarding.waiting);
    if (quiet || n == 0) return;
    final l = L.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(n == 1 ? l('sc.sent1') : l('sc.sent', {'n': n}))),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: J.crew,
        title: Text(l('sc.title')),
        actions: [
          IconButton(
            tooltip: _typing ? l('sc.scan') : l('sc.type'),
            icon: Icon(_typing ? Icons.qr_code_scanner : Icons.keyboard),
            onPressed: () => setState(() => _typing = !_typing),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_waiting > 0)
            QueueBar(
              label: _waiting == 1 ? l('sc.waiting1') : l('sc.waiting', {'n': _waiting}),
              action: l('sc.sendNow'),
              onAction: _flush,
            ),
          SizedBox(
            height: 240,
            child: _typing ? _typePanel(l) : _cameraPanel(l),
          ),
          if (_error.isNotEmpty)
            Padding(padding: const EdgeInsets.all(12), child: ErrorNotice(_error)),
          if (_last != null) _Verdict(verdict: _last!),
          Expanded(child: _recentList(l)),
        ],
      ),
    );
  }

  Widget _cameraPanel(L l) => Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: (capture) {
              final raw = capture.barcodes.firstOrNull?.rawValue;
              if (raw != null) _check(raw);
            },
            errorBuilder: (context, error) => Container(
              color: J.crew,
              alignment: Alignment.center,
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(l('sc.cameraDenied'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: J.crewInk, fontSize: 15)),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => setState(() => _typing = true),
                    child: Text(l('sc.type')),
                  ),
                ],
              ),
            ),
          ),
          IgnorePointer(
            child: Center(
              child: Container(
                width: 190,
                height: 190,
                decoration: BoxDecoration(
                  border: Border.all(color: J.mark, width: 3),
                  borderRadius: BorderRadius.circular(J.radius),
                ),
              ),
            ),
          ),
        ],
      );

  Widget _typePanel(L l) => Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _typed,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(labelText: l('sc.number'), hintText: 'K7W4VP'),
              style: const TextStyle(
                  fontSize: 24, letterSpacing: 2, fontFeatures: [FontFeature.tabularFigures()]),
              onSubmitted: _check,
            ),
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: J.field),
              onPressed: _checking ? null : () => _check(_typed.text),
              child: Text(l('sc.go')),
            ),
          ],
        ),
      );

  Widget _recentList(L l) {
    if (_recent.isEmpty) return const SizedBox.shrink();
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
      children: [
        Text(l('sc.recent'), style: const TextStyle(color: J.muted, fontSize: 13)),
        const SizedBox(height: 6),
        for (final v in _recent)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                SizedBox(
                  width: 78,
                  child: Text(v.pnr,
                      style: const TextStyle(
                          fontSize: 14, fontFeatures: [FontFeature.tabularFigures()])),
                ),
                SizedBox(
                  width: 46,
                  child: Text(v.seatNo,
                      style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          fontFeatures: [FontFeature.tabularFigures()])),
                ),
                Expanded(
                  child: Pill(
                    v.letThemOn ? l('sc.ok') : v.alreadyOn ? l('sc.already') : l('sc.bad'),
                    tone: v.letThemOn
                        ? PillTone.ok
                        : v.alreadyOn
                            ? PillTone.warn
                            : PillTone.danger,
                  ),
                ),
                if (v.queued)
                  const Icon(Icons.schedule, size: 16, color: J.warn),
              ],
            ),
          ),
      ],
    );
  }
}

class _Verdict extends StatelessWidget {
  const _Verdict({required this.verdict});
  final ScanVerdict verdict;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final (bg, fg, headline) = verdict.letThemOn
        ? (J.okTint, J.ok, l('sc.ok'))
        : verdict.alreadyOn
            ? (J.warnTint, J.warn, l('sc.already'))
            : (J.dangerTint, J.danger, l('sc.bad'));

    return Container(
      width: double.infinity,
      color: bg,
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(headline,
              style: TextStyle(fontSize: 27, fontWeight: FontWeight.w700, color: fg, height: 1.1)),
          if (verdict.seatNo.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(l('sc.seatIs', {'seat': verdict.seatNo}),
                style: const TextStyle(
                    fontSize: 19,
                    fontWeight: FontWeight.w600,
                    fontFeatures: [FontFeature.tabularFigures()])),
          ],
          if (verdict.passenger.isNotEmpty)
            Text(verdict.passenger, style: const TextStyle(fontSize: 15, color: J.ink2)),
          const SizedBox(height: 4),
          Text(verdict.words(l), style: const TextStyle(fontSize: 14, height: 1.35)),
          if (verdict.queued) ...[
            const SizedBox(height: 6),
            Row(children: [
              const Icon(Icons.schedule, size: 15, color: J.warn),
              const SizedBox(width: 5),
              Expanded(
                child: Text(l('sc.provisional'),
                    style: const TextStyle(fontSize: 13, color: J.warn, height: 1.3)),
              ),
            ]),
          ],
        ],
      ),
    );
  }
}

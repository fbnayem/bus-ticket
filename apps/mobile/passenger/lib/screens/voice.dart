import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';
import '../voice_flow.dart';
import 'passengers.dart';
import 'pay.dart';
import 'ticket.dart';

/// The voice sheet.
///
/// Everything the app hears and everything it says is on this screen as text.
/// That is not decoration: a passenger has to be able to see that they were
/// misheard, and a purely spoken interface leaves somebody arguing with a
/// machine that has already moved on. It is also what makes the whole flow
/// testable and demonstrable on a device with no usable microphone — the
/// "type instead" box feeds the same parser the microphone feeds.
/// [intoTab] hands back the navigator of the tab currently on screen.
///
/// The sheet opens on the ROOT navigator, so that it covers the bottom bar the
/// way a modal should. That makes `Navigator.of` inside it the root one too —
/// and a screen pushed there sits ABOVE the shell, losing the bottom bar for
/// the rest of the journey. Which is the exact bug this release set out to fix,
/// reintroduced by the feature that was meant to sit on top of it.
Future<void> showVoiceSheet(BuildContext context, {NavigatorState? Function()? intoTab}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    useRootNavigator: true,
    backgroundColor: J.plate,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _VoiceSheet(intoTab: intoTab),
  );
}

class _VoiceSheet extends StatefulWidget {
  const _VoiceSheet({this.intoTab});
  final NavigatorState? Function()? intoTab;

  @override
  State<_VoiceSheet> createState() => _VoiceSheetState();
}

class _VoiceSheetState extends State<_VoiceSheet> {
  VoiceFlow? _flow;
  final _typed = TextEditingController();
  final _scroll = ScrollController();
  bool _showType = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final flow = VoiceFlow(app: AppScope.read(context), l: L.of(context));
      flow.addListener(_onChange);
      setState(() => _flow = flow);
      final ok = await flow.begin();
      // No microphone is not a dead end. The typed box drives the identical
      // path, which is also how this is verified on an emulator.
      if (!ok && mounted) setState(() => _showType = true);
    });
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  @override
  void dispose() {
    _flow?.removeListener(_onChange);
    _flow?.dispose();
    _typed.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send(String text) async {
    final flow = _flow;
    if (flow == null || text.trim().isEmpty) return;
    _typed.clear();
    final intent = parseVoice(text, now: DateTime.now());
    flow.lines.add(VoiceLine(text, fromUser: true));
    await flow.handle(intent);
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final flow = _flow;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: FractionallySizedBox(
        heightFactor: 0.9,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 8, 4),
              child: Row(
                children: [
                  const Icon(Icons.graphic_eq, color: J.field),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(l('vo.title'),
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  ),
                  IconButton(
                    tooltip: l('vo.type'),
                    icon: Icon(_showType ? Icons.keyboard_hide : Icons.keyboard),
                    onPressed: () => setState(() => _showType = !_showType),
                  ),
                  IconButton(
                    tooltip: l('common.close'),
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),

            Expanded(
              child: flow == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      children: [
                        if (flow.lines.isEmpty) _hint(l),
                        for (final line in flow.lines) _bubble(line),
                        if (flow.partial.isNotEmpty)
                          _bubble(VoiceLine(flow.partial, fromUser: true), faded: true),
                        if (flow.stage == VoiceStage.needsDetails) _finishByTapping(l, flow),
                        if (flow.stage == VoiceStage.done) _openTicket(l, flow),
                      ],
                    ),
            ),

            if (_showType)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  controller: _typed,
                  textInputAction: TextInputAction.send,
                  onSubmitted: _send,
                  decoration: InputDecoration(
                    hintText: l('vo.example'),
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.send, size: 20),
                      onPressed: () => _send(_typed.text),
                    ),
                  ),
                ),
              ),

            if (flow != null) _controls(l, flow),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }

  Widget _hint(L l) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Column(
          children: [
            Text(l('vo.tap'),
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Text(l('vo.example'),
                textAlign: TextAlign.center,
                style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.4)),
          ],
        ),
      );

  Widget _bubble(VoiceLine line, {bool faded = false}) => Align(
        alignment: line.fromUser ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          constraints: const BoxConstraints(maxWidth: 300),
          decoration: BoxDecoration(
            color: line.fromUser ? J.fieldTint : J.plate2,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            line.text,
            style: TextStyle(
              fontSize: 14.5,
              height: 1.4,
              color: faded ? J.muted : (line.fromUser ? J.field : J.ink),
              fontStyle: faded ? FontStyle.italic : FontStyle.normal,
            ),
          ),
        ),
      );

  /// Voice has gone as far as it may. The rest is a tap, and the sheet says so
  /// rather than leaving somebody talking to a screen that has stopped acting.
  Widget _finishByTapping(L l, VoiceFlow flow) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: FilledButton(
          onPressed: () {
            final b = flow.booking;
            final h = flow.hold;
            final t = flow.trip;
            // Into the tab, never the root — see showVoiceSheet. Resolved
            // before the pop, because the sheet's own context dies with it.
            final into = widget.intoTab?.call() ?? Navigator.of(context);
            Navigator.of(context).pop();
            if (b != null && t != null) {
              // Booked but not paid — the payment screen takes it from here.
              into.push(MaterialPageRoute(builder: (_) => PayScreen(booking: b, trip: t)));
            } else if (h != null && t != null) {
              // Held but not booked, because voice must not collect a phone
              // number. The form asks for it once.
              into.push(MaterialPageRoute(
                  builder: (_) => PassengersScreen(trip: t, hold: h)));
            }
          },
          child: Text(l('common.next')),
        ),
      );

  Widget _openTicket(L l, VoiceFlow flow) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: FilledButton(
          onPressed: () {
            final pnr = flow.booking?.pnr;
            final into = widget.intoTab?.call() ?? Navigator.of(context);
            Navigator.of(context).pop();
            if (pnr != null) {
              into.push(MaterialPageRoute(builder: (_) => TicketScreen(pnr: pnr)));
            }
          },
          child: Text(l('tk.title')),
        ),
      );

  Widget _controls(L l, VoiceFlow flow) {
    final confirming =
        flow.stage == VoiceStage.confirmHold || flow.stage == VoiceStage.confirmPay;

    // Every spoken answer has a tappable twin. Voice is an addition to this
    // app, never a requirement of it, and a noisy bus stand is exactly where
    // somebody needs the button.
    if (confirming) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Column(
          children: [
            Text(l('vo.say'),
                style: const TextStyle(color: J.muted, fontSize: 12.5)),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => flow.handle(
                        const VoiceIntent(action: VoiceAction.reject, transcript: 'no')),
                    child: Text(l('vo.no')),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: () => flow.handle(
                        const VoiceIntent(action: VoiceAction.confirm, transcript: 'yes'),
                        expecting: flow.stage),
                    child: Text(l('vo.yes')),
                  ),
                ),
              ],
            ),
          ],
        ),
      );
    }

    return Column(
      children: [
        Text(
          flow.stage == VoiceStage.listening
              ? l('vo.listening')
              : flow.stage == VoiceStage.working
                  ? l('vo.working')
                  : '',
          style: const TextStyle(color: J.muted, fontSize: 12.5),
        ),
        const SizedBox(height: 6),
        GestureDetector(
          onTap: flow.busy ? null : flow.listen,
          child: Container(
            width: 68,
            height: 68,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: flow.stage == VoiceStage.listening ? J.danger : J.field,
              boxShadow: [
                BoxShadow(
                  color: (flow.stage == VoiceStage.listening ? J.danger : J.field)
                      .withValues(alpha: .25),
                  blurRadius: flow.stage == VoiceStage.listening ? 18 : 8,
                  spreadRadius: flow.stage == VoiceStage.listening ? 4 : 0,
                ),
              ],
            ),
            child: Icon(
              flow.stage == VoiceStage.listening ? Icons.stop : Icons.mic,
              color: Colors.white,
              size: 30,
            ),
          ),
        ),
      ],
    );
  }
}

import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

/// Shared plumbing for the three report screens: a date window, and the tiny
/// pair of pickers that set it. Every report reads the same window and defaults
/// to the last 30 days, so an owner opening any of them sees the same period.

String _iso(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// The default window: 30 days back to today.
(String from, String to) defaultWindow() {
  final now = DateTime.now();
  return (_iso(now.subtract(const Duration(days: 29))), _iso(now));
}

/// Two compact date buttons for a report's app bar. Tapping one opens the
/// platform date picker; picking a date calls [onChanged] with the new window.
class WindowPicker extends StatelessWidget {
  const WindowPicker({
    super.key,
    required this.from,
    required this.to,
    required this.onChanged,
  });

  final String from, to;
  final void Function(String from, String to) onChanged;

  DateTime _parse(String s) => DateTime.tryParse(s) ?? DateTime.now();

  Future<void> _pick(BuildContext context, bool isFrom) async {
    final initial = _parse(isFrom ? from : to);
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked == null) return;
    final v = _iso(picked);
    onChanged(isFrom ? v : from, isFrom ? to : v);
  }

  @override
  Widget build(BuildContext context) {
    Widget btn(String label, bool isFrom) => TextButton(
          onPressed: () => _pick(context, isFrom),
          style: TextButton.styleFrom(
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(horizontal: 8),
          ),
          child: Text(label, style: const TextStyle(fontSize: 13)),
        );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        btn(from.substring(5), true), // MM-DD, the year is rarely in question
        const Text('–', style: TextStyle(color: Colors.white70)),
        btn(to.substring(5), false),
        const SizedBox(width: 4),
      ],
    );
  }
}

/// A summary tile: a label over a value, used in the row of figures at the top
/// of each report.
class Stat extends StatelessWidget {
  const Stat({super.key, required this.label, required this.value, this.tone});
  final String label;
  final String value;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: J.plate,
        borderRadius: BorderRadius.circular(J.radius),
        border: Border.all(color: J.rule),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: const TextStyle(color: J.muted, fontSize: 12)),
          const SizedBox(height: 4),
          Text(value,
              style: TextStyle(
                  fontSize: 20, fontWeight: FontWeight.w700, color: tone ?? J.ink)),
        ],
      ),
    );
  }
}

/// A profit or loss, coloured and signed so a minus is never the only cue.
class ProfitText extends StatelessWidget {
  const ProfitText({super.key, required this.poisha, this.size = 20});
  final int poisha;
  final double size;

  @override
  Widget build(BuildContext context) {
    final loss = poisha < 0;
    return Text(
      '${loss ? '−' : ''}${taka(poisha.abs())}',
      style: TextStyle(
        fontSize: size,
        fontWeight: FontWeight.w700,
        color: loss ? J.danger : J.ok,
      ),
    );
  }
}

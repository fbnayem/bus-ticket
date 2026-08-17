import 'package:flutter/material.dart';

import 'i18n.dart';
import 'theme.dart';

/// Small shared pieces. Nothing here decides what anybody may do; it is all
/// presentation, and the server checks every permission again regardless.

/// A short state word. Four tones, each meaning exactly one thing — landed,
/// waiting on something outside us, a person is needed soon, and irreversible.
class Pill extends StatelessWidget {
  const Pill(this.label, {super.key, this.tone = PillTone.neutral});

  final String label;
  final PillTone tone;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      PillTone.ok => (J.okTint, J.ok),
      PillTone.inflight => (J.inflightTint, J.inflight),
      PillTone.warn => (J.warnTint, J.warn),
      PillTone.danger => (J.dangerTint, J.danger),
      PillTone.neutral => (J.plate2, J.ink2),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(J.radiusSm),
        border: Border.all(color: fg.withValues(alpha: .25)),
      ),
      child: Text(label,
          style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w600)),
    );
  }
}

enum PillTone { neutral, ok, inflight, warn, danger }

PillTone toneOf(String status) => switch (status) {
      'TICKETED' || 'CONFIRMED' || 'COMPLETED' || 'BOARDED' || 'VALID' || 'SUCCESS' => PillTone.ok,
      'PAYMENT_PENDING' || 'REQUESTED' || 'PROCESSING' || 'APPROVED' => PillTone.inflight,
      'EXPIRED' || 'REFUND_PENDING' => PillTone.warn,
      'CANCELLED' || 'FAILED' || 'REJECTED' => PillTone.danger,
      _ => PillTone.neutral,
    };

/// The one figure a screen exists to deliver, at the size it deserves, with its
/// own arithmetic written underneath rather than set as homework.
class MoneyLine extends StatelessWidget {
  const MoneyLine({super.key, required this.what, required this.amount, this.how, this.size = 34});

  final String what, amount;
  final String? how;
  final double size;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(what, style: const TextStyle(color: J.muted, fontSize: 14)),
          const SizedBox(height: 2),
          Text(amount,
              style: TextStyle(
                  fontSize: size, fontWeight: FontWeight.w700, height: 1.1, color: J.ink)),
          if (how != null) ...[
            const SizedBox(height: 4),
            Text(how!, style: const TextStyle(color: J.muted, fontSize: 13)),
          ],
        ],
      );
}

/// A refusal, in the platform's own words. We surface the server's sentence
/// rather than inventing our own, so the wording has one home.
class ErrorNotice extends StatelessWidget {
  const ErrorNotice(this.message, {super.key, this.onRetry, this.retryLabel});

  final String message;
  final VoidCallback? onRetry;
  final String? retryLabel;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: J.dangerTint,
          borderRadius: BorderRadius.circular(J.radius),
          border: Border.all(color: J.danger.withValues(alpha: .35)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(message, style: const TextStyle(color: J.danger, fontSize: 15, height: 1.4)),
            if (onRetry != null) ...[
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: onRetry,
                child: Text(retryLabel ?? L.of(context)('common.retry')),
              ),
            ],
          ],
        ),
      );
}

/// Something to say rather than a spinner over nothing.
class Waiting extends StatelessWidget {
  const Waiting({super.key, this.note});
  final String? note;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 48),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(
                width: 26, height: 26,
                child: CircularProgressIndicator(strokeWidth: 2.5, color: J.field),
              ),
              const SizedBox(height: 14),
              Text(note ?? L.of(context)('common.loading'),
                  style: const TextStyle(color: J.muted, fontSize: 15)),
            ],
          ),
        ),
      );
}

/// An empty state that says what to do next, not merely that there is nothing.
class Nothing extends StatelessWidget {
  const Nothing({super.key, required this.title, this.hint, this.action});

  final String title;
  final String? hint;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 48),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(title,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: J.ink)),
              if (hint != null) ...[
                const SizedBox(height: 8),
                Text(hint!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: J.muted, fontSize: 15, height: 1.45)),
              ],
              if (action != null) ...[const SizedBox(height: 20), action!],
            ],
          ),
        ),
      );
}

/// Both languages, both always visible.
///
/// A dropdown would hide Bangla behind a tap and imply English is the product's
/// resting state. A visible pair says neither is a fallback for the other.
class LanguageToggle extends StatelessWidget {
  const LanguageToggle({super.key, this.onLight = false});

  /// True when it sits on the dark field green, where the unselected option
  /// needs to be light rather than dark to stay legible.
  final bool onLight;

  @override
  Widget build(BuildContext context) {
    final scope = LangScope.of(context);
    final border = onLight ? Colors.white54 : J.rule;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(J.radiusSm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: Lang.values.map((l) {
          final on = scope.lang == l;
          return InkWell(
            onTap: () => scope.setLang(l),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              color: on ? (onLight ? Colors.white : J.field) : Colors.transparent,
              child: Text(
                l == Lang.bn ? 'বাং' : 'EN',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: on
                      ? (onLight ? J.field : Colors.white)
                      : (onLight ? Colors.white : J.ink2),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

/// A bar that only appears when there is something waiting to be sent.
class QueueBar extends StatelessWidget {
  const QueueBar({super.key, required this.label, required this.action, required this.onAction});

  final String label, action;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
        color: J.warnTint,
        child: Row(
          children: [
            Expanded(
              child: Text(label, style: const TextStyle(color: J.warn, fontSize: 14, height: 1.35)),
            ),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: onAction,
              style: FilledButton.styleFrom(
                backgroundColor: J.warn,
                minimumSize: const Size(0, 38),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              ),
              child: Text(action),
            ),
          ],
        ),
      );
}

/// A row of the form "label ......... value", which is most of what a receipt
/// is, and reads far better than two columns that drift apart.
class KeyValue extends StatelessWidget {
  const KeyValue(this.k, this.v, {super.key, this.strong = false, this.tone});

  final String k, v;
  final bool strong;
  final Color? tone;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(k,
                  style: TextStyle(
                      color: strong ? J.ink : J.muted,
                      fontSize: strong ? 16 : 14.5,
                      fontWeight: strong ? FontWeight.w600 : FontWeight.w400)),
            ),
            const SizedBox(width: 12),
            Text(v,
                style: TextStyle(
                    color: tone ?? J.ink,
                    fontSize: strong ? 18 : 15,
                    fontWeight: strong ? FontWeight.w700 : FontWeight.w600,
                    fontFeatures: const [FontFeature.tabularFigures()])),
          ],
        ),
      );
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:jatra_core/jatra_core.dart';

import '../app_state.dart';

/// Offers, drawn as coupons.
///
/// The saving decides whether the card is read at all, so it is the largest
/// thing on it; the code is what somebody came for, so it sits on a tear-off
/// they can copy with one tap. Uniform cards with the discount as a small pill
/// gave a 20% saving and a terms line the same weight, which is not how anyone
/// reads an offer.
class OffersScreen extends StatefulWidget {
  const OffersScreen({super.key});

  @override
  State<OffersScreen> createState() => _OffersScreenState();
}

class _OffersScreenState extends State<OffersScreen> {
  List<Offer>? _offers;
  String _error = '';
  String _copied = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final o = await AppScope.read(context).api.offers();
      if (mounted) setState(() => _offers = o);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = L.of(context).error(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l('of.title'))),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _error.isNotEmpty && _offers == null
            ? ListView(children: [
                Padding(padding: const EdgeInsets.all(16), child: ErrorNotice(_error, onRetry: _load)),
              ])
            : _offers == null
                ? const Waiting()
                : _offers!.isEmpty
                    ? ListView(children: [const SizedBox(height: 60), Nothing(title: l('of.none'))])
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
                        children: [
                          Text(l('of.lead'),
                              style: const TextStyle(color: J.muted, fontSize: 14, height: 1.4)),
                          const SizedBox(height: 14),
                          for (final o in _offers!)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _Coupon(
                                offer: o,
                                copied: _copied == o.code,
                                onCopy: () async {
                                  await Clipboard.setData(ClipboardData(text: o.code));
                                  if (!mounted) return;
                                  setState(() => _copied = o.code);
                                },
                              ),
                            ),
                        ],
                      ),
      ),
    );
  }
}

class _Coupon extends StatelessWidget {
  const _Coupon({required this.offer, required this.copied, required this.onCopy});

  final Offer offer;
  final bool copied;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    // Campaign copy is content, not interface, so it lives beside the campaign
    // rather than in the string catalogue. Falling back to the one language a
    // campaign was written in beats showing a Bangla reader an empty card.
    final title = (l.isBn && offer.titleBn.isNotEmpty) ? offer.titleBn : offer.title;

    return Container(
      decoration: BoxDecoration(
        color: J.plate,
        borderRadius: BorderRadius.circular(J.radius),
        border: Border.all(color: J.ruleStrong),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            decoration: const BoxDecoration(
              color: J.markTint,
              borderRadius: BorderRadius.vertical(top: Radius.circular(J.radius)),
            ),
            child: Text(
              offer.discountPct > 0
                  ? l('of.pctOff', {'pct': offer.discountPct})
                  : l('of.amountOff', {'amount': taka(offer.discountPoisha)}),
              style: const TextStyle(
                  fontSize: 26, fontWeight: FontWeight.w700, color: J.markInk, height: 1.1),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                if (offer.minAmountPoisha > 0) ...[
                  const SizedBox(height: 6),
                  Text(l('of.minSpend', {'amount': taka(offer.minAmountPoisha)}),
                      style: const TextStyle(color: J.muted, fontSize: 13.5)),
                ],
              ],
            ),
          ),
          const Divider(height: 18),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 10, 12),
            child: Row(
              children: [
                Expanded(
                  child: Text(offer.code,
                      style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.6,
                          fontFeatures: [FontFeature.tabularFigures()])),
                ),
                TextButton.icon(
                  onPressed: onCopy,
                  icon: Icon(copied ? Icons.check : Icons.copy, size: 17),
                  label: Text(copied ? l('of.copied') : l('of.copy')),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

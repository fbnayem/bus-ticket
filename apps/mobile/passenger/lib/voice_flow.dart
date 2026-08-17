import 'package:flutter/foundation.dart';
import 'package:jatra_core/jatra_core.dart';

import 'app_state.dart';

/// Booking a bus by talking.
///
/// Two rules shape this file, and both are here because the next step on this
/// screen spends somebody's money.
///
///  1. **Nothing is held or paid without a read-back and an explicit yes.**
///     Not "no objection", not silence, not an unclear noise — an actual
///     confirmation. Anything else stops.
///  2. **Voice drives the same code every tap drives.** There is no shortcut
///     API, no hidden endpoint, no local seat logic. It calls `createHold`,
///     `createBooking` and `paymentIntent` exactly as the tapped screens do, so
///     the platform's rules apply identically whether a passenger spoke or
///     tapped. In particular the inventory service remains the only thing that
///     decides whether a seat is free.
///
/// Place names are NOT resolved here. The gazetteer's suggest endpoint already
/// does that, typo-tolerantly, in both languages, and it is the same resolver
/// the typed field uses — so what was heard is handed to it rather than being
/// guessed at twice in two different ways.

/// What voice may approve without a human tapping. Above this it hands over.
///
/// A ceiling exists because a misheard "yes" costs real money, and because the
/// difference between one ticket and a whole family's is the difference between
/// an annoyance and a serious loss.
const int kVoicePayCeilingPoisha = 500000; // ৳5,000

enum VoiceStage {
  idle,
  listening,
  working,
  /// A read-back is on screen and a spoken yes or no is expected. Nothing has
  /// been committed at this point.
  confirmHold,
  confirmPay,
  /// The flow needs something voice must not collect — a name and a phone
  /// number — and hands back to the form.
  needsDetails,
  done,
  failed,
}

/// One line of the conversation, kept so the whole exchange is visible.
///
/// A passenger has to be able to SEE that they were misheard. A voice
/// interface that only speaks leaves somebody arguing with a machine that has
/// already moved on.
class VoiceLine {
  const VoiceLine(this.text, {this.fromUser = false});
  final String text;
  final bool fromUser;
}

class VoiceFlow extends ChangeNotifier {
  VoiceFlow({required this.app, required this.l, VoiceSession? session})
      : _voice = session ?? VoiceSession();

  final AppState app;
  final L l;
  final VoiceSession _voice;

  VoiceSession get session => _voice;

  VoiceStage stage = VoiceStage.idle;
  final List<VoiceLine> lines = [];
  String partial = '';
  String error = '';

  // What has been gathered so far.
  String? _from, _to;
  DateTime? _date;
  int _seats = 1;
  int? _hour;

  List<TripSummary> _results = const [];
  TripSummary? _trip;
  List<String> _picked = const [];
  Hold? _hold;
  Booking? _booking;
  String _provider = 'BKASH';
  String _paymentRef = '';
  int _amountPoisha = 0;

  List<TripSummary> get results => _results;
  TripSummary? get trip => _trip;
  Booking? get booking => _booking;
  Hold? get hold => _hold;
  bool get busy => stage == VoiceStage.listening || stage == VoiceStage.working;

  void _say(String text, {bool speak = true}) {
    lines.add(VoiceLine(text));
    notifyListeners();
    if (speak) _voice.say(text);
  }

  void _heard(String text) {
    lines.add(VoiceLine(text, fromUser: true));
    notifyListeners();
  }

  void _fail(String message) {
    error = message;
    stage = VoiceStage.failed;
    lines.add(VoiceLine(message));
    notifyListeners();
    _voice.say(message);
  }

  Future<bool> begin() async {
    final ok = await _voice.start();
    if (!ok) {
      _fail(l('vo.noMic'));
      return false;
    }
    if (!_voice.bangla && l.isBn) _say(l('vo.englishOnly'), speak: false);
    return true;
  }

  /// One turn: listen, then act on what was understood.
  Future<void> listen() async {
    if (busy) return;
    stage = VoiceStage.listening;
    partial = '';
    notifyListeners();

    final expecting = _expecting;
    final intent = await _voice.listenOnce(onPartial: (p) {
      partial = p;
      notifyListeners();
    });

    partial = '';
    if (intent.transcript.trim().isNotEmpty) _heard(intent.transcript);
    await handle(intent, expecting: expecting);
  }

  VoiceStage get _expecting => stage;

  /// Acts on an intent.
  ///
  /// Separated from [listen] so the whole flow can be exercised without a
  /// microphone — the sheet's "type instead" box and the widget tests both feed
  /// intents straight in here. That is not a testing back door: it is the same
  /// path, with the audio step removed.
  Future<void> handle(VoiceIntent intent, {VoiceStage? expecting}) async {
    final at = expecting ?? stage;

    // A read-back is on screen. Only yes moves; everything else stops. This
    // ordering is the whole safety property of the feature.
    if (at == VoiceStage.confirmHold || at == VoiceStage.confirmPay) {
      if (intent.action == VoiceAction.confirm) {
        stage = VoiceStage.working;
        notifyListeners();
        if (at == VoiceStage.confirmHold) {
          await _commitBooking();
        } else {
          await _approvePayment();
        }
        return;
      }
      // Anything that is not clearly yes — including silence and noise — is a
      // no. Erring the other way holds seats against somebody who refused.
      _say(l('vo.stopped'));
      stage = VoiceStage.idle;
      notifyListeners();
      return;
    }

    switch (intent.action) {
      case VoiceAction.cancel:
      case VoiceAction.reject:
        _say(l('vo.stopped'));
        stage = VoiceStage.idle;
        notifyListeners();
        return;

      case VoiceAction.repeat:
        if (lines.isNotEmpty) _voice.say(lines.lastWhere((x) => !x.fromUser).text);
        return;

      case VoiceAction.pay:
        if (intent.provider != null) _provider = intent.provider!;
        await _startPayment();
        return;

      case VoiceAction.choose:
        await _choose(intent);
        return;

      case VoiceAction.search:
        _from = intent.from ?? _from;
        _to = intent.to ?? _to;
        _date = intent.date ?? _date;
        _hour = intent.hour ?? _hour;
        if (intent.seats != null) _seats = intent.seats!;
        await _search();
        return;

      case VoiceAction.confirm:
        // A yes with nothing pending. Harmless, and saying so is better than
        // silently doing the last thing again.
        _say(l('vo.tap'), speak: false);
        return;

      case VoiceAction.none:
        _say(l('vo.notUnderstood'));
        return;
    }
  }

  /* ------------------------------------------------------------- searching */

  Future<void> _search() async {
    if (_from == null) {
      _say(l('vo.whereFrom'));
      return;
    }
    if (_to == null) {
      _say(l('vo.whereTo'));
      return;
    }
    stage = VoiceStage.working;
    _say(l('vo.searching'), speak: false);

    final from = await _resolve(_from!);
    if (from == null) return;
    final to = await _resolve(_to!);
    if (to == null) return;
    _from = from;
    _to = to;

    final when = _date ?? DateTime.now();
    try {
      final r = await app.api.search(from, to, isoDate(when));
      _results = r;
      if (r.isEmpty) {
        _fail(l('find.none'));
        return;
      }
      // If a time of day was mentioned, put the closest departure first so
      // "the morning one" needs no second turn.
      if (_hour != null) {
        final sorted = [..._results]..sort((a, b) =>
            (_hourOf(a) - _hour!).abs().compareTo((_hourOf(b) - _hour!).abs()));
        _results = sorted;
      }
      final first = _results.first;
      _say(l('vo.found', {
        'n': '${_results.length}',
        'brand': first.brand,
        'time': timeOf(first.departAt, l.lang),
        'fare': taka(first.farePoisha),
      }));
      // A time of day was given, so treat the closest departure as chosen and
      // go straight to the read-back rather than asking again.
      if (_hour != null) {
        await _pick(first);
      } else {
        _say(l('vo.pickOne'), speak: false);
        stage = VoiceStage.idle;
      }
      notifyListeners();
    } on ApiError catch (e) {
      _fail(l.error(e));
    }
  }

  int _hourOf(TripSummary t) => DateTime.tryParse(t.departAt)?.toLocal().hour ?? 0;

  /// Hands what was heard to the platform's own place resolver — the same one
  /// the typed field uses, which already knows Bangla names, old spellings and
  /// near-misses.
  Future<String?> _resolve(String spoken) async {
    try {
      final hits = await app.api.places(spoken, 1);
      if (hits.isEmpty) {
        _fail(l('vo.noPlace', {'name': spoken}));
        return null;
      }
      return hits.first.name;
    } on ApiError catch (e) {
      _fail(l.error(e));
      return null;
    }
  }

  Future<void> _choose(VoiceIntent intent) async {
    if (_results.isEmpty) {
      _say(l('vo.notUnderstood'));
      return;
    }
    TripSummary? chosen;
    if (intent.ordinal != null) {
      final i = intent.ordinal! == -1 ? _results.length - 1 : intent.ordinal! - 1;
      if (i >= 0 && i < _results.length) chosen = _results[i];
    } else if (intent.hour != null) {
      chosen = _results.reduce((a, b) =>
          (_hourOf(a) - intent.hour!).abs() <= (_hourOf(b) - intent.hour!).abs() ? a : b);
    }
    if (chosen == null) {
      _say(l('vo.notUnderstood'));
      return;
    }
    await _pick(chosen);
  }

  /* ----------------------------------------------------- seats and read-back */

  Future<void> _pick(TripSummary t) async {
    stage = VoiceStage.working;
    notifyListeners();
    _trip = t;
    try {
      final map = await app.api.seatMap(t.tripId, t.boardSeq, t.dropSeq);
      final free = map.seats.where((s) => s.available).toList(growable: false);
      if (free.length < _seats) {
        _fail(l('find.full'));
        return;
      }
      _picked = free.take(_seats).map((s) => s.seatNo).toList(growable: false);

      // Everything about to be committed, said out loud and shown, before
      // anything is held.
      _say(l('vo.readBack', {
        'brand': t.brand,
        'from': _from ?? '',
        'to': _to ?? '',
        'date': dayOf(t.departAt, l),
        'time': timeOf(t.departAt, l.lang),
        'seats': _picked.join(', '),
        'fare': taka(t.farePoisha * _picked.length),
      }));
      stage = VoiceStage.confirmHold;
      notifyListeners();
    } on ApiError catch (e) {
      _fail(l.error(e));
    }
  }

  /* -------------------------------------------------------------- committing */

  Future<void> _commitBooking() async {
    final t = _trip;
    if (t == null) return;

    _say(l('vo.holding'), speak: false);
    try {
      // The hold comes first, before the details check below, so a passenger
      // who still has to type their number does it with the seats already
      // secured rather than racing somebody else for them.
      _hold = await app.api.createHold(
        tripId: t.tripId,
        seats: _picked,
        boardSeq: t.boardSeq,
        dropSeq: t.dropSeq,
        idempotencyKey: newIdempotencyKey('voice-hold'),
      );

      // A name and a number are needed, and voice must not collect a phone
      // number — an eleven-digit string is exactly what speech recognition is
      // worst at, and a wrong one sends somebody else the ticket. So this is
      // where a passenger the device does not yet know is handed to the form.
      final name = app.displayName;
      final phone = app.phone;
      if (name == null || name.isEmpty || phone == null || phone.length < 11) {
        _say(l('vo.needDetails'));
        stage = VoiceStage.needsDetails;
        notifyListeners();
        return;
      }

      _booking = await app.api.createBooking(
        holdId: _hold!.holdId,
        passengers: [
          for (final s in _picked) PassengerDetail(seatNo: s, fullName: name),
        ],
        phone: phone,
        idempotencyKey: newIdempotencyKey('voice-book'),
      );
      await app.keep(_booking!);
      await _startPayment();
    } on ApiError catch (e) {
      _fail(l.error(e));
    }
  }

  /* ----------------------------------------------------------------- paying */

  Future<void> _startPayment() async {
    final b = _booking;
    if (b == null) {
      _say(l('vo.notUnderstood'));
      return;
    }
    stage = VoiceStage.working;
    notifyListeners();
    try {
      final intent = await app.api.paymentIntent(b.bookingId, _provider);
      _paymentRef = '${intent['payment_ref']}';
      _amountPoisha = (intent['amount_poisha'] as num?)?.toInt() ?? b.totalPoisha;

      // The provider's own app takes the PIN, and no MFS lets that be
      // delegated. Only the sandbox can be completed from here, and the
      // difference is visible in the intent the platform just handed back.
      final redirect = '${intent['redirect_url'] ?? ''}';
      if (!redirect.startsWith('/payment/sandbox')) {
        _say(l('vo.notSandbox'));
        stage = VoiceStage.needsDetails;
        notifyListeners();
        return;
      }

      if (_amountPoisha > kVoicePayCeilingPoisha) {
        _say(l('vo.payCeiling'));
        stage = VoiceStage.needsDetails;
        notifyListeners();
        return;
      }

      _say(l('vo.payReadBack', {
        'fare': taka(_amountPoisha),
        'provider': _provider == 'NAGAD' ? l('pay.nagad') : l('pay.bkash'),
      }));
      stage = VoiceStage.confirmPay;
      notifyListeners();
    } on ApiError catch (e) {
      _fail(l.error(e));
    }
  }

  Future<void> _approvePayment() async {
    _say(l('vo.paying'), speak: false);
    try {
      // Exactly what the tapped screen does, and it does NOT confirm anything:
      // it tells the sandbox the customer finished. The platform's own verified
      // webhook chain is what issues a ticket, and the booking is read back
      // from the platform to find out what actually happened.
      await app.api.completeSandboxPayment(_paymentRef);
      final fresh = await app.api.booking(_booking!.pnr);
      _booking = fresh;
      await app.keep(fresh);
      if (fresh.confirmed) {
        _say(l('vo.done'));
        stage = VoiceStage.done;
      } else {
        // Not confirmed is not the same as failed, but from here it is the
        // same instruction: stop talking and look at the payment screen.
        _fail(l('pay.failed'));
      }
      notifyListeners();
    } on ApiError catch (e) {
      _fail(l.error(e));
    }
  }

  @override
  void dispose() {
    _voice.dispose();
    super.dispose();
  }
}

/// Turning what somebody said into something the app can do.
///
/// This file is deliberately pure Dart: no plugins, no network, no model. That
/// is not a limitation, it is the point.
///
///   - It runs in a unit test with no device and no microphone, so the grammar
///     can be pinned by a table of real phrases rather than by hand-waving.
///   - It costs nothing and takes no time, which matters on the phones this
///     market actually carries.
///   - It is inspectable. When a passenger says something and the wrong thing
///     happens, the reason is a line in here rather than a probability.
///
/// What it does NOT do is resolve place names. "chittagong", "চট্টগ্রাম" and
/// "chatt" all have to become one location id, and the platform already does
/// that properly — the gazetteer's suggest endpoint is typo-tolerant, knows
/// every Bangla name and every pre-2018 spelling, and is the same resolver the
/// typed search field uses. So this extracts the WORDS someone said for the
/// origin and destination and hands them on. One resolver, not two.
library;

/// What the passenger appears to want.
enum VoiceAction {
  /// Nothing recognisable. Never guessed at — a wrong guess on this screen
  /// spends money.
  none,

  /// A journey: some combination of from, to, date, seats and time of day.
  search,

  /// Pick something out of a list — "the first one", "the six o'clock one".
  choose,

  /// Yes. Required before anything is held and before anything is paid.
  confirm,

  /// No, or anything that is not clearly yes.
  reject,

  /// Take payment.
  pay,

  /// Go back / start again.
  cancel,

  /// Read the current screen out.
  repeat,
}

/// A parsed utterance. Every field is optional because people speak in
/// fragments — "kal" on its own is a perfectly good answer to "which day?".
class VoiceIntent {
  const VoiceIntent({
    required this.action,
    required this.transcript,
    this.from,
    this.to,
    this.date,
    this.seats,
    this.hour,
    this.ordinal,
    this.provider,
  });

  const VoiceIntent.none(this.transcript)
      : action = VoiceAction.none,
        from = null,
        to = null,
        date = null,
        seats = null,
        hour = null,
        ordinal = null,
        provider = null;

  final VoiceAction action;

  /// Exactly what was heard. Kept so the screen can show it — a passenger has
  /// to be able to see that they were misheard, rather than watch the app do
  /// something inexplicable.
  final String transcript;

  /// The words spoken for each end of the journey, NOT resolved locations.
  final String? from, to;

  final DateTime? date;

  /// How many seats. Never defaulted to a number greater than one.
  final int? seats;

  /// A departure hour in 24h, from "the six o'clock one" or "সকাল".
  final int? hour;

  /// 1-based position in whatever list is on screen.
  final int? ordinal;

  /// 'BKASH' or 'NAGAD' when named.
  final String? provider;

  bool get hasJourney => from != null || to != null || date != null;

  @override
  String toString() => 'VoiceIntent($action, from=$from, to=$to, date=$date, '
      'seats=$seats, hour=$hour, ordinal=$ordinal, provider=$provider)';
}

/// Parses one utterance.
///
/// [now] is injected rather than read from the clock so "কাল" is testable and
/// so the whole grammar stays a pure function.
VoiceIntent parseVoice(String raw, {required DateTime now}) {
  final t = _normalise(raw);
  if (t.isEmpty) return VoiceIntent.none(raw);

  // Order matters. Confirmation is checked first and on the WHOLE utterance,
  // because "হ্যাঁ" said in answer to "shall I hold these seats?" must never be
  // re-read as the start of a new search just because it also contains a word
  // that looks like a place.
  if (_any(t, _yes)) return VoiceIntent(action: VoiceAction.confirm, transcript: raw);
  if (_any(t, _no)) return VoiceIntent(action: VoiceAction.reject, transcript: raw);
  if (_any(t, _cancel)) return VoiceIntent(action: VoiceAction.cancel, transcript: raw);
  if (_any(t, _repeat)) return VoiceIntent(action: VoiceAction.repeat, transcript: raw);

  if (_any(t, _pay)) {
    return VoiceIntent(
      action: VoiceAction.pay,
      transcript: raw,
      provider: _provider(t),
    );
  }

  final route = _route(t);
  final date = _date(t, now);
  final seats = _seats(t);
  final hour = _hour(t);
  final ordinal = _ordinal(t);

  // A choice is only a choice when nothing about a journey was said. "the
  // first one" is a choice; "kal dhaka theke chittagong" is a search even
  // though it contains a word for a number.
  if (route == null && date == null && (ordinal != null || hour != null) && seats == null) {
    return VoiceIntent(
      action: VoiceAction.choose,
      transcript: raw,
      ordinal: ordinal,
      hour: hour,
    );
  }

  if (route != null || date != null || seats != null) {
    return VoiceIntent(
      action: VoiceAction.search,
      transcript: raw,
      from: route?.$1,
      to: route?.$2,
      date: date,
      seats: seats,
      hour: hour,
    );
  }

  return VoiceIntent.none(raw);
}

/* -------------------------------------------------------------- normalising */

/// Lower-cases, collapses whitespace, strips the punctuation a speech engine
/// sprinkles in, and turns Bangla digits into Latin ones.
///
/// The digits matter: a Bangla recogniser returns ৮, the product writes figures
/// in Latin, and "রাত ৮টা" has to mean the same as "night 8 ta". Converting
/// here means every rule below only ever sees one kind of digit.
String _normalise(String s) {
  var t = s
      .toLowerCase()
      .replaceAll(RegExp(r'[.,!?;:"()।]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  for (var d = 0; d < 10; d++) {
    t = t.replaceAll(String.fromCharCode(0x09E6 + d), '$d');
  }
  return t;
}

/// Does the utterance contain any of these words?
///
/// Matching is on WORD BOUNDARIES, in both scripts. Plain containment was the
/// first attempt and it was badly wrong: `না` ("no") is the last two characters
/// of `খুলনা`, so "পরশু ঢাকা থেকে খুলনা" — a passenger asking for a bus to
/// Khulna — parsed as a refusal. On this screen a refusal releases held seats.
/// The same flaw made `সকাল` ("morning") contain `কাল` ("tomorrow"), quietly
/// moving somebody's travel date by a day.
///
/// [prefix] relaxes only the END of the match, for Bangla's inflections:
/// `রাত` should find `রাতে` and `রাতের`, and `সকাল` should find `সকালে`. It is
/// used for time and date words and never for yes/no — `না` as a prefix would
/// match `নাটোর`, and `na` would match `nagad`.
bool _any(String t, List<String> words, {bool prefix = false}) {
  for (final w in words) {
    final tail = prefix ? '' : r'(?=$|\s)';
    if (RegExp('(?:^|\\s)${RegExp.escape(w)}$tail').hasMatch(t)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ vocabulary */

// Kept small and literal on purpose. Every entry is something a person in this
// market actually says, in Bangla, in English, or in the Latin-typed Bangla
// that half the country writes.

// Whole-word matched, every one of them. Bare 'হা' is deliberately absent:
// it is a real colloquial yes, but as a word it collides with too much, and
// 'হ্যা' covers the same speaker.
const _yes = [
  'হ্যাঁ', 'হ্যা', 'জি', 'জ্বি', 'ঠিক আছে', 'ঠিক', 'অবশ্যই', 'করুন', 'করো',
  'yes', 'yeah', 'yep', 'ok', 'okay', 'correct', 'right', 'confirm', 'sure',
  'hae', 'jee', 'thik ache', 'thik ase', 'accha',
];

const _no = [
  'না', 'নাহ', 'নয়', 'বাদ দিন', 'বাদ',
  'no', 'nope', 'wrong', 'not', 'dont', 'do not',
  'na', 'nah',
];

const _cancel = [
  'বাতিল', 'পিছনে', 'ফিরে', 'আবার শুরু',
  'cancel', 'back', 'go back', 'start over', 'start again',
  'batil', 'pichone',
];

const _repeat = [
  'আবার বলুন', 'আবার বল', 'কী বললেন', 'পড়ুন',
  'repeat', 'say again', 'read it', 'what did you say',
];

const _pay = [
  'টাকা দাও', 'টাকা দিন', 'পেমেন্ট', 'পে করুন', 'পে করো', 'পরিশোধ',
  'pay', 'payment', 'checkout', 'approve', 'taka dao', 'taka din',
];

const _bkash = ['বিকাশ', 'bkash', 'bikash'];
const _nagad = ['নগদ', 'nagad', 'nogod'];

String? _provider(String t) {
  // prefix, because Bangla inflects the provider too: বিকাশ becomes বিকাশে
  // ("with bKash") in the sentence people actually say.
  if (_any(t, _bkash, prefix: true)) return 'BKASH';
  if (_any(t, _nagad, prefix: true)) return 'NAGAD';
  return null;
}

/* ---------------------------------------------------------------- the route */

// "X theke Y", "X to Y", "X থেকে Y". The separator is what makes this
// tractable — without one, telling a two-word city from two cities is guesswork.
//
// "from X to Y" is tried FIRST and anchored on `from`, because English puts a
// stray "to" in front of the verb: "I want **to** go from Dhaka to Sylhet"
// split on the first `to` gives an origin of "i want", which cleans to nothing.
final _routeSeparators = <RegExp>[
  RegExp(r'\bfrom\s+(.+?)\s+to\s+(.+)'),
  RegExp(r'(.+?)\s*থেকে\s*(.+)'),
  RegExp(r'(.+?)\s+theke\s+(.+)'),
  RegExp(r'(.+?)\s+theka\s+(.+)'),
  RegExp(r'(.+?)\s+to\s+(.+)'),
];

/// Words that are never part of a place name, stripped from either end so
/// "kal dhaka" yields "dhaka" and "chittagong jabo" yields "chittagong".
const _filler = [
  'আমি', 'আমার', 'যাব', 'যাবো', 'যেতে', 'চাই', 'একটা', 'একটি', 'বাস', 'টিকিট',
  'দাও', 'দিন', 'খুঁজুন', 'খোঁজ', 'দেখাও', 'দেখান', 'আজ', 'আজকে', 'কাল',
  'আগামীকাল', 'পরশু', 'সকাল', 'সকালে', 'দুপুর', 'দুপুরে', 'বিকাল', 'বিকেল',
  'সন্ধ্যা', 'রাত', 'রাতে', 'এর', 'টা', 'জন', 'জনের', 'সিট', 'আসন',
  'i', 'want', 'need', 'go', 'going', 'travel', 'bus', 'ticket', 'find',
  'search', 'show', 'me', 'a', 'an', 'the', 'please', 'for', 'on', 'at',
  'today', 'tomorrow', 'seat', 'seats', 'tickets', 'book', 'jabo', 'jete',
  'chai', 'ekta', 'lagbe', 'dao', 'din', 'kal', 'kalke', 'aj', 'ajke',
  // The rest of "day after tomorrow", and its Bangla equivalent, so the date
  // does not end up glued to the front of the origin.
  'day', 'after', 'porshu', 'পরশু', 'morning', 'night', 'evening', 'afternoon',
  'shokal', 'shokale', 'rat', 'rate', 'dupur', 'bikal',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার', 'রবিবার',
  // How many. "dhaka theke chittagong duita seat" splits on `theke` and leaves
  // "chittagong duita seat" as the destination; stripping `seat` alone is not
  // enough, and "chittagong duita" is not a place.
  'one', 'two', 'three', 'four', 'five', 'six',
  'ek', 'ekta', 'dui', 'duita', 'duto', 'tin', 'tinta', 'char', 'charta',
  'pach', 'pachta', 'choy', 'choyta',
  'এক', 'একটা', 'একটি', 'দুই', 'দুইটা', 'দুটি', 'দুটো', 'তিন', 'তিনটা', 'তিনটি',
  'চার', 'চারটা', 'চারটি', 'পাঁচ', 'পাঁচটা', 'পাঁচটি', 'ছয়', 'ছয়টা', 'ছয়টি',
];

(String, String)? _route(String t) {
  for (final sep in _routeSeparators) {
    // allMatches, not firstMatch: a pattern whose first split leaves an empty
    // side must fall through to the next split rather than give up. "go to
    // dhaka to sylhet" splits twice, and only one of them is the journey.
    for (final m in sep.allMatches(t)) {
      final a = _clean(m.group(1)!);
      final b = _clean(m.group(2)!);
      if (a.isEmpty || b.isEmpty) continue;
      return (a, b);
    }
  }
  return null;
}

String _clean(String s) {
  final words = s.split(' ').where((w) => w.isNotEmpty).toList();
  // Only strip from the ENDS. A filler word in the middle of a place name is
  // vanishingly rare, and stripping there would mangle "Cox's Bazar".
  while (words.isNotEmpty && _filler.contains(words.first)) {
    words.removeAt(0);
  }
  while (words.isNotEmpty && _filler.contains(words.last)) {
    words.removeLast();
  }
  return words.join(' ').trim();
}

/* ----------------------------------------------------------------- the date */

const _todayWords = ['আজ', 'আজকে', 'today', 'aj', 'ajke'];
const _tomorrowWords = ['আগামীকাল', 'কাল', 'কালকে', 'tomorrow', 'kal', 'kalke'];
const _dayAfterWords = ['পরশু', 'day after tomorrow', 'porshu'];

const _weekdays = {
  1: ['সোমবার', 'monday', 'sombar'],
  2: ['মঙ্গলবার', 'tuesday', 'mongolbar'],
  3: ['বুধবার', 'wednesday', 'budhbar'],
  4: ['বৃহস্পতিবার', 'thursday', 'brihospotibar'],
  5: ['শুক্রবার', 'friday', 'shukrobar'],
  6: ['শনিবার', 'saturday', 'shonibar'],
  7: ['রবিবার', 'sunday', 'robibar'],
};

DateTime? _date(String t, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);
  // Day-after is checked before tomorrow: "পরশু" contains no "কাল", but the
  // English phrase "day after tomorrow" does contain "tomorrow".
  //
  // prefix: true throughout, for Bangla's inflections — আজ/আজকে, কাল/কালকে,
  // সোমবার/সোমবারে. Safe here because none of these are the start of a place
  // name in the gazetteer.
  if (_any(t, _dayAfterWords, prefix: true)) return today.add(const Duration(days: 2));
  if (_any(t, _tomorrowWords, prefix: true)) return today.add(const Duration(days: 1));
  if (_any(t, _todayWords, prefix: true)) return today;

  for (final e in _weekdays.entries) {
    if (!_any(t, e.value, prefix: true)) continue;
    // The NEXT such weekday. Saying "Friday" on a Friday means the one coming,
    // not the one you are standing in — nobody books a bus for four hours ago.
    var delta = (e.key - today.weekday) % 7;
    if (delta <= 0) delta += 7;
    return today.add(Duration(days: delta));
  }
  return null;
}

/* ---------------------------------------------------------------- how many */

const _numberWords = {
  1: ['একটা', 'একটি', 'এক', 'one', 'ekta', 'ek'],
  2: ['দুইটা', 'দুটি', 'দুটো', 'দুই', 'two', 'duita', 'duita', 'dui', 'duto'],
  3: ['তিনটা', 'তিনটি', 'তিন', 'three', 'tinta', 'tin'],
  4: ['চারটা', 'চারটি', 'চার', 'four', 'charta', 'char'],
  5: ['পাঁচটা', 'পাঁচটি', 'পাঁচ', 'five', 'pachta', 'pach'],
  6: ['ছয়টা', 'ছয়টি', 'ছয়', 'six', 'choyta', 'choy'],
};

const _seatWords = ['সিট', 'আসন', 'টিকিট', 'seat', 'seats', 'ticket', 'tickets', 'jon', 'জন'];

int? _seats(String t) {
  // A bare number is not a seat count. "two" only means two seats when the
  // word seat, ticket or person is somewhere in the same breath — otherwise
  // "the 6 o'clock one" would silently book six seats.
  if (!_any(t, _seatWords, prefix: true)) return null;
  // No trailing space required: Bangla writes the counter straight onto the
  // digit — "৩টি সিট" normalises to "3টি সিট". The negative lookahead keeps an
  // 11-digit phone number from being read as a seat count.
  final digit = RegExp(r'(?:^|\s)(\d{1,2})(?!\d)').firstMatch(t);
  if (digit != null) {
    final n = int.tryParse(digit.group(1)!);
    if (n != null && n >= 1 && n <= 6) return n;
  }
  for (final e in _numberWords.entries) {
    if (_any(t, e.value, prefix: true)) return e.key;
  }
  return null;
}

/* ------------------------------------------------------- which one of those */

const _ordinalWords = {
  1: ['প্রথম', 'প্রথমটা', 'প্রথমটি', 'first', 'prothom', 'prothomta'],
  2: ['দ্বিতীয়', 'দ্বিতীয়টা', 'second', 'ditiyo'],
  3: ['তৃতীয়', 'তৃতীয়টা', 'third', 'tritiyo'],
  4: ['চতুর্থ', 'fourth'],
  5: ['পঞ্চম', 'fifth'],
};

int? _ordinal(String t) {
  for (final e in _ordinalWords.entries) {
    if (_any(t, e.value)) return e.key;
  }
  if (_any(t, ['শেষ', 'last'])) return -1;
  return null;
}

/* ----------------------------------------------------------- what time of day */

const _morning = ['সকাল', 'সকালে', 'ভোর', 'morning', 'shokal', 'shokale'];
const _noon = ['দুপুর', 'দুপুরে', 'noon', 'midday', 'dupur'];
const _afternoon = ['বিকাল', 'বিকেল', 'বিকালে', 'afternoon', 'bikal', 'bikel'];
const _evening = ['সন্ধ্যা', 'সন্ধ্যায়', 'evening', 'shondha'];
const _night = ['রাত', 'রাতে', 'night', 'overnight', 'rat', 'rate'];

/// A representative hour for a spoken time. Used as "closest departure to",
/// never as an exact filter — somebody saying "morning" will take 06:00 or
/// 07:30 and does not want an empty list because neither is exactly 08:00.
int? _hour(String t) {
  // An explicit clock time wins: "the 6 o'clock one", "ছয়টার বাস".
  final clock = RegExp(r'(^| )(\d{1,2})\s*(?:ta|টা|o.?clock|:00)').firstMatch(t);
  if (clock != null) {
    final h = int.tryParse(clock.group(2)!);
    if (h != null && h >= 0 && h <= 23) {
      // "6" said alongside a night word means 18:00, not 06:00.
      if (h < 12 && (_any(t, _night, prefix: true) || _any(t, _evening, prefix: true))) {
        return h + 12;
      }
      return h;
    }
  }
  if (_any(t, _morning, prefix: true)) return 7;
  if (_any(t, _noon, prefix: true)) return 12;
  if (_any(t, _afternoon, prefix: true)) return 15;
  if (_any(t, _evening, prefix: true)) return 18;
  if (_any(t, _night, prefix: true)) return 22;
  return null;
}

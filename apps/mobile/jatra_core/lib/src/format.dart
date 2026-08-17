import 'i18n.dart';

/// Money, dates and times.
///
/// One rule runs through all of it: Bangla words, Latin figures. `intl` is not
/// used for numbers on purpose — its bn-BD locale renders Bengali numerals, and
/// ৳১,২০০ on one screen next to ৳1,200 on another is how a passenger and a
/// clerk end up unable to check a fare against each other over the phone.

const List<String> _bnMonth = [
  'জানু', 'ফেব্রু', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্ট', 'অক্টো', 'নভে', 'ডিসে',
];
const List<String> _enMonth = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const List<String> _bnWeekday = ['সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি', 'রবি'];
const List<String> _enWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// Dhaka is UTC+6 all year — Bangladesh has kept no daylight saving since the
/// 2009 experiment, so a fixed offset is correct rather than merely convenient.
const Duration _dhakaOffset = Duration(hours: 6);

DateTime _dhaka(DateTime t) => t.toUtc().add(_dhakaOffset);

String _two(int n) => n < 10 ? '0$n' : '$n';

/// Groups in threes, the way `en-BD` does — 1,20,000 is the Indian convention
/// and not what this market's own English locale produces.
String _group(int v) {
  final s = v.abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return (v < 0 ? '-' : '') + b.toString();
}

/// Poisha in, taka out. Never a double: the argument is an integer count of
/// hundredths, and the decimal point is a rendering decision made here.
String taka(int poisha, {bool decimals = false}) {
  final whole = poisha ~/ 100;
  if (!decimals) return '৳${_group(whole)}';
  final rest = (poisha % 100).abs();
  return '৳${_group(whole)}.${_two(rest)}';
}

/// 24-hour, both languages. Unambiguous at one in the morning, which a bus
/// timetable genuinely needs to be.
String timeOf(String iso, [Lang lang = Lang.bn]) {
  final t = DateTime.tryParse(iso);
  if (t == null) return '—';
  final d = _dhaka(t);
  return '${_two(d.hour)}:${_two(d.minute)}';
}

String dateOf(String iso, [Lang lang = Lang.bn]) {
  final t = DateTime.tryParse(iso);
  if (t == null) return '—';
  final d = _dhaka(t);
  final wd = (lang == Lang.bn ? _bnWeekday : _enWeekday)[d.weekday - 1];
  final mo = (lang == Lang.bn ? _bnMonth : _enMonth)[d.month - 1];
  return '$wd, ${d.day} $mo';
}

String dateTimeOf(String iso, [Lang lang = Lang.bn]) =>
    '${dateOf(iso, lang)}, ${timeOf(iso, lang)}';

/// "5h 30m" / "5ঘ 30মি"
String durationOf(int minutes, [Lang lang = Lang.bn]) {
  if (minutes <= 0) return '—';
  final h = minutes ~/ 60, m = minutes % 60;
  final hu = lang == Lang.bn ? 'ঘ' : 'h';
  final mu = lang == Lang.bn ? 'মি' : 'm';
  if (h == 0) return '$m$mu';
  return m == 0 ? '$h$hu' : '$h$hu $m$mu';
}

/// Today / Tomorrow / a date, in the reader's language.
String dayOf(String iso, L l) {
  final t = DateTime.tryParse(iso);
  if (t == null) return '—';
  final a = _dhaka(t), b = _dhaka(DateTime.now());
  final days = DateTime(a.year, a.month, a.day).difference(DateTime(b.year, b.month, b.day)).inDays;
  if (days == 0) return l('common.today');
  if (days == 1) return l('common.tomorrow');
  return dateOf(iso, l.lang);
}

/// yyyy-MM-dd in Dhaka time, which is the date the platform's search means.
String isoDate(DateTime t) {
  final d = _dhaka(t);
  return '${d.year}-${_two(d.month)}-${_two(d.day)}';
}

import 'package:flutter_test/flutter_test.dart';
import 'package:jatra_core/jatra_core.dart';

/// The voice grammar, pinned by a table of things people actually say.
///
/// This is where nearly all of the testable value in the voice feature lives.
/// The microphone cannot be driven in CI and speech recognition is somebody
/// else's software; what is ours is the step that turns a transcript into an
/// action, and that step is a pure function, so it can be held to an exact
/// answer for every phrase below.
///
/// The dangerous failures are not the ones where nothing is understood. They
/// are the ones where the WRONG thing is understood confidently — "না" read as
/// yes, "the 6 o'clock one" read as six seats — because those spend money. The
/// negative cases at the bottom exist for those.
void main() {
  // Fixed so "কাল" is a date and not a moving target. A Tuesday.
  final now = DateTime(2026, 8, 18, 10, 0);
  DateTime day(int d) => DateTime(2026, 8, d);

  VoiceIntent p(String s) => parseVoice(s, now: now);

  group('a journey', () {
    test('Bangla, spoken the way it is spoken', () {
      final i = p('কাল ঢাকা থেকে চট্টগ্রাম');
      expect(i.action, VoiceAction.search);
      expect(i.from, 'ঢাকা');
      expect(i.to, 'চট্টগ্রাম');
      expect(i.date, day(19));
    });

    test('Latin-typed Bangla, which is half of what gets typed here', () {
      final i = p('kal dhaka theke chittagong');
      expect(i.action, VoiceAction.search);
      expect(i.from, 'dhaka');
      expect(i.to, 'chittagong');
      expect(i.date, day(19));
    });

    test('English', () {
      final i = p('I want to go from Dhaka to Sylhet tomorrow');
      expect(i.action, VoiceAction.search);
      expect(i.to, 'sylhet');
      expect(i.date, day(19));
    });

    test('code-switched, which is how most people actually talk', () {
      final i = p('আজ dhaka theke coxs bazar');
      expect(i.action, VoiceAction.search);
      expect(i.from, 'dhaka');
      expect(i.to, 'coxs bazar');
      expect(i.date, day(18));
    });

    test('filler around the place names is stripped, not kept', () {
      final i = p('আমি কাল ঢাকা থেকে সিলেট যাব');
      expect(i.from, 'ঢাকা');
      expect(i.to, 'সিলেট',
          reason: 'যাব must not end up glued to the destination');
    });

    test('a two-word place survives the stripping', () {
      final i = p('dhaka to coxs bazar');
      expect(i.to, 'coxs bazar');
    });

    test('the day after tomorrow is not tomorrow', () {
      expect(p('পরশু ঢাকা থেকে খুলনা').date, day(20));
      expect(p('day after tomorrow dhaka to khulna').date, day(20),
          reason: 'the English phrase contains the word tomorrow');
    });

    test('a weekday means the next one, never today', () {
      // now is a Tuesday; "Tuesday" must mean next week, not four hours ago.
      expect(p('mongolbar dhaka theke feni').date, day(25));
      expect(p('friday dhaka to feni').date, day(21));
    });

    test('a fragment is still an answer', () {
      // "which day?" -> "kal"
      final i = p('kal');
      expect(i.action, VoiceAction.search);
      expect(i.date, day(19));
      expect(i.from, isNull);
    });
  });

  group('how many seats', () {
    test('counted in either language', () {
      expect(p('duita seat').seats, 2);
      expect(p('দুইটা সিট').seats, 2);
      expect(p('three tickets').seats, 3);
      expect(p('4 টা আসন').seats, 4);
    });

    test('a bare number is NOT a seat count', () {
      // This is the one that would quietly book six seats for somebody who
      // asked for the six o'clock bus.
      expect(p('ছয়টার বাস').seats, isNull);
      expect(p('the 6 o clock one').seats, isNull);
      expect(p('two').seats, isNull);
    });
  });

  group('picking one out of a list', () {
    test('by position', () {
      final i = p('প্রথমটা');
      expect(i.action, VoiceAction.choose);
      expect(i.ordinal, 1);
    });

    test('by departure time', () {
      final i = p('the 6 o clock one');
      expect(i.action, VoiceAction.choose);
      expect(i.hour, 6);
    });

    test('by time of day', () {
      expect(p('shokal er ta').hour, 7);
      expect(p('রাতের বাসটা').hour, 22);
    });

    test('an evening hour is read as evening', () {
      expect(p('night 8 ta').hour, 20, reason: '8 at night is 20:00, not 08:00');
    });

    test('Bangla digits are digits', () {
      // A Bangla recogniser returns ৮, and the product writes figures in Latin.
      expect(p('রাত ৮টা').hour, 20);
      expect(p('৩টি সিট').seats, 3);
    });

    test('a journey with a time is a search, not a choice', () {
      final i = p('kal shokale dhaka theke chittagong');
      expect(i.action, VoiceAction.search,
          reason: 'it names a route, so it is a new search that happens to '
              'prefer the morning');
      expect(i.hour, 7);
    });
  });

  group('yes, no, and the things that must never be confused', () {
    test('yes', () {
      for (final s in ['হ্যাঁ', 'হ্যা', 'জি', 'ঠিক আছে', 'yes', 'ok', 'thik ache']) {
        expect(p(s).action, VoiceAction.confirm, reason: '"$s" should be yes');
      }
    });

    test('no', () {
      for (final s in ['না', 'নাহ', 'no', 'nope', 'wrong']) {
        expect(p(s).action, VoiceAction.reject, reason: '"$s" should be no');
      }
    });

    test('a confirmation is never re-read as a search', () {
      // "হ্যাঁ" in answer to "hold these seats?" must not start a new journey
      // just because some other word in the sentence looks like a place.
      final i = p('হ্যাঁ ঠিক আছে');
      expect(i.action, VoiceAction.confirm);
      expect(i.hasJourney, isFalse);
    });

    test('no is not swallowed by a sentence that also mentions a journey', () {
      final i = p('না ঢাকা না');
      expect(i.action, VoiceAction.reject,
          reason: 'anything containing a refusal is a refusal — the cost of '
              'getting this backwards is a seat held against somebody who said no');
    });

    // The bug this group exists for, found by running the parser rather than
    // reading it: matching Bangla by containment made খুলনা end in না, so a
    // passenger asking for a bus to Khulna was refusing. On this screen a
    // refusal releases held seats.
    test('a place name that ENDS in a refusal is not a refusal', () {
      final i = p('পরশু ঢাকা থেকে খুলনা');
      expect(i.action, VoiceAction.search,
          reason: 'খুলনা ends in না — "no" — and must not be read as one');
      expect(i.to, 'খুলনা');
      expect(i.date, day(20));
    });

    test('a place name that STARTS with a refusal is not a refusal', () {
      // নাটোর and নারায়ণগঞ্জ both begin with না; nagad begins with na.
      expect(p('ঢাকা থেকে নাটোর').action, VoiceAction.search);
      expect(p('dhaka to narayanganj').action, VoiceAction.search);
      expect(p('pay with nagad').action, VoiceAction.pay,
          reason: '"nagad" begins with "na" and must not be a refusal');
    });

    test('morning does not mean tomorrow', () {
      // সকাল contains কাল. Containment matching moved the travel date a day.
      final i = p('আজ সকালে ঢাকা থেকে ফেনী');
      expect(i.date, day(18), reason: 'সকাল contains কাল, but means morning');
      expect(i.hour, 7);
    });
  });

  group('paying', () {
    test('named provider', () {
      final i = p('বিকাশে টাকা দাও');
      expect(i.action, VoiceAction.pay);
      expect(i.provider, 'BKASH');
    });

    test('English, and nagad', () {
      final i = p('pay with nagad');
      expect(i.action, VoiceAction.pay);
      expect(i.provider, 'NAGAD');
    });

    test('pay with no provider named is still pay', () {
      final i = p('টাকা দিন');
      expect(i.action, VoiceAction.pay);
      expect(i.provider, isNull);
    });
  });

  group('nothing understood stays nothing understood', () {
    test('silence', () {
      expect(p('').action, VoiceAction.none);
      expect(p('   ').action, VoiceAction.none);
    });

    test('noise is not guessed at', () {
      // The whole point: on a screen where the next step spends money, an
      // unrecognised phrase must do nothing at all rather than something
      // plausible.
      for (final s in ['aaaaa', 'গরুর মাংস', 'what is the weather']) {
        expect(p(s).action, VoiceAction.none, reason: '"$s" should not be understood');
      }
    });

    test('the transcript is always kept, so a mishearing is visible', () {
      expect(p('total nonsense here').transcript, 'total nonsense here');
    });
  });
}

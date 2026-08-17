import 'package:flutter/widgets.dart';

import 'api/client.dart';

/// Bangla and English, with Bangla the default.
///
/// The rule the web product settled on and this follows exactly: **Bangla
/// words, Latin figures.** Fares, clock times, seat numbers, ticket numbers and
/// phone numbers stay in Latin digits in both languages, because those are the
/// things that get read aloud down a phone line and copied onto a paper ticket.
/// A ৳1,200 that becomes ৳১,২০০ in one language is a number two people cannot
/// check against each other.
enum Lang { bn, en }

extension LangName on Lang {
  String get label => this == Lang.bn ? 'বাংলা' : 'English';
  String get code => name;
}

typedef Vars = Map<String, Object>;

class Str {
  const Str(this.en, this.bn);
  final String en, bn;
  String call(Lang l) => l == Lang.bn ? bn : en;
}

/// The catalogue. Keys match the web product's where the same sentence appears,
/// so a change of wording can be made in both places by searching for one key.
const Map<String, Str> kStrings = {
  /* ------------------------------------------------------------- common */
  'app.passenger': Str('Jatra', 'যাত্রা'),
  'app.crew': Str('Jatra Crew', 'যাত্রা ক্রু'),
  'common.back': Str('Back', 'ফিরে যান'),
  'common.next': Str('Next', 'পরের ধাপ'),
  'common.cancel': Str('Cancel', 'বাতিল'),
  'common.close': Str('Close', 'বন্ধ করুন'),
  'common.retry': Str('Try again', 'আবার চেষ্টা করুন'),
  'common.today': Str('Today', 'আজ'),
  'common.tomorrow': Str('Tomorrow', 'আগামীকাল'),
  'common.loading': Str('Just a moment…', 'একটু অপেক্ষা করুন…'),
  'common.offline': Str('No connection', 'নেটওয়ার্ক নেই'),
  'common.seat': Str('Seat', 'আসন'),
  'common.seats': Str('Seats', 'আসন'),
  'common.total': Str('Total', 'মোট'),
  'common.language': Str('Language', 'ভাষা'),
  'common.signOut': Str('Sign out', 'সাইন আউট'),
  'common.phone': Str('Mobile number', 'মোবাইল নম্বর'),
  'common.name': Str('Name', 'নাম'),
  'common.ticketNo': Str('Ticket number', 'টিকিট নম্বর'),

  /* ------------------------------------------------------------- refusals */
  // Keyed by the code the transport raises, because the transport has no
  // language. Everything a person is told when something fails goes through
  // `errorText` below and lands here — otherwise the app is Bangla right up
  // until the moment it has bad news, which is exactly the moment being
  // understood matters most.
  'err.timeout': Str('The service did not answer in time. Check the connection and try again.',
      'সময়মতো উত্তর আসেনি। সংযোগ দেখে আবার চেষ্টা করুন।'),
  'err.network': Str('We could not reach the service. Check the connection and try again.',
      'সার্ভিসে পৌঁছানো গেল না। সংযোগ দেখে আবার চেষ্টা করুন।'),
  'err.unauthenticated': Str('Your session has ended. Please sign in again.',
      'আপনার সেশন শেষ হয়ে গেছে। আবার সাইন ইন করুন।'),
  'err.refused': Str('The service refused that request. Please try again.',
      'সার্ভিস অনুরোধটি নেয়নি। আবার চেষ্টা করুন।'),
  'err.bad_response': Str('The service returned something unexpected.',
      'সার্ভিস থেকে অপ্রত্যাশিত উত্তর এসেছে।'),
  'err.unknown': Str('Something went wrong. Please try again.',
      'কিছু একটা গোলমাল হয়েছে। আবার চেষ্টা করুন।'),
  // The platform's own sign-in vocabulary. It sends these codes with English
  // sentences; the crew app is Bangla for people who work in Bangla, and the
  // sign-in screen is the one screen every one of them meets.
  'err.bad_credentials': Str('That email and password do not match.',
      'এই ইমেইল আর পাসওয়ার্ড মিলছে না।'),
  'err.mfa_required': Str('Enter the six-digit code from your authenticator app.',
      'আপনার অথেনটিকেটর অ্যাপের ছয় অঙ্কের কোডটি দিন।'),
  'err.mfa_invalid': Str('That code is not right. Try the next one.',
      'কোডটি ঠিক নয়। পরেরটি এলে চেষ্টা করুন।'),
  'err.mfa_replayed': Str('That code has already been used. Wait for the next one.',
      'এই কোডটি একবার ব্যবহার হয়ে গেছে। পরেরটির জন্য অপেক্ষা করুন।'),
  'err.bad_code': Str('That code is wrong or has expired. Ask for a new one.',
      'কোডটি ভুল, বা মেয়াদ শেষ। নতুন কোড চেয়ে নিন।'),
  'err.token_reuse': Str(
      'For your safety we signed out every device from that sign-in. Please sign in again.',
      'নিরাপত্তার জন্য ওই সাইন ইনের সব ডিভাইস সাইন আউট করা হয়েছে। আবার সাইন ইন করুন।'),

  /* ------------------------------------------------------ passenger nav */
  'nav.search': Str('Find a bus', 'বাস খুঁজুন'),
  'nav.tickets': Str('My tickets', 'আমার টিকিট'),
  'nav.offers': Str('Offers', 'অফার'),
  'nav.account': Str('Account', 'অ্যাকাউন্ট'),

  /* ---------------------------------------------------------- searching */
  'find.from': Str('From', 'কোথা থেকে'),
  'find.to': Str('To', 'কোথায় যাবেন'),
  'find.when': Str('When', 'কবে'),
  'find.go': Str('Show me the buses', 'বাস দেখান'),
  'find.searching': Str('Looking…', 'খোঁজা হচ্ছে…'),
  'find.none': Str('No buses on that day.', 'ওই দিনে কোনো বাস নেই।'),
  'find.noneHint': Str('Try the day before or the day after.',
      'আগের দিন বা পরের দিন দেখে নিন।'),
  'find.swap': Str('Swap', 'উল্টে দিন'),
  'find.seatsLeft': Str('{n} seats left', '{n}টি আসন খালি'),
  'find.oneSeatLeft': Str('1 seat left', '1টি আসন খালি'),
  'find.full': Str('Full', 'কোনো আসন নেই'),
  'find.from_': Str('from', 'শুরু'),
  'find.nonstop': Str('Direct', 'সরাসরি'),
  'find.results': Str('{n} buses', '{n}টি বাস'),

  /* ------------------------------------------------------------- seats */
  'seat.pick': Str('Choose your seats', 'আপনার আসন বেছে নিন'),
  'seat.free': Str('Free', 'খালি'),
  'seat.taken': Str('Taken', 'বিক্রি হয়ে গেছে'),
  'seat.yours': Str('Yours', 'আপনার'),
  'seat.women': Str('Kept for women', 'নারীদের জন্য'),
  'seat.driver': Str('Driver', 'চালক'),
  // Same wording as the website's seat map, because a sleeper berth is sold on
  // both and a passenger who checked one before opening the other should not
  // have to work out that two different phrases mean the same shelf.
  'seat.lowerDeck': Str('Lower deck', 'নিচের তলা'),
  'seat.upperDeck': Str('Upper deck', 'উপরের তলা'),
  'seat.max': Str('Up to 4 seats in one booking.', 'একবারে সর্বোচ্চ 4টি আসন।'),
  'seat.picked': Str('{seats} · {amount}', '{seats} · {amount}'),
  'seat.continue': Str('Continue with {n}', '{n}টি নিয়ে এগোন'),
  'seat.livemap': Str(
      'This map is live. A seat can be taken by somebody else while you look at it.',
      'এই ম্যাপ সরাসরি দেখাচ্ছে। আপনি দেখতে দেখতেই অন্য কেউ আসনটি নিয়ে নিতে পারেন।'),

  /* ------------------------------------------------------------ holding */
  'hold.left': Str('{mins}:{secs} left to finish', 'শেষ করতে বাকি {mins}:{secs}'),
  'hold.why': Str('Your seats are held for you until then.',
      'ততক্ষণ পর্যন্ত আসনগুলো আপনার জন্য রাখা আছে।'),
  'hold.gone': Str('The time ran out and the seats went back on sale.',
      'সময় শেষ হয়ে গেছে, আসনগুলো আবার বিক্রির জন্য খুলে গেছে।'),
  'hold.pickAgain': Str('Choose seats again', 'আবার আসন বাছুন'),
  'hold.taken': Str('Somebody took that seat a moment before you.',
      'আপনার একটু আগেই অন্য কেউ ওই আসনটি নিয়ে নিয়েছেন।'),

  /* --------------------------------------------------------- passengers */
  'pax.title': Str('Who is travelling', 'কারা যাচ্ছেন'),
  'pax.name': Str('Full name', 'পুরো নাম'),
  'pax.nameHint': Str('As written on the NID they will carry',
      'সাথে যে এনআইডি থাকবে তাতে যেভাবে লেখা'),
  'pax.phoneHint': Str('The ticket and any change of plan are sent here.',
      'টিকিট আর কোনো পরিবর্তনের খবর এই নম্বরেই যাবে।'),
  'pax.gender': Str('Gender', 'লিঙ্গ'),
  'pax.male': Str('Male', 'পুরুষ'),
  'pax.female': Str('Female', 'নারী'),
  'pax.needName': Str('Please write a name for every seat.',
      'প্রতিটি আসনের জন্য একটি নাম লিখুন।'),
  'pax.needPhone': Str('An 11-digit mobile number, please.',
      '11 সংখ্যার মোবাইল নম্বর লিখুন।'),

  /* ------------------------------------------------------------- paying */
  'pay.title': Str('Pay', 'টাকা দিন'),
  'pay.how': Str('How would you like to pay?', 'কীভাবে টাকা দেবেন?'),
  'pay.bkash': Str('bKash', 'বিকাশ'),
  'pay.nagad': Str('Nagad', 'নগদ'),
  'pay.card': Str('Card', 'কার্ড'),
  'pay.fare': Str('{n} × fare', '{n} × ভাড়া'),
  'pay.fee': Str('Service fee', 'সার্ভিস ফি'),
  'pay.discount': Str('Discount', 'ছাড়'),
  'pay.coupon': Str('Offer code', 'অফার কোড'),
  'pay.couponAdd': Str('Add', 'যোগ করুন'),
  'pay.now': Str('Pay {amount}', '{amount} দিন'),
  'pay.working': Str('Talking to {provider}…', '{provider}-এর সাথে কথা হচ্ছে…'),
  'pay.sandbox': Str('Sandbox payment — no real money moves.',
      'পরীক্ষামূলক পেমেন্ট — সত্যিকারের কোনো টাকা যাচ্ছে না।'),
  'pay.approve': Str('Approve the payment', 'পেমেন্ট অনুমোদন করুন'),
  'pay.decline': Str('Decline it', 'বাতিল করুন'),
  'pay.checking': Str('Checking with the bank…', 'ব্যাংকের সাথে মিলিয়ে দেখা হচ্ছে…'),
  'pay.confirmNote': Str(
      'We wait for the payment provider to confirm before your ticket is issued. That is why this takes a moment.',
      'পেমেন্ট প্রতিষ্ঠান নিশ্চিত না করা পর্যন্ত আমরা টিকিট দিই না। এজন্যই একটু সময় লাগে।'),
  'pay.failed': Str('The payment did not go through. Nothing has been taken.',
      'পেমেন্ট হয়নি। আপনার কোনো টাকা কাটা হয়নি।'),

  /* ------------------------------------------------------------ tickets */
  'tk.yours': Str('Your ticket', 'আপনার টিকিট'),
  'tk.show': Str('Show this at the door', 'বাসে ওঠার সময় এটি দেখান'),
  'tk.savedOnPhone': Str('Saved on this phone — it opens with no signal.',
      'এই ফোনে জমা আছে — নেটওয়ার্ক ছাড়াই খুলবে।'),
  'tk.none': Str('No tickets yet.', 'এখনো কোনো টিকিট নেই।'),
  'tk.noneHint': Str('Buy one and it will be here, and on this phone even without signal.',
      'একটি কাটলে সেটি এখানে থাকবে — নেটওয়ার্ক না থাকলেও এই ফোনে থাকবে।'),
  'tk.upcoming': Str('Coming up', 'সামনে'),
  'tk.past': Str('Past', 'আগের'),
  'tk.cancel': Str('Cancel this ticket', 'টিকিট বাতিল করুন'),
  'tk.track': Str('Where is my bus?', 'আমার বাস কোথায়?'),
  'tk.brightness': Str('The screen brightens so the scanner can read it.',
      'স্ক্যানার যাতে পড়তে পারে সেজন্য স্ক্রিন উজ্জ্বল হয়েছে।'),

  /* ----------------------------------------------------------- refunds */
  'rf.title': Str('Cancel this ticket', 'টিকিট বাতিল করুন'),
  'rf.getBack': Str('You would get back', 'আপনি ফেরত পাবেন'),
  'rf.ofPaid': Str('of the {amount} you paid', 'আপনার দেওয়া {amount} টাকার মধ্যে'),
  'rf.becauseHours': Str('because there are {hours} hours until the bus leaves',
      'কারণ বাস ছাড়তে আর {hours} ঘণ্টা বাকি'),
  'rf.ladder': Str('How much comes back depends on when you cancel',
      'কখন বাতিল করছেন তার উপর কত ফেরত পাবেন তা নির্ভর করে'),
  'rf.cannot': Str('This ticket cannot be cancelled.', 'এই টিকিট বাতিল করা যাবে না।'),
  'rf.confirm': Str('Yes, cancel it', 'হ্যাঁ, বাতিল করুন'),
  'rf.keep': Str('Keep my ticket', 'টিকিট রেখে দিন'),
  'rf.done': Str('Cancelled. {amount} is on its way back to you.',
      'বাতিল হয়েছে। {amount} আপনার কাছে ফেরত যাচ্ছে।'),
  'rf.reason': Str('Why are you cancelling? (optional)',
      'কেন বাতিল করছেন? (ইচ্ছা হলে লিখুন)'),

  /* ---------------------------------------------------------- tracking */
  'tr.title': Str('Where is my bus?', 'আমার বাস কোথায়?'),
  'tr.live': Str('Live from the bus', 'বাস থেকে সরাসরি'),
  'tr.scheduled': Str('From the timetable — the bus is not reporting its position yet',
      'সময়সূচি অনুযায়ী — বাস এখনো নিজের অবস্থান জানাচ্ছে না'),
  'tr.next': Str('Next stop', 'পরের স্টপ'),
  'tr.eta': Str('Expected {time}', '{time}-এ পৌঁছাবে'),
  'tr.departed': Str('Left at {time}', '{time}-এ ছেড়েছে'),
  'tr.departs': Str('Leaves at {time}', '{time}-এ ছাড়বে'),
  'tr.arrived': Str('Arrived', 'পৌঁছে গেছে'),

  /* ------------------------------------------------------------ offers */
  'of.title': Str('Offers', 'অফার'),
  'of.lead': Str('Type the code in the offer box when you pay.',
      'টাকা দেওয়ার সময় অফার কোডের ঘরে লিখুন।'),
  'of.pctOff': Str('{pct}% off', '{pct}% ছাড়'),
  'of.amountOff': Str('{amount} off', '{amount} ছাড়'),
  'of.copied': Str('Copied', 'কপি হয়েছে'),
  'of.copy': Str('Copy', 'কপি'),
  'of.minSpend': Str('On fares of {amount} or more', '{amount} বা তার বেশি ভাড়ায়'),
  'of.none': Str('No offers right now.', 'এখন কোনো অফার নেই।'),

  /* ----------------------------------------------------------- account */
  'ac.signIn': Str('Sign in', 'সাইন ইন'),
  'ac.signInWhy': Str(
      'You do not need an account to buy a ticket. Signing in keeps your tickets together on one number.',
      'টিকিট কাটতে অ্যাকাউন্ট লাগে না। সাইন ইন করলে আপনার সব টিকিট এক নম্বরে একসাথে থাকে।'),
  'ac.sendCode': Str('Send me a code', 'কোড পাঠান'),
  'ac.codeSent': Str('We sent a six-digit code to {phone}.',
      '{phone} নম্বরে ছয় অঙ্কের একটি কোড পাঠানো হয়েছে।'),
  'ac.code': Str('Six-digit code', 'ছয় অঙ্কের কোড'),
  'ac.verify': Str('Sign me in', 'সাইন ইন করুন'),
  'ac.wrongCode': Str('That code did not match. Try again.',
      'কোডটি মেলেনি। আবার চেষ্টা করুন।'),
  'ac.biometric': Str('Use fingerprint or face next time',
      'পরেরবার আঙুলের ছাপ বা মুখ দিয়ে খুলুন'),
  'ac.biometricPrompt': Str('Unlock Jatra', 'যাত্রা খুলুন'),
  'ac.biometricOn': Str('On — this phone will ask for your fingerprint.',
      'চালু আছে — এই ফোন আপনার আঙুলের ছাপ চাইবে।'),
  'ac.savedRoutes': Str('Journeys you take often', 'যে পথে আপনি প্রায়ই যান'),
  'ac.saveRoute': Str('Save this journey', 'এই পথটি রাখুন'),
  'ac.routeSaved': Str('Saved. It is on your home screen now.',
      'রাখা হয়েছে। এখন এটি আপনার হোম স্ক্রিনে আছে।'),
  'ac.reminders': Str('Remind me before the bus leaves',
      'বাস ছাড়ার আগে আমাকে মনে করিয়ে দিন'),
  'ac.remindersOn': Str('On — a reminder two hours before, and again at one hour.',
      'চালু আছে — দুই ঘণ্টা আগে একবার, আবার এক ঘণ্টা আগে।'),
  'ac.guest': Str('Not signed in', 'সাইন ইন করা নেই'),

  /* -------------------------------------------------------------- crew */
  'cr.signIn': Str('Crew sign in', 'ক্রু সাইন ইন'),
  'cr.email': Str('Work email', 'কাজের ইমেইল'),
  'cr.password': Str('Password', 'পাসওয়ার্ড'),
  'cr.code': Str('Six-digit code', 'ছয় অঙ্কের কোড'),
  'cr.signingIn': Str('Signing in…', 'ঢোকা হচ্ছে…'),
  'cr.myTrips': Str('My trips', 'আমার যাত্রা'),
  'cr.nextDays': Str('Today and the next two days', 'আজ ও পরের দুই দিন'),
  'cr.none': Str('Nothing is rostered to you in the next few days.',
      'আগামী কয়েক দিনে আপনার নামে কিছু দেওয়া হয়নি।'),
  'cr.role.DRIVER': Str('Driver', 'চালক'),
  'cr.role.HELPER': Str('Helper', 'হেল্পার'),
  'cr.role.SUPERVISOR': Str('Supervisor', 'সুপারভাইজার'),
  // What the platform sends when nobody has been put against the trip yet. It
  // is a real answer and it belongs on the card: "not assigned" tells a driver
  // to go and ask, where a blank tells them nothing at all.
  'cr.role.UNASSIGNED': Str('Not assigned', 'দায়িত্ব দেওয়া হয়নি'),
  'cr.list': Str('Passenger list', 'যাত্রী তালিকা'),
  'cr.check': Str('Check tickets', 'টিকিট দেখুন'),
  'cr.problem': Str('Report a problem', 'সমস্যা জানান'),
  'cr.share': Str('Share where we are', 'আমরা কোথায় আছি জানান'),
  'cr.sharing': Str('Sending our position every few seconds.',
      'কয়েক সেকেন্ড পরপর আমাদের অবস্থান পাঠানো হচ্ছে।'),
  'cr.shareStop': Str('Stop sharing', 'জানানো বন্ধ করুন'),
  'cr.shareWhy': Str(
      'While this is on, the passengers on this bus see where it really is instead of a timetable guess.',
      'এটি চালু থাকলে এই বাসের যাত্রীরা সময়সূচির আন্দাজের বদলে বাসটি আসলে কোথায় আছে তা দেখতে পান।'),
  'cr.noGps': Str('This phone will not give its position.',
      'এই ফোন নিজের অবস্থান দিতে চাইছে না।'),
  'cr.ofTotal': Str('{done} of {total} on board', '{total} জনের মধ্যে {done} জন উঠেছেন'),
  'cr.do.BOARDING': Str('Start boarding', 'যাত্রী তোলা শুরু'),
  'cr.do.DEPARTED': Str('We have left', 'আমরা ছেড়েছি'),
  'cr.do.IN_PROGRESS': Str('On the road', 'পথে আছি'),
  'cr.do.ARRIVED': Str('We have arrived', 'পৌঁছে গেছি'),
  'cr.done': Str('Written down.', 'লেখা হয়েছে।'),

  /* ------------------------------------------------------ crew · at the door */
  'sc.title': Str('Check tickets', 'টিকিট দেখুন'),
  'sc.scan': Str('Scan the QR', 'QR স্ক্যান করুন'),
  'sc.type': Str('Type the number instead', 'বদলে নম্বর লিখুন'),
  'sc.number': Str('Ticket number', 'টিকিট নম্বর'),
  'sc.go': Str('Check', 'দেখুন'),
  'sc.ok': Str('Let them on', 'উঠতে দিন'),
  'sc.already': Str('Already boarded', 'আগেই উঠেছেন'),
  'sc.bad': Str('Do not let them on', 'উঠতে দেবেন না'),
  'sc.seatIs': Str('Seat {seat}', 'আসন {seat}'),
  'sc.provisional': Str('Written down on this phone — the office has not confirmed it yet.',
      'এই ফোনে লেখা হয়েছে — অফিস এখনো নিশ্চিত করেনি।'),
  'sc.waiting1': Str('1 check taken without signal, waiting to send.',
      'নেটওয়ার্ক ছাড়া 1টি যাচাই নেওয়া হয়েছে, পাঠানোর অপেক্ষায়।'),
  'sc.waiting': Str('{n} checks taken without signal, waiting to send.',
      'নেটওয়ার্ক ছাড়া {n}টি যাচাই নেওয়া হয়েছে, পাঠানোর অপেক্ষায়।'),
  'sc.sendNow': Str('Send now', 'এখনই পাঠান'),
  'sc.sent1': Str('Sent 1 check.', '1টি যাচাই পাঠানো হয়েছে।'),
  'sc.sent': Str('Sent {n} checks.', '{n}টি যাচাই পাঠানো হয়েছে।'),
  'sc.notOnList': Str('Not on the list we downloaded before leaving. Check by hand.',
      'ছাড়ার আগে নামানো তালিকায় এই নাম নেই। হাতে মিলিয়ে দেখুন।'),
  'sc.offBoarded': Str('Seat {seat}. Written down — it will be confirmed when the signal comes back.',
      'আসন {seat}। লেখা হয়েছে — নেটওয়ার্ক ফিরলে নিশ্চিত হয়ে যাবে।'),
  'sc.offAlready': Str('Already marked boarded before we lost signal — seat {seat}.',
      'নেটওয়ার্ক যাওয়ার আগেই উঠেছেন বলে লেখা হয়েছিল — আসন {seat}।'),
  // The verdict itself, keyed on the platform's result constant. The platform
  // writes these in English; the person reading them is standing at a bus door
  // in Bangladesh with the next passenger already pushing forward.
  'sc.msg.BOARDED': Str('Boarded — seat {seat}', 'উঠেছেন — আসন {seat}'),
  'sc.msg.ALREADY_BOARDED': Str('Already scanned. Seat {seat} is marked boarded.',
      'আগেই স্ক্যান হয়েছে। আসন {seat} ওঠা হিসেবে লেখা আছে।'),
  'sc.msg.WRONG_TRIP': Str('This ticket is for a different departure.',
      'এই টিকিট অন্য যাত্রার।'),
  'sc.msg.CANCELLED': Str('This ticket was cancelled. Do not board.',
      'এই টিকিট বাতিল হয়েছে। উঠতে দেবেন না।'),
  'sc.msg.NOT_FOUND': Str('No ticket found for that code.',
      'এই নম্বরে কোনো টিকিট পাওয়া যায়নি।'),
  'sc.msg.UNKNOWN': Str('That code could not be read.', 'নম্বরটি পড়া গেল না।'),
  'sc.recent': Str('Recent checks on this phone', 'এই ফোনে সাম্প্রতিক যাচাই'),
  'sc.cameraDenied': Str('The camera is not allowed, so type the number instead.',
      'ক্যামেরার অনুমতি নেই, তাই নম্বরটি লিখুন।'),

  /* ----------------------------------------------------- crew · problems */
  'in.which': Str('Which trip', 'কোন যাত্রা'),
  'in.what': Str('What happened', 'কী হয়েছে'),
  'in.serious': Str('How serious', 'কতটা জরুরি'),
  'in.details': Str('Tell them more', 'আরেকটু লিখুন'),
  'in.hint': Str('Held 20 minutes at the Meghna bridge',
      'মেঘনা সেতুতে 20 মিনিট আটকে ছিলাম'),
  'in.send': Str('Send to the office', 'অফিসে পাঠান'),
  'in.sent': Str('Sent. The office can see this now.',
      'পাঠানো হয়েছে। অফিস এখন এটা দেখতে পাচ্ছে।'),
  'in.foot': Str(
      'Sending this does more than write it down: the control room and the operator both get a message.',
      'এটা পাঠালে শুধু লেখা হয় না: কন্ট্রোল রুম আর অপারেটর দুজনেই খবর পান।'),
  'kind.BREAKDOWN': Str('Bus broke down', 'বাস নষ্ট হয়েছে'),
  'kind.ACCIDENT': Str('Accident', 'দুর্ঘটনা'),
  'kind.ROUTE_INTERRUPTION': Str('Road blocked', 'রাস্তা বন্ধ'),
  'kind.DELAY': Str('Running late', 'দেরি হচ্ছে'),
  'kind.PASSENGER_ISSUE': Str('Trouble with a passenger', 'যাত্রী নিয়ে সমস্যা'),
  'kind.OTHER': Str('Something else', 'অন্য কিছু'),
  'sev.LOW': Str('Minor', 'সামান্য'),
  'sev.MEDIUM': Str('Needs attention', 'দেখা দরকার'),
  'sev.HIGH': Str('Urgent', 'জরুরি'),

  /* ---------------------------------------------------------- statuses */
  'status.TICKETED': Str('Ticket issued', 'টিকিট হয়ে গেছে'),
  'status.CONFIRMED': Str('Confirmed', 'নিশ্চিত'),
  'status.PAYMENT_PENDING': Str('Waiting for payment', 'পেমেন্টের অপেক্ষায়'),
  'status.CANCELLED': Str('Cancelled', 'বাতিল'),
  'status.REFUNDED': Str('Refunded', 'ফেরত দেওয়া হয়েছে'),
  'status.COMPLETED': Str('Journey finished', 'যাত্রা শেষ'),
  'status.EXPIRED': Str('Expired', 'সময় শেষ'),
  'status.FAILED': Str('Did not go through', 'হয়নি'),
  'status.BOARDED': Str('On board', 'বাসে উঠেছেন'),
  'status.VALID': Str('Valid', 'বৈধ'),
  // Where a *trip* is up to, as against where a booking is. The crew roster
  // shows this on every card and had translations for none of it, so a driver
  // reading a Bangla app was handed the raw database word — OPEN — in English.
  // Wording matches the website's, because the same trip is described to the
  // office and to the road and they have to be talking about the same thing.
  'status.DRAFT': Str('Draft', 'খসড়া'),
  'status.SCHEDULED': Str('Scheduled', 'সময় ঠিক আছে'),
  'status.OPEN': Str('On sale', 'টিকিট বিক্রি চলছে'),
  'status.BOARDING': Str('Boarding now', 'যাত্রী উঠছে'),
  'status.DEPARTED': Str('On the road', 'পথে আছে'),
  'status.IN_PROGRESS': Str('On the road', 'পথে আছে'),
  'status.ARRIVED': Str('Arrived', 'পৌঁছে গেছে'),

  /* ------------------------------------------------------------ notify */
  'nt.soonTitle': Str('Your bus leaves in 2 hours', 'আপনার বাস 2 ঘণ্টা পরে ছাড়বে'),
  'nt.soonBody': Str('{route} · seat {seats} · leaves {time}',
      '{route} · আসন {seats} · ছাড়বে {time}'),
  'nt.nowTitle': Str('Your bus leaves in 1 hour', 'আপনার বাস 1 ঘণ্টা পরে ছাড়বে'),
  'nt.nowBody': Str('Be at {origin} in good time. Ticket {pnr}.',
      'সময়মতো {origin}-এ পৌঁছে যান। টিকিট {pnr}।'),
};

/// Fills `{placeholders}`. A missing value is left visible rather than blank,
/// so a broken string looks broken instead of looking like a missing figure.
String fill(String template, [Vars? vars]) {
  if (vars == null || vars.isEmpty) return template;
  return template.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) {
    final k = m.group(1)!;
    return vars.containsKey(k) ? '${vars[k]}' : m.group(0)!;
  });
}

/// The translator, handed down the widget tree.
class L {
  const L(this.lang);
  final Lang lang;

  String call(String key, [Vars? vars]) {
    final s = kStrings[key];
    // A key with no entry shows the key, which is loud in review and harmless
    // in the field — the alternative is a blank space where a sentence should
    // be, which nobody notices until a passenger does.
    if (s == null) return key;
    return fill(s(lang), vars);
  }

  bool get isBn => lang == Lang.bn;

  static L of(BuildContext context) => LangScope.of(context).l;

  /// The words to put on the screen for a refusal.
  ///
  /// Order matters, and it is this way round on purpose. A code this catalogue
  /// knows wins, because those are the transport's own generic failures and its
  /// English is only a fallback for a log file. Otherwise the platform's own
  /// sentence wins, because a specific refusal — *seat A1 has just gone* — is
  /// worth more to the person reading it than a correctly translated shrug.
  String error(Object e) {
    if (e is! ApiError) return this('err.unknown');
    if (kStrings.containsKey('err.${e.code}')) return this('err.${e.code}');
    return e.message.isNotEmpty ? e.message : this('err.unknown');
  }
}

/// Makes the current language available to every widget below it.
class LangScope extends InheritedWidget {
  const LangScope({super.key, required this.lang, required this.setLang, required super.child});

  final Lang lang;
  final void Function(Lang) setLang;

  L get l => L(lang);

  static LangScope of(BuildContext context) {
    final s = context.dependOnInheritedWidgetOfExactType<LangScope>();
    assert(s != null, 'No LangScope above this widget');
    return s!;
  }

  @override
  bool updateShouldNotify(LangScope old) => old.lang != lang;
}

/**
 * Bilingual interface.
 *
 * The backend has always known which language a passenger reads — `profile.lang`
 * defaults to 'bn' and the notification platform genuinely sends Bangla SMS. The
 * interface then spoke English at them anyway. This module closes that gap.
 *
 * Three decisions worth knowing:
 *
 * 1. THE LANGUAGE LIVES IN A COOKIE, not localStorage. The server has to know the
 *    language before it renders the first byte, because server rendering is what
 *    puts readable text on a slow Android screen while the JavaScript is still
 *    downloading. A client-only preference would render English, hydrate, and
 *    then flip — which is both slower and looks broken.
 *
 * 2. BOTH LANGUAGES SIT ON THE SAME LINE. A key carries its `en` and `bn`
 *    together rather than living in two files that drift. A missing translation
 *    is then a type error, not a silent English string in a Bangla sentence.
 *
 * 3. DIGITS STAY LATIN. Bengali numerals (০১২৩) are correct in prose but wrong
 *    here: they break `font-variant-numeric: tabular-nums`, they are not what a
 *    passenger reads off a counter fare board or a bKash confirmation, and a PNR
 *    or seat number must be transcribable over a phone call to a counter clerk.
 *    Bangla words, Latin figures — which is how fares are actually written in
 *    Bangladesh.
 */

export const LANGS = ['bn', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'bn';
export const LANG_COOKIE = 'jatra.lang';

export const LANG_NAME: Record<Lang, string> = { bn: 'বাংলা', en: 'English' };

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ strings */

type Entry = { en: string; bn: string };

/**
 * Note on the Bangla: bus companies in Bangladesh are "পরিবহন" (Hanif Paribahan,
 * Shyamoli Paribahan), so an operator is a পরিবহন and not a transliterated
 * "অপারেটর". A free seat is "খালি", which is what a counter clerk says. Getting
 * these right is the difference between a translated interface and a Bangla one.
 */
const S = {
  /* -------------------------------------------------------------- product */
  'brand.name':            { en: 'Jatra',                    bn: 'যাত্রা' },
  'brand.tagline':         { en: 'Bus tickets across Bangladesh', bn: 'সারা বাংলাদেশের বাসের টিকিট' },

  /* ------------------------------------------------------------------ nav */
  'nav.search':            { en: 'Search',                   bn: 'টিকিট খুঁজুন' },
  'nav.offers':            { en: 'Offers',                   bn: 'অফার' },
  'nav.manage':            { en: 'Manage booking',           bn: 'বুকিং দেখুন' },
  'nav.support':           { en: 'Support',                  bn: 'সহায়তা' },
  'nav.account':           { en: 'Account',                  bn: 'অ্যাকাউন্ট' },
  'nav.signin':            { en: 'Sign in',                  bn: 'সাইন ইন' },
  'nav.signout':           { en: 'Sign out',                 bn: 'সাইন আউট' },
  'nav.staff':             { en: 'Staff sign in',            bn: 'স্টাফ লগইন' },
  'nav.main':              { en: 'Main',                     bn: 'প্রধান' },
  'nav.language':          { en: 'Language',                 bn: 'ভাষা' },

  /* ----------------------------------------------------------------- home */
  'home.h1':               { en: 'Bus tickets across Bangladesh', bn: 'সারা বাংলাদেশের বাসের টিকিট' },
  'home.sub':              {
    en: 'Live seat availability from every operator, one checkout, instant e-ticket. Pay with bKash, Nagad or card.',
    bn: 'সব পরিবহনের খালি আসন সরাসরি দেখুন, এক জায়গায় পেমেন্ট, সঙ্গে সঙ্গে ই-টিকিট। বিকাশ, নগদ বা কার্ডে টাকা দিন।',
  },
  'home.popular':          { en: 'Popular routes',           bn: 'জনপ্রিয় রুট' },
  'home.note.daily':       { en: 'Several operators daily',  bn: 'প্রতিদিন কয়েকটি পরিবহন' },
  'home.note.shortHop':    { en: 'Short hop, about 2 hours', bn: 'অল্প পথ, প্রায় ২ ঘণ্টা' },
  'home.note.segment':     { en: 'Part-route fare',          bn: 'আংশিক পথের ভাড়া' },
  'home.note.overnight':   { en: 'Overnight AC coach',       bn: 'রাতের এসি কোচ' },

  /* The three promises. Each answers a failure passengers publicly report of
     the incumbent Bangladeshi ticketing apps, so they are claims we can be held
     to rather than marketing lines. */
  'home.f1.title':         { en: 'One seat, one buyer',      bn: 'এক আসন, একজন যাত্রী' },
  'home.f1.body':          {
    en: 'Seats are locked the instant you pick them. If two people tap the same seat, exactly one gets it — and the other finds out immediately, not after paying.',
    bn: 'আসনে চাপ দেওয়ার সঙ্গে সঙ্গে সেটি আটকে যায়। দুজন একই আসনে চাপ দিলে ঠিক একজনই পান — আর অন্যজন সঙ্গে সঙ্গেই জানতে পারেন, টাকা দেওয়ার পরে নয়।',
  },
  'home.f2.title':         { en: 'Pay for your part of the route', bn: 'যতটুকু যাবেন, ততটুকুর ভাড়া' },
  'home.f2.body':          {
    en: 'Travelling Cumilla to Chattogram only? You are charged for that leg, and the seat is resold for the part you are not using.',
    bn: 'শুধু কুমিল্লা থেকে চট্টগ্রাম যাচ্ছেন? আপনি ওই অংশটুকুরই ভাড়া দেবেন, আর বাকি অংশের জন্য আসনটি অন্য কারও কাছে বিক্রি হবে।',
  },
  'home.f3.title':         { en: 'Your ticket works without signal', bn: 'নেটওয়ার্ক ছাড়াই টিকিট চলবে' },
  'home.f3.body':          {
    en: 'Every booking issues a signed QR per passenger. It scans at the door whether or not you have signal.',
    bn: 'প্রতিটি বুকিংয়ে প্রত্যেক যাত্রীর জন্য আলাদা QR কোড দেওয়া হয়। নেটওয়ার্ক থাকুক বা না থাকুক, বাসে ওঠার সময় সেটি স্ক্যান হবে।',
  },

  /* --------------------------------------------------------------- search */
  'search.from':           { en: 'From',                     bn: 'কোথা থেকে' },
  'search.to':             { en: 'To',                       bn: 'কোথায়' },
  'search.date':           { en: 'Journey date',             bn: 'যাত্রার তারিখ' },
  'search.passengers':     { en: 'Passengers',               bn: 'যাত্রী সংখ্যা' },
  'search.submit':         { en: 'Search buses',             bn: 'বাস খুঁজুন' },
  'search.swap':           { en: 'Swap origin and destination', bn: 'যাত্রাপথ উল্টে দিন' },
  'search.pickFrom':       { en: 'Choose a starting point',   bn: 'যাত্রা শুরুর স্থান বাছুন' },
  'search.pickTo':         { en: 'Choose a destination',      bn: 'গন্তব্য বাছুন' },
  'search.sameCity':       { en: 'Choose two different places.', bn: 'দুটি আলাদা জায়গা বাছুন।' },
  'search.results':        { en: 'buses found',              bn: 'টি বাস পাওয়া গেছে' },
  'search.noResults':      { en: 'No buses on this route today', bn: 'এই রুটে আজ কোনো বাস নেই' },
  'search.noResultsHint':  { en: 'Try another date, or a nearby boarding point.', bn: 'অন্য তারিখ বা কাছের কোনো কাউন্টার দেখুন।' },
  'search.filters':        { en: 'Filters',                  bn: 'ফিল্টার' },
  'search.sort':           { en: 'Sort',                     bn: 'সাজান' },
  'search.sortDeparture':  { en: 'Departure time',           bn: 'ছাড়ার সময়' },
  'search.sortPrice':      { en: 'Lowest fare',              bn: 'কম ভাড়া আগে' },
  'search.sortDuration':   { en: 'Journey time',             bn: 'যাত্রার সময়' },
  'search.sortSeats':      { en: 'Most seats free',          bn: 'বেশি আসন খালি' },
  'search.searching':      { en: 'searching…',               bn: 'খোঁজা হচ্ছে…' },
  'search.showing':        { en: '{shown} of {total} departures', bn: '{total} টির মধ্যে {shown} টি দেখানো হচ্ছে' },
  'search.acOnly':         { en: 'AC only',                  bn: 'শুধু এসি' },
  /* Framed positively — "hide sold out" runs to 28 characters in Bangla against
     13 in English and pushed the operator chips off the row. "Has seats" says
     the same thing, shorter, in both. */
  'search.hideSoldOut':    { en: 'Has seats',                bn: 'আসন খালি আছে' },
  'search.clearAll':       { en: 'Clear filters',            bn: 'ফিল্টার মুছুন' },
  'search.noMatch':        { en: 'No buses match these filters', bn: 'এই ফিল্টারে কোনো বাস মেলেনি' },
  'search.clearHint':      { en: 'Try clearing a filter, or pick another date.', bn: 'একটি ফিল্টার সরান, বা অন্য তারিখ বাছুন।' },
  'search.nothingToday':   { en: 'Nothing is scheduled on this route that day.', bn: 'ওই দিন এই রুটে কোনো বাস নেই।' },
  'search.tryAnotherDay':  { en: 'Try a different day.',      bn: 'অন্য একটি দিন দেখুন।' },
  'search.otherDays':      { en: 'Other days',                bn: 'অন্যান্য দিন' },

  /* ------------------------------------------------------------- the trip */
  'trip.operator':         { en: 'Operator',                 bn: 'পরিবহন' },
  'trip.departs':          { en: 'Departs',                  bn: 'ছাড়ে' },
  'trip.arrives':          { en: 'Arrives',                  bn: 'পৌঁছায়' },
  'trip.duration':         { en: 'Journey time',             bn: 'যাত্রার সময়' },
  'trip.boarding':         { en: 'Boarding point',           bn: 'ওঠার স্থান' },
  'trip.dropping':         { en: 'Dropping point',           bn: 'নামার স্থান' },
  'trip.seatsFree':        { en: 'seats free',               bn: 'টি আসন খালি' },
  'trip.busType':          { en: 'Coach',                    bn: 'কোচ' },
  'trip.amenities':        { en: 'On board',                 bn: 'বাসে যা আছে' },
  'trip.selectSeats':      { en: 'Select seats',             bn: 'আসন বাছুন' },
  'trip.viewSeats':        { en: 'View seats',               bn: 'আসন দেখুন' },
  'trip.fareFrom':         { en: 'Fare from',                bn: 'ভাড়া শুরু' },
  'trip.perSeat':          { en: 'per seat',                 bn: 'প্রতি আসন' },
  'trip.soldOut':          { en: 'Sold out',                 bn: 'সব বিক্রি' },
  'trip.freeOf':           { en: '{free} of {total} free',   bn: '{total} টির মধ্যে {free} টি খালি' },
  'trip.onlyLeft':         { en: 'only {free} left',         bn: 'মাত্র {free} টি বাকি' },
  'trip.ac':               { en: 'AC',                       bn: 'এসি' },
  'trip.nonAc':            { en: 'Non-AC',                   bn: 'নন-এসি' },
  'trip.route':            { en: 'Route',                    bn: 'যাত্রাপথ' },
  'trip.board':            { en: 'Board',                    bn: 'উঠবেন' },
  'trip.drop':             { en: 'Drop',                     bn: 'নামবেন' },
  'trip.yourSelection':    { en: 'Your selection',           bn: 'আপনি যা বেছেছেন' },
  'trip.pickUpTo':         { en: 'Pick up to {n} seats from the map.', bn: 'ম্যাপ থেকে সর্বোচ্চ {n} টি আসন বাছুন।' },
  'trip.holding':          { en: 'Holding seats…',           bn: 'আসন ধরে রাখা হচ্ছে…' },
  /* No number. The hold window is the server's, and the old copy promised ten
     minutes against a service that may grant five. */
  'trip.holdNote':         {
    en: 'The seats are held for you while you fill in passenger details.',
    bn: 'যাত্রীর তথ্য দেওয়ার সময়টুকু আসনগুলো আপনার জন্য ধরে রাখা হবে।',
  },

  /* ----------------------------------------------------------- the seat map */
  'seat.title':            { en: 'Choose your seats',        bn: 'আপনার আসন বাছুন' },
  'seat.front':            { en: 'Front',                    bn: 'সামনে' },
  'seat.driver':           { en: 'Driver',                   bn: 'চালক' },
  'seat.lowerDeck':        { en: 'Lower deck',               bn: 'নিচের তলা' },
  'seat.upperDeck':        { en: 'Upper deck',               bn: 'উপরের তলা' },
  'seat.available':        { en: 'Available',                bn: 'খালি' },
  'seat.selected':         { en: 'Selected',                 bn: 'আপনি নিয়েছেন' },
  'seat.sold':             { en: 'Sold',                     bn: 'বিক্রি হয়ে গেছে' },
  'seat.held':             { en: 'Held by someone',          bn: 'অন্য কেউ ধরে রেখেছেন' },
  'seat.blocked':          { en: 'Not for sale',             bn: 'বিক্রির জন্য নয়' },
  'seat.legend':           { en: 'What the colours mean',    bn: 'রঙের অর্থ' },
  'seat.chosen':           { en: 'Your seats',               bn: 'আপনার আসন' },
  'seat.none':             { en: 'No seats chosen yet',      bn: 'এখনো কোনো আসন বাছা হয়নি' },
  'seat.max':              { en: 'You can book up to {n} seats at once', bn: 'একবারে সর্বোচ্চ {n} টি আসন নেওয়া যায়' },
  'seat.legOnly':          { en: 'Availability shown for your leg only', bn: 'শুধু আপনার যাত্রাপথের জন্য খালি আসন দেখানো হচ্ছে' },
  'seat.lostOne':          {
    en: 'Seat {seats} was just taken by someone else. Nothing was charged — please choose another.',
    bn: '{seats} আসনটি একটু আগে অন্য কেউ নিয়ে নিয়েছেন। কোনো টাকা কাটা হয়নি — অন্য একটি আসন বাছুন।',
  },
  'seat.lostMany':         {
    en: 'Seats {seats} were just taken by someone else. Nothing was charged — please choose again.',
    bn: '{seats} আসনগুলো একটু আগে অন্য কেউ নিয়ে নিয়েছেন। কোনো টাকা কাটা হয়নি — আবার বাছুন।',
  },
  'seat.legExplain':       {
    en: 'A seat sold on an earlier part of this route is genuinely free for yours.',
    bn: 'এই রুটের আগের অংশে বিক্রি হওয়া আসন আপনার অংশের জন্য সত্যিই খালি।',
  },

  /* --------------------------------------------------------------- the hold */
  'hold.title':            { en: 'Seats held for you',       bn: 'আপনার জন্য আসন ধরে রাখা আছে' },
  'hold.expiresIn':        { en: 'Time left',                bn: 'বাকি সময়' },
  'hold.expired':          { en: 'Your hold has expired',    bn: 'সময় শেষ হয়ে গেছে' },
  'hold.expiredHint':      { en: 'The seats went back on sale. Please choose again.', bn: 'আসনগুলো আবার বিক্রির জন্য খুলে দেওয়া হয়েছে। আবার বাছুন।' },
  'hold.urgent':           { en: 'Finish soon — the seats release when this reaches zero.', bn: 'তাড়াতাড়ি শেষ করুন — সময় ফুরালে আসন ছেড়ে দেওয়া হবে।' },

  /* -------------------------------------------------------------- passengers */
  'pax.title':             { en: 'Who is travelling',        bn: 'কারা যাচ্ছেন' },
  'pax.name':              { en: 'Full name',                bn: 'পুরো নাম' },
  'pax.phone':             { en: 'Mobile number',            bn: 'মোবাইল নম্বর' },
  'pax.email':             { en: 'Email (optional)',         bn: 'ইমেইল (না দিলেও চলবে)' },
  'pax.gender':            { en: 'Gender',                   bn: 'লিঙ্গ' },
  'pax.male':              { en: 'Male',                     bn: 'পুরুষ' },
  'pax.female':            { en: 'Female',                   bn: 'মহিলা' },
  'pax.age':               { en: 'Age',                      bn: 'বয়স' },
  'pax.forSeat':           { en: 'for seat',                 bn: 'আসনের জন্য' },
  'pax.saved':             { en: 'Saved passengers',         bn: 'সংরক্ষিত যাত্রী' },
  'pax.contactNote':       { en: 'Your ticket and any changes are sent to this number.', bn: 'টিকিট ও যেকোনো পরিবর্তনের খবর এই নম্বরে পাঠানো হবে।' },
  'pax.other':             { en: 'Other',                    bn: 'অন্যান্য' },
  'pax.details':           { en: 'Passenger details',        bn: 'যাত্রীর তথ্য' },
  'pax.contact':           { en: 'Contact',                  bn: 'যোগাযোগ' },
  'pax.useSaved':          { en: 'Use a saved passenger',    bn: 'সংরক্ষিত যাত্রী থেকে নিন' },
  'pax.enterManually':     { en: 'Enter details manually',   bn: 'নিজে লিখে দিন' },
  'pax.nameHint':          { en: 'As printed on your NID',   bn: 'এনআইডিতে যেভাবে লেখা আছে' },
  'pax.nameRequired':      { en: 'Enter a name for every passenger.', bn: 'প্রত্যেক যাত্রীর নাম লিখুন।' },
  'pax.summary':           { en: 'Trip summary',             bn: 'যাত্রার সারসংক্ষেপ' },
  'pax.toPayment':         { en: 'Continue to payment',      bn: 'পেমেন্টে যান' },
  'pax.creating':          { en: 'Creating booking…',        bn: 'বুকিং তৈরি হচ্ছে…' },
  'money.promoHint':       { en: 'Applied when your booking is created.', bn: 'বুকিং তৈরি হওয়ার সময় প্রয়োগ হবে।' },
  'money.seeOffers':       { en: 'See offers',               bn: 'অফার দেখুন' },
  'hold.chooseAgain':      { en: 'Choose seats again',       bn: 'আবার আসন বাছুন' },
  'hold.whyExpire':        {
    en: 'Seats are only held for a short time so they do not sit idle while someone else wants them. Nothing was charged.',
    bn: 'অন্য কেউ যেন আসনটি নিতে পারেন, সেজন্য অল্প সময়ের জন্যই ধরে রাখা হয়। কোনো টাকা কাটা হয়নি।',
  },

  /* ----------------------------------------------------------------- money */
  'money.fare':            { en: 'Fare',                     bn: 'ভাড়া' },
  'money.fares':           { en: 'Seat fares',               bn: 'আসনের ভাড়া' },
  'money.serviceFee':      { en: 'Service charge',           bn: 'সার্ভিস চার্জ' },
  'money.discount':        { en: 'Discount',                 bn: 'ছাড়' },
  'money.coupon':          { en: 'Coupon',                   bn: 'কুপন' },
  'money.couponApply':     { en: 'Apply',                    bn: 'প্রয়োগ করুন' },
  'money.couponPlaceholder': { en: 'Coupon code',            bn: 'কুপন কোড' },
  'money.total':           { en: 'Total payable',            bn: 'মোট দিতে হবে' },
  'money.subtotal':        { en: 'Seats',                    bn: 'আসন বাবদ' },
  /* Shown where the client genuinely does not know the fee yet. The service
     charge is set by the server when the hold is created; inventing it here is
     how the old code came to display a total that the next screen contradicted. */
  'money.feeAtNext':       {
    en: 'Any service charge and the final total are confirmed on the next step.',
    bn: 'সার্ভিস চার্জ ও চূড়ান্ত মোট টাকা পরের ধাপে দেখানো হবে।',
  },
  'money.paid':            { en: 'Paid',                     bn: 'পরিশোধিত' },
  'money.refundable':      { en: 'Refundable',               bn: 'ফেরতযোগ্য' },
  'money.breakdown':       { en: 'See fare breakdown',       bn: 'ভাড়ার হিসাব দেখুন' },

  /* --------------------------------------------------------------- payment */
  'pay.title':             { en: 'Pay for your ticket',      bn: 'টিকিটের টাকা দিন' },
  'pay.method':            { en: 'Payment method',           bn: 'যেভাবে টাকা দেবেন' },
  'pay.bkash':             { en: 'bKash',                    bn: 'বিকাশ' },
  'pay.nagad':             { en: 'Nagad',                    bn: 'নগদ' },
  'pay.card':              { en: 'Card',                     bn: 'কার্ড' },
  'pay.pay':               { en: 'Pay {amount}',             bn: '{amount} পরিশোধ করুন' },
  'pay.pending':           { en: 'Waiting for confirmation', bn: 'নিশ্চিত হওয়ার অপেক্ষায়' },
  'pay.pendingBody':       {
    en: 'We have asked {provider} to confirm your payment. This usually takes a few seconds. Do not pay again — your seats are still held.',
    bn: '{provider}-এর কাছে নিশ্চিতকরণের জন্য পাঠানো হয়েছে। সাধারণত কয়েক সেকেন্ড লাগে। আবার টাকা দেবেন না — আপনার আসন এখনো ধরে রাখা আছে।',
  },
  'pay.pendingSlow':       {
    en: 'This is taking longer than usual. Your money is safe and your seats are still held. If {provider} took the money and no ticket appears, we refund it automatically.',
    bn: 'একটু বেশি সময় লাগছে। আপনার টাকা নিরাপদ আছে এবং আসনও ধরে রাখা আছে। {provider} টাকা কেটে নিলেও টিকিট না এলে আমরা নিজে থেকেই ফেরত দিয়ে দিই।',
  },
  'pay.failed':            { en: 'Payment did not go through', bn: 'পেমেন্ট হয়নি' },
  'pay.failedBody':        { en: 'No money was taken. Your seats are still held — you can try again.', bn: 'কোনো টাকা কাটা হয়নি। আপনার আসন এখনো আছে — আবার চেষ্টা করতে পারেন।' },
  'pay.retry':             { en: 'Try again',                bn: 'আবার চেষ্টা করুন' },
  'pay.neverConfirmHere':  { en: 'We confirm your ticket only when the payment provider confirms the money. That is why this page waits.', bn: 'পেমেন্ট প্রতিষ্ঠান টাকা নিশ্চিত করলে তবেই আমরা টিকিট নিশ্চিত করি। সেজন্যই এই পাতাটি অপেক্ষা করছে।' },
  'pay.chooseHow':         { en: 'Choose how to pay',        bn: 'কীভাবে টাকা দেবেন বাছুন' },
  'pay.opening':           { en: 'Opening payment…',         bn: 'পেমেন্ট খোলা হচ্ছে…' },
  'pay.wallet':            { en: 'Mobile wallet',            bn: 'মোবাইল ওয়ালেট' },
  'pay.cardNote':          { en: 'Visa / Mastercard',        bn: 'ভিসা / মাস্টারকার্ড' },
  'pay.bankNote':          { en: 'Internet banking',         bn: 'ইন্টারনেট ব্যাংকিং' },
  'pay.forBooking':        { en: 'Pay for booking',          bn: 'বুকিংয়ের টাকা দিন' },
  'pay.alreadyDone':       { en: 'This booking is already {status}', bn: 'এই বুকিংটি ইতিমধ্যেই {status}' },
  'pay.safety':            {
    en: 'Your booking is confirmed only once your provider tells us the payment succeeded — not when this page loads. If anything goes wrong your seats are released and you are not charged.',
    bn: 'আপনার পেমেন্ট প্রতিষ্ঠান আমাদের নিশ্চিত করলে তবেই বুকিং নিশ্চিত হবে — এই পাতা খোলার সঙ্গে সঙ্গে নয়। কোনো সমস্যা হলে আসন ছেড়ে দেওয়া হবে এবং আপনার কোনো টাকা কাটা হবে না।',
  },
  'ticket.view':           { en: 'View ticket',              bn: 'টিকিট দেখুন' },
  'confirm.done':          { en: 'Booking confirmed',        bn: 'বুকিং নিশ্চিত হয়েছে' },
  'confirm.waiting':       { en: 'Confirming your payment',  bn: 'পেমেন্ট নিশ্চিত করা হচ্ছে' },
  'confirm.sentTo':        { en: 'We sent your ticket to {to}.', bn: '{to} নম্বরে আপনার টিকিট পাঠানো হয়েছে।' },
  'confirm.stillWaiting':  {
    en: 'Your provider is confirming the payment. This page updates itself — you do not need to pay again.',
    bn: 'আপনার পেমেন্ট প্রতিষ্ঠান টাকা নিশ্চিত করছে। এই পাতাটি নিজেই আপডেট হবে — আবার টাকা দেওয়ার দরকার নেই।',
  },
  'confirm.journey':       { en: 'Journey',                  bn: 'যাত্রা' },
  'confirm.trackBus':      { en: 'Track the bus',            bn: 'বাস কোথায় দেখুন' },
  'confirm.myTrips':       { en: 'My trips',                 bn: 'আমার যাত্রা' },

  /* ---------------------------------------------------------------- ticket */
  'ticket.title':          { en: 'Your ticket',              bn: 'আপনার টিকিট' },
  'ticket.pnr':            { en: 'Booking code',             bn: 'বুকিং কোড' },
  'ticket.showAtGate':     { en: 'Show this to the counter or the bus helper', bn: 'কাউন্টারে বা বাসের হেলপারকে এটি দেখান' },
  'ticket.seat':           { en: 'Seat',                     bn: 'আসন' },
  'ticket.seats':          { en: 'Seats',                    bn: 'আসন' },
  'ticket.download':       { en: 'Download',                 bn: 'ডাউনলোড' },
  'ticket.print':          { en: 'Print',                    bn: 'প্রিন্ট' },
  'ticket.share':          { en: 'Share',                    bn: 'শেয়ার' },
  'ticket.confirmed':      { en: 'Confirmed',                bn: 'নিশ্চিত হয়েছে' },
  'ticket.arriveEarly':    { en: 'Please reach the counter 30 minutes before departure.', bn: 'ছাড়ার ৩০ মিনিট আগে কাউন্টারে পৌঁছান।' },
  'ticket.bookingRef':     { en: 'Booking reference',        bn: 'বুকিং রেফারেন্স' },
  'ticket.from':           { en: 'From',                     bn: 'যেখান থেকে' },
  'ticket.to':             { en: 'To',                       bn: 'যেখানে' },
  'ticket.bus':            { en: 'Bus',                      bn: 'বাস' },
  'ticket.status':         { en: 'Status',                   bn: 'অবস্থা' },
  'ticket.booked':         { en: 'Booked',                   bn: 'বুক করা হয়েছে' },
  'ticket.passenger':      { en: 'Passenger',                bn: 'যাত্রী' },
  'ticket.code':           { en: 'Code',                     bn: 'কোড' },
  'ticket.perPassenger':   { en: 'One code per passenger — each seat scans separately.', bn: 'প্রত্যেক যাত্রীর জন্য আলাদা কোড — প্রতিটি আসন আলাদাভাবে স্ক্যান হবে।' },
  'ticket.separateQr':     { en: 'Show a separate QR for each passenger', bn: 'প্রত্যেক যাত্রীর আলাদা QR দেখান' },
  'ticket.issuedOnPay':    { en: 'Issued once payment clears', bn: 'পেমেন্ট নিশ্চিত হলে দেওয়া হবে' },
  'ticket.wontScan':       { en: 'This booking is {status}. The codes below will not scan at boarding.', bn: 'এই বুকিংটি {status}। নিচের কোডগুলো বাসে ওঠার সময় স্ক্যান হবে না।' },
  'ticket.manage':         { en: 'Manage',                   bn: 'পরিবর্তন করুন' },
  'ticket.track':          { en: 'Track',                    bn: 'কোথায় আছে' },
  'ticket.copied':         { en: 'Copied',                   bn: 'কপি হয়েছে' },
  'ticket.copyFailed':     { en: 'Could not copy',           bn: 'কপি করা যায়নি' },

  /* ----------------------------------------------------------- post-booking */
  'manage.title':          { en: 'Find your booking',        bn: 'আপনার বুকিং খুঁজুন' },
  'manage.byPnr':          { en: 'Booking code',             bn: 'বুকিং কোড' },
  'manage.byPhone':        { en: 'Mobile number',            bn: 'মোবাইল নম্বর' },
  'manage.find':           { en: 'Find booking',             bn: 'বুকিং খুঁজুন' },
  'manage.upcoming':       { en: 'Upcoming trips',           bn: 'আসন্ন যাত্রা' },
  'manage.past':           { en: 'Past trips',               bn: 'আগের যাত্রা' },
  'cancel.title':          { en: 'Cancel this booking',      bn: 'বুকিং বাতিল করুন' },
  'cancel.action':         { en: 'Cancel booking',           bn: 'বুকিং বাতিল করুন' },
  'cancel.youGetBack':     { en: 'You get back',             bn: 'আপনি ফেরত পাবেন' },
  'cancel.charge':         { en: 'Cancellation charge',      bn: 'বাতিলের চার্জ' },
  'cancel.confirm':        { en: 'Yes, cancel it',           bn: 'হ্যাঁ, বাতিল করুন' },
  'cancel.keep':           { en: 'Keep my booking',          bn: 'বুকিং রেখে দিন' },
  'cancel.irreversible':   { en: 'This cannot be undone and the seats go back on sale immediately.', bn: 'এটি আর ফেরানো যাবে না এবং আসনগুলো সঙ্গে সঙ্গে বিক্রির জন্য খুলে যাবে।' },
  'refund.title':          { en: 'Refund',                   bn: 'টাকা ফেরত' },
  'refund.status':         { en: 'Refund status',            bn: 'ফেরতের অবস্থা' },
  'refund.toProvider':     { en: 'Going back to your {provider} account', bn: 'আপনার {provider} অ্যাকাউন্টে ফেরত যাচ্ছে' },
  'reschedule.title':      { en: 'Change your trip',         bn: 'যাত্রা পরিবর্তন করুন' },
  'reschedule.payDiff':    { en: 'You pay the difference',   bn: 'পার্থক্যের টাকা দিতে হবে' },
  'reschedule.getBack':    { en: 'You get the difference back', bn: 'পার্থক্যের টাকা ফেরত পাবেন' },
  'reschedule.action':     { en: 'Confirm the change',       bn: 'পরিবর্তন নিশ্চিত করুন' },

  /* -------------------------------------------------------------- tracking */
  'track.title':           { en: 'Where is my bus',          bn: 'বাস কোথায়' },
  'track.onTime':          { en: 'On time',                  bn: 'সময়মতো' },
  'track.delayed':         { en: 'Running late',             bn: 'দেরি হচ্ছে' },
  'track.arriving':        { en: 'Arriving',                 bn: 'পৌঁছাচ্ছে' },
  'track.nextStop':        { en: 'Next stop',                bn: 'পরের স্টপ' },
  'track.noSignal':        { en: 'No location from this bus right now', bn: 'এই বাস থেকে এখন অবস্থান পাওয়া যাচ্ছে না' },

  /* --------------------------------------------------------------- account */
  'account.title':         { en: 'My account',               bn: 'আমার অ্যাকাউন্ট' },
  'account.trips':         { en: 'Trips',                    bn: 'যাত্রা' },
  'account.passengers':    { en: 'Passengers',               bn: 'যাত্রী' },
  'account.refunds':       { en: 'Refunds',                  bn: 'ফেরত' },
  'account.referral':      { en: 'Refer a friend',           bn: 'বন্ধুকে আনুন' },
  'account.devices':       { en: 'Devices',                  bn: 'ডিভাইস' },
  'account.profile':       { en: 'Profile',                  bn: 'প্রোফাইল' },
  'account.langLabel':     { en: 'Language',                 bn: 'ভাষা' },
  'account.langHelp':      { en: 'Used for this website and for your ticket, cancellation and refund messages.', bn: 'এই ওয়েবসাইট এবং আপনার টিকিট, বাতিল ও ফেরতের বার্তার জন্য ব্যবহার হবে।' },

  /* ------------------------------------------------------------- sign-in */
  'auth.title':            { en: 'Sign in',                  bn: 'সাইন ইন করুন' },
  'auth.phone':            { en: 'Mobile number',            bn: 'মোবাইল নম্বর' },
  'auth.sendCode':         { en: 'Send me a code',           bn: 'কোড পাঠান' },
  'auth.code':             { en: 'Six-digit code',           bn: 'ছয় অঙ্কের কোড' },
  'auth.codeSent':         { en: 'We sent a code to {phone}', bn: '{phone} নম্বরে কোড পাঠানো হয়েছে' },
  'auth.verify':           { en: 'Sign in',                  bn: 'সাইন ইন' },
  'auth.resend':           { en: 'Send again',               bn: 'আবার পাঠান' },
  'auth.guestNote':        { en: 'You can book without an account. Sign in later to keep your tickets in one place.', bn: 'অ্যাকাউন্ট ছাড়াই টিকিট কাটতে পারেন। পরে সাইন ইন করলে সব টিকিট এক জায়গায় থাকবে।' },

  /* ---------------------------------------------------------------- common */
  'common.continue':       { en: 'Continue',                 bn: 'পরবর্তী ধাপ' },
  'common.back':           { en: 'Back',                     bn: 'ফিরে যান' },
  'common.close':          { en: 'Close',                    bn: 'বন্ধ করুন' },
  'common.save':           { en: 'Save',                     bn: 'সংরক্ষণ করুন' },
  'common.saving':         { en: 'Saving…',                  bn: 'সংরক্ষণ হচ্ছে…' },
  'common.saved':          { en: 'Saved',                    bn: 'সংরক্ষিত হয়েছে' },
  'common.loading':        { en: 'Loading…',                 bn: 'আসছে…' },
  'common.retry':          { en: 'Try again',                bn: 'আবার চেষ্টা করুন' },
  'common.today':          { en: 'Today',                    bn: 'আজ' },
  'common.tomorrow':       { en: 'Tomorrow',                 bn: 'আগামীকাল' },
  'common.yesterday':      { en: 'Yesterday',                bn: 'গতকাল' },
  'common.optional':       { en: 'optional',                 bn: 'ঐচ্ছিক' },
  'common.required':       { en: 'required',                 bn: 'আবশ্যক' },
  'common.of':             { en: 'of',                       bn: 'এর' },
  'common.step':           { en: 'Step',                     bn: 'ধাপ' },
  'common.status':         { en: 'Status',                   bn: 'অবস্থা' },

  /* ----------------------------------------------------------------- steps */
  'step.search':           { en: 'Search',                   bn: 'খোঁজা' },
  'step.seats':            { en: 'Seats',                    bn: 'আসন' },
  'step.passengers':       { en: 'Passengers',               bn: 'যাত্রী' },
  'step.payment':          { en: 'Payment',                  bn: 'পেমেন্ট' },
  'step.ticket':           { en: 'Ticket',                   bn: 'টিকিট' },

  /* ---------------------------------------------------------------- errors */
  'err.network':           { en: 'We could not reach the service. Check your connection.', bn: 'সার্ভারে পৌঁছানো যায়নি। ইন্টারনেট সংযোগ দেখুন।' },
  'err.generic':           { en: 'Something went wrong.',    bn: 'কিছু একটা ভুল হয়েছে।' },
  'err.seatGone':          { en: 'Someone took that seat a moment before you', bn: 'আপনার একটু আগেই কেউ আসনটি নিয়ে নিয়েছেন' },
  'err.seatGoneHint':      { en: 'Nothing was charged. Please pick another seat.', bn: 'কোনো টাকা কাটা হয়নি। অন্য আসন বাছুন।' },
  'err.sessionExpired':    { en: 'You were signed out',      bn: 'আপনি সাইন আউট হয়ে গেছেন' },
  'err.notFound':          { en: 'We could not find that booking', bn: 'বুকিংটি খুঁজে পাওয়া যায়নি' },

  /* -------------------------------------------------- statuses (passenger) */
  'status.CREATED':          { en: 'Not paid yet',           bn: 'এখনো টাকা দেওয়া হয়নি' },
  'status.PAYMENT_PENDING':  { en: 'Waiting for payment',    bn: 'পেমেন্টের অপেক্ষায়' },
  'status.CONFIRMED':        { en: 'Confirmed',              bn: 'নিশ্চিত হয়েছে' },
  'status.TICKETED':         { en: 'Ticket issued',          bn: 'টিকিট হয়ে গেছে' },
  'status.COMPLETED':        { en: 'Journey complete',       bn: 'যাত্রা শেষ' },
  'status.CANCELLED':        { en: 'Cancelled',              bn: 'বাতিল হয়েছে' },
  'status.EXPIRED':          { en: 'Expired',                bn: 'সময় শেষ' },
  'status.FAILED':           { en: 'Failed',                 bn: 'ব্যর্থ হয়েছে' },
  'status.REFUND_PENDING':   { en: 'Refund on the way',      bn: 'টাকা ফেরত আসছে' },
  'status.REFUNDED':         { en: 'Refunded',               bn: 'টাকা ফেরত দেওয়া হয়েছে' },
  'status.PARTIALLY_REFUNDED': { en: 'Partly refunded',      bn: 'আংশিক ফেরত দেওয়া হয়েছে' },

  /*
   * A booking is not the only thing with a status, and this block used to
   * pretend otherwise. StatusPill falls back to the server's own wording for
   * anything it does not carry — deliberately, so an unknown state is shown
   * rather than swallowed — which meant the ticket table, the refund panel and
   * the referral list quietly printed English on the Bangla site. The fallback
   * was doing its job; the catalogue was short.
   *
   * A ticket's own state, distinct from the booking's. CANCELLED and EXPIRED
   * above cover the rest of the QR lifecycle.
   */
  'status.VALID':            { en: 'Valid',                  bn: 'বৈধ' },
  'status.BOARDED':          { en: 'Boarded',                bn: 'বাসে উঠেছেন' },
  'status.USED':             { en: 'Already used',           bn: 'ব্যবহার হয়ে গেছে' },

  /* A refund moving through its own lifecycle. */
  'status.REQUESTED':        { en: 'Requested',              bn: 'অনুরোধ করা হয়েছে' },
  'status.APPROVED':         { en: 'Approved',               bn: 'অনুমোদিত' },
  'status.PROCESSING':       { en: 'On its way',             bn: 'পাঠানো হচ্ছে' },
  'status.SUCCESS':          { en: 'Money returned',         bn: 'টাকা ফেরত হয়েছে' },
  'status.REJECTED':         { en: 'Not approved',           bn: 'অনুমোদন হয়নি' },

  /* An invitation. */
  'status.INVITED':          { en: 'Invited',                bn: 'আমন্ত্রণ পাঠানো হয়েছে' },
  'status.QUALIFIED':        { en: 'They have travelled',    bn: 'তিনি ভ্রমণ করেছেন' },
  'status.REWARDED':         { en: 'Reward given',           bn: 'পুরস্কার দেওয়া হয়েছে' },

  /* ------------------------------------------------------------ seat types */
  'seatType.NORMAL':          { en: 'Standard',              bn: 'সাধারণ' },
  'seatType.BUSINESS':        { en: 'Business',              bn: 'বিজনেস' },
  'seatType.SLEEPER':         { en: 'Sleeper berth',         bn: 'স্লিপার' },
  'seatType.PREMIUM':         { en: 'Premium',               bn: 'প্রিমিয়াম' },
  'seatType.FEMALE_RESERVED': { en: 'Reserved for women',    bn: 'মহিলাদের জন্য সংরক্ষিত' },
  'seatType.ACCESSIBLE':      { en: 'Accessible',            bn: 'প্রতিবন্ধী-বান্ধব' },
  'seatType.BLOCKED':         { en: 'Not for sale',          bn: 'বিক্রির জন্য নয়' },
  'seatType.CREW':            { en: 'Crew',                  bn: 'স্টাফ' },

  /* ------------------------------------------------------- find my booking */
  /*
   * "PNR" is aviation jargon that arrived here by way of the systems these
   * platforms were copied from. A passenger holds a piece of paper with six
   * characters on it; they call that the ticket number, so the interface does
   * too. The literal letters PNR still appear once, in small text, because that
   * is the word printed on the ticket itself and on the SMS.
   */
  'find.title':            { en: 'Find your booking',        bn: 'আপনার টিকিট খুঁজুন' },
  'find.lead':             { en: 'See your ticket, track the bus, change the time or cancel — using the number on your ticket.',
                             bn: 'টিকিট দেখুন, বাস কোথায় আছে জানুন, সময় বদলান বা বাতিল করুন — টিকিটে লেখা নম্বর দিয়ে।' },
  'find.label':            { en: 'Ticket number',            bn: 'টিকিট নম্বর' },
  'find.hint':             { en: 'Six letters and numbers — printed at the top of your ticket and in the confirmation SMS. It is also called the PNR.',
                             bn: 'ছয়টি অক্ষর ও সংখ্যা — টিকিটের উপরে এবং কনফার্মেশন SMS-এ লেখা আছে। একে PNR-ও বলা হয়।' },
  'find.action':           { en: 'Show my booking',          bn: 'আমার টিকিট দেখান' },
  'find.working':          { en: 'Looking…',                 bn: 'খোঁজা হচ্ছে…' },
  'find.orSignIn':         { en: 'Lost the number?',         bn: 'নম্বরটি হারিয়ে ফেলেছেন?' },
  'find.orSignInBody':     { en: 'Sign in with the mobile number you booked on and every trip on that number appears together.',
                             bn: 'যে মোবাইল নম্বর দিয়ে বুক করেছিলেন সেটি দিয়ে ঢুকুন — ওই নম্বরের সব যাত্রা একসাথে দেখতে পাবেন।' },
  'find.signIn':           { en: 'Sign in with my number',   bn: 'মোবাইল নম্বর দিয়ে ঢুকুন' },

  /* ------------------------------------------------------------ my booking */
  'mb.title':              { en: 'Your booking',             bn: 'আপনার বুকিং' },
  'mb.trip':               { en: 'Your trip',                bn: 'আপনার যাত্রা' },
  'mb.viewTicket':         { en: 'Ticket & QR',              bn: 'টিকিট ও QR' },
  'mb.track':              { en: 'Where is the bus?',        bn: 'বাস কোথায়?' },
  'mb.change':             { en: 'Change the time',          bn: 'সময় বদলান' },
  'mb.viewTicketNote':     { en: 'Show this at the door',    bn: 'বাসে ওঠার সময় দেখাবেন' },
  'mb.trackNote':          { en: 'Live position and stops',  bn: 'বাস কোথায়, কোন স্টপে' },
  'mb.changeNote':         { en: 'Move to another departure', bn: 'অন্য সময়ের বাসে যান' },
  'mb.passengers':         { en: 'Passengers',               bn: 'যাত্রী' },
  'mb.contact':            { en: 'Contact',                  bn: 'যোগাযোগ' },
  'mb.paid':               { en: 'Paid',                     bn: 'পরিশোধিত' },
  'mb.bus':                { en: 'Bus',                      bn: 'বাস' },
  // "Choose your seats" is the funnel's instruction. On a booking that is
  // already paid for it is a label for a fact, so it names the fact.
  'mb.seats':              { en: 'Seats',                    bn: 'আসন' },
  'mb.refund':             { en: 'Your refund',              bn: 'আপনার ফেরত' },
  'mb.refundWait':         { en: 'Your provider normally returns this within 3–7 working days.',
                             bn: 'সাধারণত 3–7 কর্মদিবসের মধ্যে আপনার প্রোভাইডার টাকা ফেরত দেয়।' },
  'mb.settleDemo':         { en: 'Simulate provider settlement',
                             bn: 'প্রোভাইডারের নিষ্পত্তি সিমুলেট করুন' },
  'mb.cancelled':          { en: 'This booking is cancelled.', bn: 'এই বুকিংটি বাতিল করা হয়েছে।' },
  'mb.refundOnWay':        { en: '{amount} is on its way back to you.',
                             bn: '{amount} আপনার কাছে ফেরত যাচ্ছে।' },
  'mb.noRefundDue':        { en: 'No refund is due at this point before departure.',
                             bn: 'ছাড়ার এত কাছাকাছি সময়ে কোনো টাকা ফেরত পাওয়া যায় না।' },

  /* ---------------------------------------------------------- cancellation */
  'cx.title':              { en: 'Cancel this booking',      bn: 'বুকিং বাতিল করুন' },
  'cx.youGetBack':         { en: 'You would get back',       bn: 'আপনি ফেরত পাবেন' },
  'cx.ofWhatYouPaid':      { en: '{pct}% of the {total} you paid',
                             bn: 'আপনার দেওয়া {total} টাকার {pct}%' },
  'cx.charge':             { en: '{amount} cancellation charge is kept',
                             bn: '{amount} বাতিল ফি কেটে রাখা হবে' },
  'cx.hoursLeft':          { en: 'about {hours} hours before departure',
                             bn: 'ছাড়ার প্রায় {hours} ঘণ্টা আগে' },
  'cx.start':              { en: 'Cancel booking',           bn: 'বুকিং বাতিল করুন' },
  'cx.confirmQ':           { en: 'Cancel this booking for good?',
                             bn: 'বুকিংটি একেবারে বাতিল করবেন?' },
  'cx.confirmBody':        { en: 'Your seats go back on sale straight away and this cannot be undone.',
                             bn: 'আপনার আসনগুলো সঙ্গে সঙ্গে আবার বিক্রি হতে শুরু করবে, এবং এটি আর ফেরানো যাবে না।' },
  'cx.keep':               { en: 'Keep my booking',          bn: 'বুকিং রাখব' },
  'cx.confirm':            { en: 'Yes, cancel it',           bn: 'হ্যাঁ, বাতিল করুন' },
  'cx.working':            { en: 'Cancelling…',              bn: 'বাতিল করা হচ্ছে…' },
  'cx.ladder':             { en: 'How much comes back, by when you cancel',
                             bn: 'কখন বাতিল করলে কত ফেরত' },
  'cx.youAreHere':         { en: 'You are here now',         bn: 'আপনি এখন এখানে' },
  'cx.tier24':             { en: '24 hours or more before',  bn: '24 ঘণ্টা বা তার বেশি আগে' },
  'cx.tier12':             { en: '12 to 24 hours before',    bn: '12 থেকে 24 ঘণ্টা আগে' },
  'cx.tier6':              { en: '6 to 12 hours before',     bn: '6 থেকে 12 ঘণ্টা আগে' },
  'cx.tier0':              { en: 'Under 6 hours before',     bn: '6 ঘণ্টার কম আগে' },
  'cx.nothing':            { en: 'Nothing',                  bn: 'কিছুই না' },
  'cx.notPossible':        { en: 'This booking can no longer be cancelled.',
                             bn: 'এই বুকিংটি আর বাতিল করা যাবে না।' },

  /* ------------------------------------------------------------ reschedule */
  'rs.title':              { en: 'Change the time',          bn: 'সময় বদলান' },
  'rs.lead':               { en: 'Pick another departure on the same route, then pick your seats on that bus.',
                             bn: 'একই রুটে অন্য একটি বাস বেছে নিন, তারপর সেই বাসে আসন বেছে নিন।' },
  'rs.safe':               { en: 'Your current seats stay yours until the new ones are confirmed. If anything goes wrong part-way, your original ticket is left exactly as it is.',
                             bn: 'নতুন আসন নিশ্চিত না হওয়া পর্যন্ত আপনার এখনকার আসন আপনারই থাকবে। মাঝপথে কিছু ভুল হলে আপনার পুরোনো টিকিট যেমন ছিল তেমনই থাকবে।' },
  'rs.step1':              { en: 'Choose a departure',       bn: 'একটি বাস বেছে নিন' },
  'rs.step2one':           { en: 'Choose your seat on that bus',
                             bn: 'সেই বাসে আসন বেছে নিন' },
  'rs.step2':              { en: 'Choose {count} seats on that bus',
                             bn: 'সেই বাসে {count}টি আসন বেছে নিন' },
  'rs.none':               { en: 'There are no other departures on this route right now.',
                             bn: 'এই রুটে এখন আর কোনো বাস নেই।' },
  'rs.full':               { en: 'Not enough seats',         bn: 'যথেষ্ট আসন নেই' },
  'rs.seatsFree':          { en: '{count} seats free',       bn: '{count}টি আসন খালি' },
  'rs.paid':               { en: 'You already paid',         bn: 'আপনি আগে দিয়েছেন' },
  'rs.newFare':            { en: 'The new trip costs',       bn: 'নতুন যাত্রার খরচ' },
  'rs.toPay':              { en: 'You pay the difference',   bn: 'আপনাকে বাড়তি দিতে হবে' },
  'rs.backToYou':          { en: 'Comes back to you',        bn: 'আপনি ফেরত পাবেন' },
  'rs.noDifference':       { en: 'Nothing more to pay',      bn: 'বাড়তি কিছু দিতে হবে না' },
  // The short form, for the right-hand column of a row where the long one wraps
  // to three lines and buries the fare it sits beside.
  'rs.samePrice':          { en: 'Same price',               bn: 'একই দাম' },
  'rs.confirm':            { en: 'Confirm the change',       bn: 'পরিবর্তন নিশ্চিত করুন' },
  'rs.working':            { en: 'Moving your booking…',     bn: 'বুকিং সরানো হচ্ছে…' },
  'rs.keep':               { en: 'Keep my current trip',     bn: 'আগের যাত্রাই রাখব' },
  'rs.pickFirst':          { en: 'Choose a departure to see the difference',
                             bn: 'পার্থক্য দেখতে একটি বাস বেছে নিন' },

  /* -------------------------------------------------------------- tracking */
  'tr.title':              { en: 'Where is my bus?',         bn: 'আমার বাস কোথায়?' },
  /*
   * Provenance, keyed off the SOURCE the server reports rather than the
   * sentence it writes. The API sends both: `source` is a stable machine value
   * and `source_note` is English prose for it. Printing the prose put an
   * English sentence in the middle of the Bangla page — and it always would
   * have, because a server has no idea who is reading. It stays as the fallback
   * for a source we do not recognise, on the same principle as an unknown
   * status: better the server's words than none.
   */
  'tr.estimated':          { en: 'Estimated from the timetable',
                             bn: 'সময়সূচি থেকে হিসাব করা' },
  'tr.src.SIMULATED_FROM_SCHEDULE':
                           { en: 'No GPS has been reported for this bus, so its position is worked out from the timetable.',
                             bn: 'এই বাসের কোনো GPS তথ্য আসেনি, তাই সময়সূচি থেকে হিসাব করে অবস্থান দেখানো হচ্ছে।' },
  'tr.src.DRIVER_APP_GPS': { en: 'Reported by the driver’s app.',
                             bn: 'চালকের অ্যাপ থেকে পাঠানো।' },
  'tr.live':               { en: 'Live from the driver’s app',
                             bn: 'চালকের অ্যাপ থেকে সরাসরি' },
  // Two labels for one field, because a bus that has not moved yet did not
  // "leave at" anything. The page was pairing "Left at 08:30" with a status
  // pill reading "Not started yet", two feet apart, and expecting a passenger
  // to work out which one to believe.
  'tr.departed':           { en: 'Left at',                  bn: 'ছেড়েছে' },
  'tr.departs':            { en: 'Leaves at',                bn: 'ছাড়বে' },
  'tr.arriving':           { en: 'Reaches around',           bn: 'পৌঁছাবে প্রায়' },
  'tr.nextStop':           { en: 'Next stop',                bn: 'পরের স্টপ' },
  'tr.around':             { en: 'around {time}',            bn: 'প্রায় {time}' },
  'tr.stops':              { en: 'Stops along the way',      bn: 'পথের স্টপগুলো' },
  'tr.passed':             { en: 'passed',                   bn: 'পার হয়েছে' },
  'tr.progress':           { en: '{pct}% of the way',        bn: 'পথের {pct}% শেষ' },
  'tr.state.SCHEDULED':    { en: 'Not started yet',          bn: 'এখনো ছাড়েনি' },
  'tr.state.OPEN':         { en: 'Not started yet',          bn: 'এখনো ছাড়েনি' },
  'tr.state.BOARDING':     { en: 'Boarding now',             bn: 'যাত্রী উঠছে' },
  'tr.state.DEPARTED':     { en: 'On the road',              bn: 'পথে আছে' },
  'tr.state.IN_PROGRESS':  { en: 'On the road',              bn: 'পথে আছে' },
  'tr.state.ARRIVED':      { en: 'Arrived',                  bn: 'পৌঁছে গেছে' },
  'tr.state.COMPLETED':    { en: 'Trip finished',            bn: 'যাত্রা শেষ' },
  'tr.state.CANCELLED':    { en: 'Trip cancelled',           bn: 'যাত্রা বাতিল' },

  /* --------------------------------------------------------------- account */
  'ac.title':              { en: 'My trips',                 bn: 'আমার যাত্রা' },
  'ac.signedInAs':         { en: 'Signed in as {phone}',     bn: '{phone} দিয়ে ঢুকেছেন' },
  'ac.signOut':            { en: 'Sign out',                 bn: 'বেরিয়ে যান' },
  'ac.signOutAll':         { en: 'Sign out on every device',  bn: 'সব ডিভাইস থেকে বেরিয়ে যান' },
  'ac.tab.upcoming':       { en: 'Coming up',                bn: 'সামনের যাত্রা' },
  'ac.tab.past':           { en: 'Finished',                 bn: 'শেষ হওয়া যাত্রা' },
  'ac.tab.passengers':     { en: 'Saved passengers',         bn: 'সংরক্ষিত যাত্রী' },
  'ac.tab.referrals':      { en: 'Invite a friend',          bn: 'বন্ধুকে আনুন' },
  'ac.tab.devices':        { en: 'Where you are signed in',  bn: 'কোথায় ঢুকে আছেন' },
  'ac.tab.profile':        { en: 'My details',               bn: 'আমার তথ্য' },
  'ac.signInTitle':        { en: 'Sign in to see your trips', bn: 'যাত্রা দেখতে ঢুকুন' },
  'ac.signInBody':         { en: 'Your bookings sit against your mobile number. Sign in with a one-time code and anything you already booked on that number shows up here.',
                             bn: 'আপনার বুকিংগুলো আপনার মোবাইল নম্বরের সাথে যুক্ত। এক-বারের কোড দিয়ে ঢুকলে ওই নম্বরে করা সব বুকিং এখানে দেখা যাবে।' },
  'ac.noUpcoming':         { en: 'No trips coming up',       bn: 'সামনে কোনো যাত্রা নেই' },
  'ac.noPast':             { en: 'No finished trips yet',    bn: 'এখনো কোনো যাত্রা শেষ হয়নি' },
  'ac.findBus':            { en: 'Find a bus',               bn: 'বাস খুঁজুন' },
  'ac.noPassengers':       { en: 'No saved passengers yet',  bn: 'এখনো কোনো যাত্রী সংরক্ষণ করা হয়নি' },
  'ac.passengersBody':     { en: 'Names you enter at checkout are kept here so you do not have to type them again.',
                             bn: 'চেকআউটে দেওয়া নামগুলো এখানে জমা থাকে, যাতে বারবার টাইপ করতে না হয়।' },
  // Bangla marks no plural on a counted noun, so both forms are identical there
  // and only English needs the pair. "seat(s)" is a parenthesis asking the
  // reader to do the grammar, and it reads as unfinished software.
  'ac.seat1':              { en: '1 seat',                   bn: '1টি আসন' },
  'ac.seatsN':             { en: '{count} seats',            bn: '{count}টি আসন' },
  'ac.ticket':             { en: 'Ticket',                   bn: 'টিকিট' },
  'ac.manage':             { en: 'Manage',                   bn: 'পরিচালনা' },
  'ac.inviteCode':         { en: 'Your invite code',         bn: 'আপনার আমন্ত্রণ কোড' },
  'ac.inviteBody':         { en: 'Share it. When a friend signs up with it and takes their first paid trip, {amount} comes off your next ticket.',
                             bn: 'কোডটি শেয়ার করুন। কেউ এটি দিয়ে যোগ দিয়ে প্রথম টিকিট কিনলে আপনার পরের টিকিটে {amount} ছাড় পাবেন।' },
  'ac.inviteShare':        { en: 'Share code',               bn: 'কোড শেয়ার করুন' },
  'ac.inviteHistory':      { en: 'Friends you invited',      bn: 'আপনি যাদের এনেছেন' },
  'ac.devicesBody':        { en: 'Each sign-in is listed here. Signing out everywhere also stops a phone you no longer have from quietly renewing itself.',
                             bn: 'প্রতিবার ঢোকার হিসাব এখানে থাকে। সব জায়গা থেকে বেরিয়ে গেলে হারানো ফোনটিও আর নিজে নিজে ঢুকতে পারবে না।' },
  'ac.thisDevice':         { en: 'This device',              bn: 'এই ডিভাইস' },
  'ac.lastUsed':           { en: 'Last used {when}',         bn: 'শেষ ব্যবহার {when}' },
  'ac.name':               { en: 'Your name',                bn: 'আপনার নাম' },
  'ac.email':              { en: 'Email (optional)',         bn: 'ইমেইল (ইচ্ছা হলে)' },
  'ac.mobile':             { en: 'Mobile number',            bn: 'মোবাইল নম্বর' },
  'ac.msgLang':            { en: 'Language for SMS and email',
                             bn: 'SMS ও ইমেইলের ভাষা' },
  'ac.msgLangNote':        { en: 'Your ticket, cancellation and refund messages are sent in this language.',
                             bn: 'আপনার টিকিট, বাতিল ও ফেরতের বার্তা এই ভাষায় পাঠানো হবে।' },
  'ac.save':               { en: 'Save my details',          bn: 'তথ্য সংরক্ষণ করুন' },
  'ac.saving':             { en: 'Saving…',                  bn: 'সংরক্ষণ হচ্ছে…' },
  'ac.saved':              { en: 'Saved.',                   bn: 'সংরক্ষণ হয়েছে।' },

  /* ---------------------------------------------------------------- offers */
  'of.title':              { en: 'Offers',                   bn: 'অফার' },
  'of.lead':               { en: 'Type one of these codes in the Coupon box at checkout. One code per booking.',
                             bn: 'চেকআউটের কুপন ঘরে এই কোডগুলোর যেকোনো একটি লিখুন। প্রতি বুকিংয়ে একটি কোড।' },
  'of.none':               { en: 'No offers are running right now',
                             bn: 'এখন কোনো অফার চলছে না' },
  'of.pctOff':             { en: '{pct}% off',               bn: '{pct}% ছাড়' },
  'of.amountOff':          { en: '{amount} off',             bn: '{amount} ছাড়' },
  'of.endsOn':             { en: 'Ends {date}',              bn: '{date} পর্যন্ত' },
  'of.minSpend':           { en: 'On bookings over {amount}', bn: '{amount}-এর বেশি বুকিংয়ে' },
  'of.maxOff':             { en: 'Up to {amount} off',       bn: 'সর্বোচ্চ {amount} ছাড়' },
  'of.oneUse':             { en: 'Once per passenger',       bn: 'প্রতি যাত্রী একবার' },
  'of.copy':               { en: 'Copy code',                bn: 'কোড কপি করুন' },
  'of.copied':             { en: 'Copied',                   bn: 'কপি হয়েছে' },

  /* --------------------------------------------------------------- support */
  'sp.title':              { en: 'Help',                     bn: 'সহায়তা' },
  'sp.lead':               { en: 'The things people ask most, and how to reach a person.',
                             bn: 'যে প্রশ্নগুলো সবচেয়ে বেশি আসে, আর কীভাবে আমাদের সাথে কথা বলবেন।' },
  'sp.selfServe':          { en: 'Do it yourself',           bn: 'নিজেই করুন' },
  'sp.selfServeBody':      { en: 'Cancelling, changing the time, seeing your ticket again — all of it takes about a minute with your ticket number.',
                             bn: 'বাতিল করা, সময় বদলানো, টিকিট আবার দেখা — টিকিট নম্বর থাকলে সবই এক মিনিটের কাজ।' },
  'sp.talk':               { en: 'Talk to a person',         bn: 'একজন মানুষের সাথে কথা বলুন' },
  'sp.hotline':            { en: 'Hotline',                  bn: 'হটলাইন' },
  'sp.whatsapp':           { en: 'WhatsApp',                 bn: 'হোয়াটসঅ্যাপ' },
  'sp.emailUs':            { en: 'Email',                    bn: 'ইমেইল' },
  'sp.hours':              { en: 'Open',                     bn: 'খোলা' },
  'sp.allDay':             { en: '24 hours, every day',      bn: 'প্রতিদিন 24 ঘণ্টা' },
  'sp.havePnr':            { en: 'Have your ticket number ready — it is the quickest way for us to find your trip.',
                             bn: 'টিকিট নম্বরটি হাতে রাখুন — এতে আমরা দ্রুত আপনার যাত্রা খুঁজে পাই।' },
  'sp.busGone':            { en: 'Bus already left?',        bn: 'বাস ছেড়ে গেছে?' },
  'sp.busGoneBody':        { en: 'Call the hotline rather than emailing. We can reach the operator’s dispatcher while the bus is still running.',
                             bn: 'ইমেইল না করে হটলাইনে ফোন করুন। বাস চলতে থাকা অবস্থাতেই আমরা পরিবহনের ডিসপ্যাচারের সাথে কথা বলতে পারি।' },

  'faq.q.hold':            { en: 'Someone took my seat while I was paying. What happened?',
                             bn: 'টাকা দেওয়ার সময় আমার আসনটি অন্য কেউ নিয়ে নিল। কী হলো?' },
  'faq.a.hold':            { en: 'Seats are held for you for a few minutes from the moment you press Continue — the exact deadline is the countdown on your screen. If it runs out before payment clears, the seat goes back on sale automatically. Nothing is charged for an expired hold; pick your seats again and the money never left your account.',
                             bn: 'কন্টিনিউ চাপার পর কয়েক মিনিটের জন্য আসন আপনার নামে রাখা হয় — সঠিক সময়টি স্ক্রিনে কাউন্টডাউনে দেখা যায়। টাকা পৌঁছানোর আগেই সময় শেষ হলে আসনটি আবার বিক্রির জন্য খুলে যায়। সময় শেষ হওয়া হোল্ডে কোনো টাকা কাটা হয় না; আবার আসন বেছে নিন, আপনার টাকা কোথাও যায়নি।' },
  'faq.q.paidNoPage':      { en: 'I paid but the page did not load. Am I booked?',
                             bn: 'টাকা দিয়েছি কিন্তু পেজটি খোলেনি। টিকিট কি হয়েছে?' },
  'faq.a.paidNoPage':      { en: 'Almost certainly yes. Your booking is confirmed by your payment provider telling us directly, not by the page loading on your phone. Look your ticket number up under Find your booking, or wait for the confirmation SMS. If you were charged and still have no ticket after 15 minutes, call us and we will trace it.',
                             bn: 'প্রায় নিশ্চিতভাবেই হয়েছে। আপনার বুকিং নিশ্চিত হয় পেমেন্ট প্রোভাইডার সরাসরি আমাদের জানালে — আপনার ফোনে পেজ খোলার উপর তা নির্ভর করে না। “আপনার টিকিট খুঁজুন”-এ নম্বর দিয়ে দেখুন, অথবা কনফার্মেশন SMS-এর জন্য অপেক্ষা করুন। টাকা কাটার 15 মিনিট পরেও টিকিট না পেলে ফোন করুন, আমরা খুঁজে বের করব।' },
  'faq.q.partRoute':       { en: 'Can I buy a seat for only part of the route?',
                             bn: 'রুটের একটি অংশের জন্য কি আসন কেনা যায়?' },
  'faq.a.partRoute':       { en: 'Yes. On a route like Dhaka → Cumilla → Feni → Chattogram you can get on and off at any pair of stops, and you pay only for that leg. The same seat is sold separately for the parts of the journey you are not using.',
                             bn: 'যায়। ঢাকা → কুমিল্লা → ফেনী → চট্টগ্রাম-এর মতো রুটে আপনি যেকোনো দুই স্টপের মধ্যে উঠতে-নামতে পারেন, এবং শুধু ওই অংশের ভাড়া দেন। যাত্রার যে অংশ আপনি ব্যবহার করছেন না, সেই অংশে একই আসন আলাদাভাবে বিক্রি হয়।' },
  'faq.q.refundAmount':    { en: 'How much do I get back if I cancel?',
                             bn: 'বাতিল করলে কত টাকা ফেরত পাব?' },
  'faq.a.refundAmount':    { en: '90% if you cancel 24 hours or more before departure, 70% between 12 and 24 hours, 50% between 6 and 12 hours, and nothing under 6 hours. Your exact amount is shown on screen before you confirm — you never have to work it out yourself.',
                             bn: 'ছাড়ার 24 ঘণ্টা বা তার আগে বাতিল করলে 90%, 12–24 ঘণ্টার মধ্যে 70%, 6–12 ঘণ্টার মধ্যে 50%, আর 6 ঘণ্টার কম সময় থাকলে কিছুই না। নিশ্চিত করার আগেই আপনার সঠিক টাকার অঙ্ক স্ক্রিনে দেখানো হয় — নিজে হিসাব করতে হয় না।' },
  'faq.q.refundWhen':      { en: 'When does my refund arrive?',
                             bn: 'ফেরতের টাকা কখন পাব?' },
  'faq.a.refundWhen':      { en: 'It is approved immediately and sent back to whatever you paid with. Mobile wallets usually settle within 3 working days; cards can take up to 7.',
                             bn: 'সঙ্গে সঙ্গে অনুমোদন হয় এবং যেভাবে টাকা দিয়েছিলেন সেভাবেই ফেরত যায়। মোবাইল ওয়ালেটে সাধারণত 3 কর্মদিবস, কার্ডে 7 দিন পর্যন্ত লাগতে পারে।' },
  'faq.q.print':           { en: 'Do I need to print my ticket?',
                             bn: 'টিকিট কি প্রিন্ট করতে হবে?' },
  'faq.a.print':           { en: 'No. The QR on your ticket scans straight off your phone screen, and it keeps working without a signal once the page has loaded. Print it only if you prefer paper.',
                             bn: 'না। টিকিটের QR কোডটি ফোনের স্ক্রিন থেকেই স্ক্যান হয়, আর পেজটি একবার খুললে নেটওয়ার্ক ছাড়াও কাজ করে। কাগজ পছন্দ করলেই কেবল প্রিন্ট করুন।' },
  'faq.q.change':          { en: 'Can I change my departure instead of cancelling?',
                             bn: 'বাতিল না করে সময় বদলানো যায়?' },
  'faq.a.change':          { en: 'Yes, as long as the booking is confirmed and the bus has not left. Open your booking and choose Change the time — you keep your current seats until the new ones are confirmed, and you only pay the fare difference.',
                             bn: 'যায় — বুকিংটি নিশ্চিত থাকলে এবং বাস না ছাড়লে। আপনার বুকিং খুলে “সময় বদলান” বেছে নিন — নতুন আসন নিশ্চিত না হওয়া পর্যন্ত এখনকার আসন আপনারই থাকে, আর শুধু ভাড়ার পার্থক্যটুকু দিতে হয়।' },

  /* ----------------------------------------------------------------- login */
  'li.title':              { en: 'Sign in',                  bn: 'ঢুকুন' },
  'li.lead':               { en: 'You do not need an account to buy a ticket. Signing in keeps your trips, your saved passengers and your refunds in one place — and picks up anything you already booked on this number.',
                             bn: 'টিকিট কিনতে অ্যাকাউন্ট লাগে না। ঢুকলে আপনার যাত্রা, সংরক্ষিত যাত্রী আর ফেরতগুলো এক জায়গায় থাকে — এবং এই নম্বরে আগে করা বুকিংগুলোও যুক্ত হয়ে যায়।' },
  'li.byCode':             { en: 'Code by SMS',              bn: 'SMS-এ কোড' },
  'li.byPassword':         { en: 'Password',                 bn: 'পাসওয়ার্ড' },
  'li.mobile':             { en: 'Mobile number',            bn: 'মোবাইল নম্বর' },
  'li.sendCode':           { en: 'Send me a code',           bn: 'আমাকে কোড পাঠান' },
  'li.sending':            { en: 'Sending…',                 bn: 'পাঠানো হচ্ছে…' },
  'li.codeLabel':          { en: 'The six-digit code',       bn: 'ছয় সংখ্যার কোড' },
  'li.codeSent':           { en: 'We sent a code to {phone}. It works for the next {minutes} minutes.',
                             bn: '{phone} নম্বরে কোড পাঠানো হয়েছে। এটি পরবর্তী {minutes} মিনিট কাজ করবে।' },
  'li.codeShown':          { en: 'Your code is {code}. It appears on screen only because this build has SHOW_OTP switched on; a real deployment sends it by SMS and never returns it.',
                             bn: 'আপনার কোড {code}। এটি স্ক্রিনে দেখা যাচ্ছে শুধু এই বিল্ডে SHOW_OTP চালু আছে বলে; আসল সিস্টেমে কোডটি SMS-এ যায়, কখনো স্ক্রিনে আসে না।' },
  'li.verify':             { en: 'Sign in',                  bn: 'ঢুকুন' },
  'li.verifying':          { en: 'Checking…',                bn: 'যাচাই করা হচ্ছে…' },
  'li.otherNumber':        { en: 'Use a different number',   bn: 'অন্য নম্বর ব্যবহার করুন' },
  'li.resend':             { en: 'Send the code again',      bn: 'আবার কোড পাঠান' },
  'li.loginId':            { en: 'Mobile number or email',   bn: 'মোবাইল নম্বর বা ইমেইল' },
  'li.password':           { en: 'Password',                 bn: 'পাসওয়ার্ড' },
  'li.signingIn':          { en: 'Signing in…',              bn: 'ঢোকা হচ্ছে…' },
  'li.claimed':            { en: '{count} earlier booking(s) on this number are now in your account.',
                             bn: 'এই নম্বরের {count}টি আগের বুকিং এখন আপনার অ্যাকাউন্টে যুক্ত হয়েছে।' },
  'li.codeFailed':         { en: 'That code did not work. Check the digits, or ask for a new one.',
                             bn: 'কোডটি কাজ করেনি। সংখ্যাগুলো মিলিয়ে দেখুন, অথবা নতুন কোড নিন।' },
  'li.sendFailed':         { en: 'We could not send a code to that number.',
                             bn: 'ওই নম্বরে কোড পাঠানো যায়নি।' },
  'li.pwFailed':           { en: 'That mobile number and password do not match.',
                             bn: 'মোবাইল নম্বর ও পাসওয়ার্ড মিলছে না।' },
  'li.staffDoor':          { en: 'Staff sign in at the staff door.',
                             bn: 'কর্মীরা স্টাফ দরজা দিয়ে ঢোকেন।' },

  /* --------------------------------------------------------------- sandbox */
  'sb.title':              { en: 'Test payment screen',      bn: 'টেস্ট পেমেন্ট স্ক্রিন' },
  'sb.testMode':           { en: 'Test mode',                bn: 'টেস্ট মোড' },
  'sb.noMoney':            { en: 'No money moves here. This screen stands in for bKash or Nagad’s own payment page so the whole path can be exercised end to end.',
                             bn: 'এখানে কোনো টাকা লেনদেন হয় না। bKash বা Nagad-এর নিজস্ব পেমেন্ট পেজের জায়গায় এই স্ক্রিনটি বসানো হয়েছে, যাতে পুরো প্রক্রিয়াটি শুরু থেকে শেষ পর্যন্ত পরীক্ষা করা যায়।' },
  'sb.webhookNote':        { en: 'Approving asks the provider to send a signed message to the platform. Your ticket is issued by that message — not by this page.',
                             bn: 'অনুমোদন করলে প্রোভাইডার প্ল্যাটফর্মে একটি স্বাক্ষরিত বার্তা পাঠায়। আপনার টিকিট ওই বার্তা থেকেই তৈরি হয় — এই পেজ থেকে নয়।' },
  'sb.approve':            { en: 'Approve payment',          bn: 'পেমেন্ট অনুমোদন করুন' },
  'sb.decline':            { en: 'Decline',                  bn: 'বাতিল করুন' },
  'sb.confirming':         { en: 'Confirming…',              bn: 'নিশ্চিত করা হচ্ছে…' },
  'sb.declined':           { en: 'The payment was declined. Your seats are still held — you can try another method.',
                             bn: 'পেমেন্টটি গ্রহণ করা হয়নি। আপনার আসন এখনো ধরে রাখা আছে — অন্য উপায়ে চেষ্টা করতে পারেন।' },

  /* ═══════════════════════════════════════════════════ THE FRONTLINE APPS ══
   *
   * Counter POS, Driver & Crew, Agent Portal.
   *
   * These three are in Bangla and the three back-office consoles are not, and
   * that line is drawn on who sits at the screen. A counter clerk at a Gabtoli
   * window, a helper scanning tickets at the bus door and a shopkeeper selling
   * against a wallet are the least English-fluent users the platform has, and
   * they are the ones who take cash, strand a passenger or lose money when they
   * misread something. The ledger, the reconciliation queue and the audit log
   * are read by finance and platform staff hired for exactly that literacy, and
   * their vocabulary — trial balance, withholding, maker-checker — has no
   * settled Bangla I would not be inventing on the spot.
   *
   * Money, seat numbers, PNRs and clock times stay Latin here for the same
   * reason they do on the passenger side, and more urgently: these numbers get
   * read aloud down a phone line to a dispatcher.
   * ═════════════════════════════════════════════════════════════════════════ */

  /* ------------------------------------------------------------ staff chrome */
  'st.signedInAs':         { en: 'Signed in as',             bn: 'ঢুকেছেন' },
  'st.signOut':            { en: 'Sign out',                 bn: 'বেরিয়ে যান' },
  'st.switch':             { en: 'Switch workplace',         bn: 'কর্মস্থল বদলান' },
  'st.loading':            { en: 'Opening your workplace…',  bn: 'আপনার কর্মস্থল খোলা হচ্ছে…' },

  /* --------------------------------------------------------------- counter */
  'co.app':                { en: 'Counter',                  bn: 'কাউন্টার' },
  'co.appNote':            { en: 'Sell, print, balance the drawer',
                             bn: 'টিকিট বিক্রি, প্রিন্ট, ক্যাশ মিলানো' },
  'co.nav.sell':           { en: 'Sell a ticket',            bn: 'টিকিট বিক্রি' },
  'co.nav.quota':          { en: 'Reserved seats',           bn: 'রাখা আসন' },
  'co.nav.sales':          { en: 'Today’s sales',            bn: 'আজকের বিক্রি' },
  'co.nav.shift':          { en: 'Drawer & shift',           bn: 'ক্যাশ ও শিফট' },

  'co.title':              { en: 'Sell a ticket',            bn: 'টিকিট বিক্রি করুন' },
  'co.terminal':           { en: 'Terminal',                 bn: 'টার্মিনাল' },
  'co.from':               { en: 'From',                     bn: 'কোথা থেকে' },
  'co.to':                 { en: 'To',                       bn: 'কোথায়' },
  'co.date':               { en: 'Date',                     bn: 'তারিখ' },
  'co.find':               { en: 'Find departures',          bn: 'বাস খুঁজুন' },
  'co.finding':            { en: 'Searching…',               bn: 'খোঁজা হচ্ছে…' },
  'co.departs':            { en: 'Departs',                  bn: 'ছাড়বে' },
  'co.free':               { en: 'Free',                     bn: 'খালি' },
  'co.fare':               { en: 'Fare',                     bn: 'ভাড়া' },
  'co.seats':              { en: 'Seats',                    bn: 'আসন' },
  'co.noDepartures':       { en: 'No departures that day.',  bn: 'ওই দিনে কোনো বাস নেই।' },
  'co.change':             { en: 'Change departure',         bn: 'অন্য বাস' },
  'co.liveMap':            { en: 'This is the live map from the central inventory — the same one the website is drawing right now.',
                             bn: 'এটি কেন্দ্রীয় আসন তালিকার সরাসরি ম্যাপ — ওয়েবসাইট এই মুহূর্তে ঠিক এটিই দেখাচ্ছে।' },
  'co.passengers':         { en: 'Passengers',               bn: 'যাত্রী' },
  'co.pickSeats':          { en: 'Pick seats on the map.',   bn: 'ম্যাপ থেকে আসন বেছে নিন।' },
  'co.seatNo':             { en: 'Seat {seat}',              bn: 'আসন {seat}' },
  'co.paxName':            { en: 'Passenger name',           bn: 'যাত্রীর নাম' },
  'co.mobile':             { en: 'Mobile number',            bn: 'মোবাইল নম্বর' },
  'co.payment':            { en: 'Payment',                  bn: 'পেমেন্ট' },
  'co.cash':               { en: 'Cash',                     bn: 'নগদ' },
  'co.card':               { en: 'Card',                     bn: 'কার্ড' },
  'co.fareLine':           { en: '{count} × fare',           bn: '{count} × ভাড়া' },
  'co.serviceFee':         { en: 'Service fee',              bn: 'সার্ভিস ফি' },
  'co.total':              { en: 'Total',                    bn: 'মোট' },
  'co.take':               { en: 'Take {amount}',            bn: '{amount} নিন' },
  'co.taking':             { en: 'Taking payment…',          bn: 'পেমেন্ট নেওয়া হচ্ছে…' },
  'co.needShift':          { en: 'Open the drawer before taking cash.',
                             bn: 'নগদ নেওয়ার আগে ক্যাশ ড্রয়ার খুলুন।' },
  'co.noShift':            { en: 'No shift is open on this counter. A cash sale with no open shift has nowhere to be counted at close.',
                             bn: 'এই কাউন্টারে কোনো শিফট খোলা নেই। শিফট ছাড়া নগদ বিক্রি হলে শিফট বন্ধের সময় সেটি কোথাও গোনা যাবে না।' },
  'co.openDrawer':         { en: 'Open the drawer',          bn: 'ড্রয়ার খুলুন' },

  /* The confirm step. Speed wins ties, but never on money leaving a hand. */
  'co.confirmTitle':       { en: 'Take {amount} in {method}?',
                             bn: '{method} {amount} নেবেন?' },
  'co.confirmSeats':       { en: '{seats} on the {time} to {dest}',
                             bn: '{time}-এর {dest} বাসে {seats}' },
  'co.confirmYes':         { en: 'Yes, take it',             bn: 'হ্যাঁ, নিন' },
  'co.confirmNo':          { en: 'Go back',                  bn: 'ফিরে যান' },
  'co.changeDue':          { en: 'Change to give back',      bn: 'ফেরত দিতে হবে' },
  'co.tendered':           { en: 'Cash received',            bn: 'যত টাকা পেলেন' },

  'co.sold':               { en: 'Sold',                     bn: 'বিক্রি হয়েছে' },
  'co.collected':          { en: 'Collected',                bn: 'নেওয়া হয়েছে' },
  'co.print':              { en: 'Print ticket',             bn: 'টিকিট প্রিন্ট' },
  'co.next':               { en: 'Next sale',                bn: 'পরের বিক্রি' },
  'co.openTicket':         { en: 'Open ticket',              bn: 'টিকিট দেখুন' },

  /* Offline */
  'co.offline':            { en: 'Offline',                  bn: 'লাইন নেই' },
  'co.offlineBody':        { en: 'You can only sell seats this counter already reserved. Everything else needs the line back — an offline terminal cannot tell whether a seat is still free.',
                             bn: 'এখন কেবল এই কাউন্টারের আগে থেকে রাখা আসনগুলোই বিক্রি করা যাবে। বাকি সব কিছুর জন্য লাইন দরকার — লাইন ছাড়া টার্মিনাল জানে না কোন আসন এখনো খালি আছে।' },
  'co.waiting':            { en: '{count} waiting to sync',  bn: '{count}টি পাঠানোর অপেক্ষায়' },
  'co.syncNow':            { en: 'Send now',                 bn: 'এখনই পাঠান' },
  // One string per number. "sale(s)" is a parenthesis asking the reader to do
  // the grammar — the shortcut this catalogue already rejected on the passenger
  // side, which crept back in here. Bangla marks no plural on a counted noun,
  // so only English needs the pair.
  'co.synced1':            { en: 'Sent 1 sale',              bn: '1টি বিক্রি পাঠানো হয়েছে' },
  'co.synced':             { en: 'Sent {count} sales',       bn: '{count}টি বিক্রি পাঠানো হয়েছে' },
  'co.refused':            { en: '{count} refused: {reason}', bn: '{count}টি গৃহীত হয়নি: {reason}' },
  'co.ownedSeats':         { en: 'Seats this counter owns',  bn: 'এই কাউন্টারের নিজের আসন' },
  'co.ownedBody':          { en: 'These are reserved in the central inventory and invisible to the website, so selling them without the line cannot double-book anyone.',
                             bn: 'এগুলো কেন্দ্রীয় তালিকায় এই কাউন্টারের নামে রাখা এবং ওয়েবসাইটে দেখা যায় না, তাই লাইন ছাড়া বিক্রি করলেও একই আসন দুবার বিক্রি হবে না।' },
  'co.offlineSale':        { en: 'Sale without the line',    bn: 'লাইন ছাড়া বিক্রি' },
  'co.cashOnly':           { en: 'Cash only',                bn: 'শুধু নগদ' },
  'co.recordSale':         { en: 'Record cash sale',         bn: 'নগদ বিক্রি লিখে রাখুন' },
  'co.noQuota':            { en: 'No reserved seats to sell',
                             bn: 'বিক্রি করার মতো রাখা আসন নেই' },
  'co.noQuotaBody':        { en: 'This counter holds no reserved seats, so there is nothing it can sell without the line. Reserve some while you still have a connection.',
                             bn: 'এই কাউন্টারের নামে কোনো আসন রাখা নেই, তাই লাইন ছাড়া কিছুই বিক্রি করা যাবে না। লাইন থাকতেই কিছু আসন রেখে দিন।' },
  'co.reserveSeats':       { en: 'Reserve seats',            bn: 'আসন রেখে দিন' },
  'co.queued':             { en: 'Queued {seats} — reference {ref}. Write the seat and this reference on the paper ticket. It books when the line returns.',
                             bn: '{seats} লেখা হয়েছে — রেফারেন্স {ref}। কাগজের টিকিটে আসন ও এই রেফারেন্সটি লিখে দিন। লাইন ফিরলে বুকিং হয়ে যাবে।' },
  'co.noPnrOffline':       { en: 'No ticket number is issued without the line. The passenger gets a paper ticket now and the real one when the terminal reconnects.',
                             bn: 'লাইন ছাড়া কোনো টিকিট নম্বর দেওয়া হয় না। যাত্রী এখন কাগজের টিকিট পাবেন, আর টার্মিনাল আবার যুক্ত হলে আসল টিকিটটি পাবেন।' },
  'co.simDrop':            { en: 'Simulate line drop',       bn: 'লাইন কাটা পরীক্ষা' },
  'co.simBack':            { en: 'Simulate reconnect',       bn: 'লাইন ফেরা পরীক্ষা' },

  /* Keyboard hints. A clerk with a queue never reaches for the mouse. */
  'co.kbd.search':         { en: 'Enter to search',          bn: 'খুঁজতে Enter' },
  'co.kbd.pick':           { en: '1–9 picks a departure',    bn: 'বাস বাছতে 1–9' },
  'co.kbd.sell':           { en: 'Ctrl+Enter to take payment', bn: 'পেমেন্ট নিতে Ctrl+Enter' },
  'co.kbd.back':           { en: 'Esc goes back',            bn: 'ফিরতে Esc' },
  'co.kbd.title':          { en: 'Keyboard',                 bn: 'কীবোর্ড' },

  /* ---------------------------------------------------------------- driver */
  'dr.app':                { en: 'Driver & Crew',            bn: 'চালক ও হেল্পার' },
  'dr.appNote':            { en: 'Your trips, your manifest', bn: 'আপনার যাত্রা, আপনার যাত্রী তালিকা' },
  'dr.nav.trips':          { en: 'My trips',                 bn: 'আমার যাত্রা' },
  'dr.nav.scan':           { en: 'Board passengers',         bn: 'যাত্রী তুলুন' },
  'dr.nav.incidents':      { en: 'Report a problem',         bn: 'সমস্যা জানান' },

  'dr.today':              { en: 'Today',                    bn: 'আজ' },
  'dr.noTrips':            { en: 'No trips assigned to you', bn: 'আপনার নামে কোনো যাত্রা নেই' },
  'dr.manifest':           { en: 'Passenger list',           bn: 'যাত্রী তালিকা' },
  'dr.boarded':            { en: 'Boarded',                  bn: 'উঠেছেন' },
  'dr.notBoarded':         { en: 'Not yet',                  bn: 'এখনো ওঠেননি' },
  'dr.ofTotal':            { en: '{done} of {total} boarded', bn: '{total} জনের মধ্যে {done} জন উঠেছেন' },
  'dr.scanTitle':          { en: 'Scan a ticket',            bn: 'টিকিট স্ক্যান করুন' },
  'dr.scanHint':           { en: 'Point at the QR on the passenger’s phone, or type the ticket number.',
                             bn: 'যাত্রীর ফোনের QR কোডে ধরুন, অথবা টিকিট নম্বর লিখুন।' },
  'dr.scanOk':             { en: 'Let them on',              bn: 'উঠতে দিন' },
  'dr.scanAlready':        { en: 'Already boarded',          bn: 'আগেই উঠেছেন' },
  'dr.scanBad':            { en: 'Do not let them on',       bn: 'উঠতে দেবেন না' },
  'dr.seatIs':             { en: 'Seat {seat}',              bn: 'আসন {seat}' },
  'dr.markBoarded':        { en: 'Mark boarded',             bn: 'উঠেছেন লিখুন' },
  'dr.noShow':            { en: 'Did not come',              bn: 'আসেননি' },
  'dr.startTrip':          { en: 'Start the trip',           bn: 'যাত্রা শুরু' },
  'dr.arrived':            { en: 'We have arrived',          bn: 'পৌঁছে গেছি' },
  'dr.problem':            { en: 'Report a problem',         bn: 'সমস্যা জানান' },
  'dr.problemKind':        { en: 'What happened?',           bn: 'কী হয়েছে?' },
  'dr.problemNote':        { en: 'Tell the office what they need to know',
                             bn: 'অফিসকে যা জানানো দরকার লিখুন' },
  'dr.send':               { en: 'Send to the office',       bn: 'অফিসে পাঠান' },
  'dr.sent':               { en: 'The office has it.',       bn: 'অফিস পেয়ে গেছে।' },

  /*
   * Crew actions, named as actions.
   *
   * These buttons used to be labelled with the destination state, lowercased
   * straight out of the database — "boarding", "departed", "in progress". That
   * tells a driver what a row in a table will say afterwards, not what pressing
   * it does. A button is a verb.
   */
  'dr.do.BOARDING':        { en: 'Start boarding',           bn: 'যাত্রী তোলা শুরু' },
  'dr.do.DEPARTED':        { en: 'We have left',             bn: 'আমরা ছেড়েছি' },
  'dr.do.IN_PROGRESS':     { en: 'On the road',              bn: 'পথে আছি' },
  'dr.do.ARRIVED':         { en: 'We have arrived',          bn: 'পৌঁছে গেছি' },
  'dr.done.BOARDING':      { en: 'Boarding has started.',    bn: 'যাত্রী তোলা শুরু হয়েছে।' },
  'dr.done.DEPARTED':      { en: 'Marked as left.',          bn: 'ছেড়েছে বলে লেখা হয়েছে।' },
  'dr.done.IN_PROGRESS':   { en: 'Marked as on the road.',   bn: 'পথে আছে বলে লেখা হয়েছে।' },
  'dr.done.ARRIVED':       { en: 'Marked as arrived.',       bn: 'পৌঁছেছে বলে লেখা হয়েছে।' },

  'dr.myTrips':            { en: 'My trips',                 bn: 'আমার যাত্রা' },
  'dr.nextDays':           { en: 'Today and the next two days',
                             bn: 'আজ ও পরের দুই দিন' },
  'dr.noneAssigned':       { en: 'Nothing is rostered to you in the next few days.',
                             bn: 'আগামী কয়েক দিনে আপনার নামে কিছু দেওয়া হয়নি।' },
  'dr.notRostered':        { en: 'not rostered',             bn: 'দায়িত্ব দেওয়া হয়নি' },
  'dr.role.DRIVER':        { en: 'Driver',                   bn: 'চালক' },
  'dr.role.HELPER':        { en: 'Helper',                   bn: 'হেল্পার' },
  'dr.role.SUPERVISOR':    { en: 'Supervisor',               bn: 'সুপারভাইজার' },
  'dr.shareLocation':      { en: 'Share where we are',       bn: 'আমরা কোথায় আছি জানান' },
  'dr.sharing':            { en: 'Sending…',                 bn: 'পাঠানো হচ্ছে…' },
  'dr.shared':             { en: 'Sent. Passengers on this trip now see where the bus really is instead of a timetable guess.',
                             bn: 'পাঠানো হয়েছে। এই যাত্রার যাত্রীরা এখন সময়সূচির আন্দাজের বদলে বাস আসলে কোথায় আছে তা দেখছেন।' },
  'dr.shareRefused':       { en: 'Location was refused, so nothing was sent. Passengers keep seeing the timetable estimate.',
                             bn: 'অবস্থান জানানোর অনুমতি দেওয়া হয়নি, তাই কিছুই পাঠানো হয়নি। যাত্রীরা সময়সূচির আন্দাজই দেখতে থাকবেন।' },
  'dr.noGeo':              { en: 'This phone cannot report where it is.',
                             bn: 'এই ফোন নিজের অবস্থান জানাতে পারে না।' },

  /*
   * The boarding verdict.
   *
   * A helper in a doorway does not need to know that the ticket record moved to
   * BOARDED. They need to know whether to let this person onto the bus, and
   * they need to know it in the half-second before the next passenger pushes
   * forward. So the verdict is the instruction, at full size, and the
   * explanation sits underneath it for the cases that need one.
   */
  'dr.scanTrip':           { en: 'Trip',                     bn: 'যাত্রা' },
  'dr.scanSub':            { en: 'Type or scan the ticket number. Works with no signal, against the list downloaded before you left.',
                             bn: 'টিকিট নম্বর লিখুন বা স্ক্যান করুন। নেটওয়ার্ক না থাকলেও ছাড়ার আগে নামানো তালিকা দিয়ে কাজ করবে।' },
  'dr.checkIn':            { en: 'Check',                    bn: 'দেখুন' },
  'dr.seatOptional':       { en: 'Seat (if you have it)',    bn: 'আসন (জানা থাকলে)' },
  'dr.notConfirmed':       { en: 'Written down on this phone — the office has not confirmed it yet.',
                             bn: 'এই ফোনে লেখা হয়েছে — অফিস এখনো নিশ্চিত করেনি।' },
  'dr.waitingScans1':      { en: '1 scan taken without signal, waiting to send.',
                             bn: 'নেটওয়ার্ক ছাড়া 1টি স্ক্যান নেওয়া হয়েছে, পাঠানোর অপেক্ষায়।' },
  'dr.waitingScans':       { en: '{count} scans taken without signal, waiting to send.',
                             bn: 'নেটওয়ার্ক ছাড়া {count}টি স্ক্যান নেওয়া হয়েছে, পাঠানোর অপেক্ষায়।' },
  'dr.sendNow':            { en: 'Send now',                 bn: 'এখনই পাঠান' },
  'dr.recent':             { en: 'Recent checks on this phone',
                             bn: 'এই ফোনে সাম্প্রতিক যাচাই' },
  'dr.confirmedShort':     { en: 'confirmed',                bn: 'নিশ্চিত' },
  'dr.queuedShort':        { en: 'waiting',                  bn: 'অপেক্ষায়' },
  'dr.offAlready':         { en: 'Already marked boarded before we lost signal — seat {seat}.',
                             bn: 'নেটওয়ার্ক যাওয়ার আগেই উঠেছেন বলে লেখা হয়েছিল — আসন {seat}।' },
  'dr.offBoarded':         { en: 'Seat {seat}. Written down — it will be confirmed when the signal comes back.',
                             bn: 'আসন {seat}। লেখা হয়েছে — নেটওয়ার্ক ফিরলে নিশ্চিত হয়ে যাবে।' },
  'dr.offMissing':         { en: 'Not on the list we downloaded before leaving. Check by hand.',
                             bn: 'ছাড়ার আগে নামানো তালিকায় এই নাম নেই। হাতে মিলিয়ে দেখুন।' },

  /* ----------------------------------------------------------------- agent */
  'ag.app':                { en: 'Agent',                    bn: 'এজেন্ট' },
  'ag.appNote':            { en: 'Sell against your wallet', bn: 'ওয়ালেট থেকে টিকিট বিক্রি' },
  'ag.nav.wallet':         { en: 'Wallet',                   bn: 'ওয়ালেট' },
  'ag.nav.sell':           { en: 'Sell a ticket',            bn: 'টিকিট বিক্রি' },
  'ag.nav.bookings':       { en: 'Bookings',                 bn: 'বুকিং' },
  'ag.nav.commissions':    { en: 'Commission',               bn: 'কমিশন' },
  'ag.nav.recharge':       { en: 'Add money',                bn: 'টাকা যোগ করুন' },

  'ag.available':          { en: 'You can spend',            bn: 'খরচ করতে পারবেন' },
  'ag.held':               { en: 'Held for sales in progress', bn: 'চলতি বিক্রির জন্য আটকে আছে' },
  'ag.credit':             { en: 'Credit limit',             bn: 'ক্রেডিট সীমা' },
  'ag.balance':            { en: 'Your own money',           bn: 'আপনার নিজের টাকা' },
  'ag.cannotAfford':       { en: 'Not enough in the wallet for this sale',
                             bn: 'এই বিক্রির জন্য ওয়ালেটে যথেষ্ট টাকা নেই' },
  'ag.shortBy':            { en: 'Short by {amount}',        bn: '{amount} কম আছে' },
  'ag.addMoney':           { en: 'Add money',                bn: 'টাকা যোগ করুন' },
  'ag.sellFor':            { en: 'Sell for {amount}',        bn: '{amount} টাকায় বিক্রি করুন' },
  'ag.selling':            { en: 'Selling…',                 bn: 'বিক্রি হচ্ছে…' },
  'ag.youEarn':            { en: 'You earn {amount}',        bn: 'আপনি পাবেন {amount}' },
  'ag.mismatch':           { en: 'This wallet’s cached figures do not match its transactions. Finance has been told.',
                             bn: 'এই ওয়ালেটের দেখানো হিসাব লেনদেনের সাথে মিলছে না। ফাইন্যান্সকে জানানো হয়েছে।' },

  /*
   * The wallet.
   *
   * Four equal tiles asked a shopkeeper to work out their own answer to the one
   * question they ever have — can I sell this ticket right now? — from a
   * balance, a credit line and a held figure. The sum is given at full size and
   * the three parts sit under it, so the arithmetic is shown rather than set as
   * homework.
   */
  'ag.spendNow':           { en: 'You can spend right now',  bn: 'এখন খরচ করতে পারবেন' },
  'ag.spendHow':           { en: 'your money {balance} + credit {credit} − held {held}',
                             bn: 'আপনার টাকা {balance} + ক্রেডিট {credit} − আটকে থাকা {held}' },
  'ag.balanceHint':        { en: 'money you have put in',    bn: 'আপনি যত টাকা দিয়েছেন' },
  'ag.heldHint':           { en: 'committed to sales in progress',
                             bn: 'চলতি বিক্রির জন্য রাখা' },
  'ag.creditHint':         { en: 'agreed overdraft',         bn: 'অনুমোদিত ধার' },
  'ag.ledgerNote':         { en: 'Your wallet is a ledger. Every figure here is worked out from the transactions below — none of it is typed in by anyone.',
                             bn: 'আপনার ওয়ালেট একটি হিসাবের খাতা। এখানকার প্রতিটি সংখ্যা নিচের লেনদেন থেকে হিসাব করা — কেউ হাতে লেখে না।' },
  'ag.agrees':             { en: 'Checked against the transaction log just now: they agree to the poisha.',
                             bn: 'এইমাত্র লেনদেনের খাতার সাথে মিলিয়ে দেখা হয়েছে: পয়সা পর্যন্ত মিলেছে।' },
  'ag.mismatchTitle':      { en: 'These figures do not match the transaction log.',
                             bn: 'এই হিসাব লেনদেনের খাতার সাথে মিলছে না।' },
  'ag.mismatchBody':       { en: 'The log says {available} available and {held} held. The log is the truth — please report this before selling anything else.',
                             bn: 'খাতা বলছে {available} আছে এবং {held} আটকে আছে। খাতাই সঠিক — আর কিছু বিক্রি করার আগে বিষয়টি জানান।' },
  'ag.txns':               { en: 'Transactions',             bn: 'লেনদেন' },
  'ag.when':               { en: 'When',                     bn: 'কখন' },
  'ag.type':               { en: 'What',                     bn: 'কী' },
  'ag.booking':            { en: 'Booking',                  bn: 'বুকিং' },
  'ag.note':               { en: 'Note',                     bn: 'মন্তব্য' },
  'ag.amount':             { en: 'Amount',                   bn: 'টাকা' },
  'ag.noTxns':             { en: 'No transactions yet.',     bn: 'এখনো কোনো লেনদেন নেই।' },
  'ag.kind.RECHARGE':      { en: 'Money added',              bn: 'টাকা যোগ' },
  'ag.kind.SALE':          { en: 'Ticket sold',              bn: 'টিকিট বিক্রি' },
  'ag.kind.REFUND':        { en: 'Refund',                   bn: 'ফেরত' },
  'ag.kind.COMMISSION':    { en: 'Commission',               bn: 'কমিশন' },
  'ag.kind.ADJUSTMENT':    { en: 'Adjustment',               bn: 'সংশোধন' },
  'ag.chargedToWallet':    { en: 'Taken from your wallet',   bn: 'আপনার ওয়ালেট থেকে কাটা' },
  'ag.leftAfter':          { en: 'Left after this sale',     bn: 'এই বিক্রির পর থাকবে' },
  'ag.commissionEarned':   { en: 'You earned',               bn: 'আপনি পেলেন' },
  'ag.walletEmpty':        { en: 'Your wallet has nothing left to spend. Adding money takes effect once the office approves it.',
                             bn: 'আপনার ওয়ালেটে খরচ করার মতো কিছু নেই। টাকা যোগ করলে অফিস অনুমোদনের পর তা কাজ করবে।' },

  /* ------------------------------------------------- the cash difference */
  'var.balanced':          { en: 'Balanced',                 bn: 'মিলে গেছে' },
  'var.over':              { en: '{amount} over',            bn: '{amount} বেশি' },
  'var.short':             { en: '{amount} short',           bn: '{amount} কম' },

  /* ----------------------------------------- counter · seats held back */
  'co.q.sub':              { en: 'Seats this counter owns outright, so it can keep selling when the line drops',
                             bn: 'এই কাউন্টারের নিজের আসন — লাইন চলে গেলেও এগুলো বিক্রি করা যাবে' },
  'co.q.heldNow':          { en: 'Held back now ({count})',   bn: 'এখন রাখা আছে ({count})' },
  'co.q.none':             { en: 'Nothing held back. With no reserved seats this counter cannot sell anything at all once the connection drops.',
                             bn: 'কিছু রাখা নেই। রাখা আসন না থাকলে লাইন চলে গেলে এই কাউন্টার কিছুই বিক্রি করতে পারবে না।' },
  'co.q.journey':          { en: 'Journey',                   bn: 'যাত্রা' },
  'co.q.release':          { en: 'Put back on sale',          bn: 'বিক্রিতে ফেরত দিন' },
  'co.q.released':         { en: 'Seat {seat} is back on general sale.',
                             bn: 'আসন {seat} আবার সবার জন্য বিক্রিতে গেছে।' },
  'co.q.reserved':         { en: 'Held back {seats}. They are off sale everywhere else from now on.',
                             bn: '{seats} রাখা হয়েছে। এগুলো এখন থেকে আর কোথাও বিক্রি হবে না।' },
  'co.q.pending1':         { en: '1 sale made without the line is still waiting to be sent. Putting seats back on sale now will not touch it — it was sold from a seat this counter already owned.',
                             bn: 'লাইন ছাড়া করা 1টি বিক্রি এখনো পাঠানো হয়নি। এখন আসন ফেরত দিলে তাতে কিছু হবে না — ওটা কাউন্টারের নিজের আসন থেকেই বিক্রি হয়েছে।' },
  'co.q.pending':          { en: '{count} sales made without the line are still waiting to be sent. Putting seats back on sale now will not touch them — they were sold from seats this counter already owned.',
                             bn: 'লাইন ছাড়া করা {count}টি বিক্রি এখনো পাঠানো হয়নি। এখন আসন ফেরত দিলে তাতে কিছু হবে না — ওগুলো কাউন্টারের নিজের আসন থেকেই বিক্রি হয়েছে।' },
  'co.q.chooseSeats':      { en: 'Choose seats',              bn: 'আসন বাছুন' },
  'co.q.cap':              { en: 'Up to 8 seats per counter per departure. A seat held back leaves the public seat map at once.',
                             bn: 'প্রতি বাসে প্রতি কাউন্টার সর্বোচ্চ 8টি আসন। রাখা আসন সাথে সাথেই ওয়েবসাইটের ম্যাপ থেকে সরে যায়।' },
  'co.q.reserve1':         { en: 'Hold back 1 seat',          bn: '1টি আসন রাখুন' },
  'co.q.reserveN':         { en: 'Hold back {count} seats',   bn: '{count}টি আসন রাখুন' },
  'co.q.reserving':        { en: 'Holding…',                  bn: 'রাখা হচ্ছে…' },
  'co.q.failLoad':         { en: 'The held-back seats could not be loaded.',
                             bn: 'রাখা আসনগুলো আনা গেল না।' },
  'co.q.failSearch':       { en: 'The search did not work.',  bn: 'খোঁজা গেল না।' },
  'co.q.failReserve':      { en: 'Those seats could not be held back.',
                             bn: 'ওই আসনগুলো রাখা গেল না।' },
  'co.q.failRelease':      { en: 'That seat could not be put back on sale.',
                             bn: 'ওই আসনটি বিক্রিতে ফেরত দেওয়া গেল না।' },

  /* ------------------------------------------------- counter · sales list */
  'co.s.sub':              { en: 'Newest first · print any of them again',
                             bn: 'নতুনটি আগে · যেকোনোটি আবার প্রিন্ট করা যায়' },
  'co.s.pending':          { en: 'Not sent yet ({count})',    bn: 'এখনো পাঠানো হয়নি ({count})' },
  'co.s.pendingNote':      { en: 'Sold without the line, from this counter’s own held-back seats. They have no ticket number until the terminal reconnects.',
                             bn: 'লাইন ছাড়া, এই কাউন্টারের নিজের রাখা আসন থেকে বিক্রি। লাইন না ফেরা পর্যন্ত এগুলোর টিকিট নম্বর নেই।' },
  'co.s.ref':              { en: 'Reference',                 bn: 'রেফারেন্স' },
  'co.s.pnr':              { en: 'Ticket no.',                bn: 'টিকিট নম্বর' },
  'co.s.departure':        { en: 'Departure',                 bn: 'যে বাস' },
  'co.s.paidWith':         { en: 'Paid with',                 bn: 'যেভাবে দিয়েছেন' },
  'co.s.status':           { en: 'Status',                    bn: 'অবস্থা' },
  'co.s.soldAt':           { en: 'Sold',                      bn: 'বিক্রি' },
  'co.s.amount':           { en: 'Amount',                    bn: 'টাকা' },
  'co.s.reprint':          { en: 'Print again',               bn: 'আবার প্রিন্ট' },
  'co.s.empty':            { en: 'Nothing sold from this counter yet.',
                             bn: 'এই কাউন্টার থেকে এখনো কিছু বিক্রি হয়নি।' },

  /* ---------------------------------------------------- counter · the cash */
  'co.sh.opened':          { en: 'Opened',                    bn: 'খোলা হয়েছে' },
  'co.sh.float':           { en: 'Starting change',           bn: 'শুরুর খুচরা' },
  'co.sh.cashSales':       { en: 'Cash taken',                bn: 'নগদ নেওয়া হয়েছে' },
  'co.sh.saleCount1':      { en: '1 sale',                    bn: '1টি বিক্রি' },
  'co.sh.saleCount':       { en: '{count} sales',             bn: '{count}টি বিক্রি' },
  'co.sh.expected':        { en: 'Should be in the drawer',   bn: 'ড্রয়ারে থাকার কথা' },
  'co.sh.expectedHint':    { en: 'starting change + cash taken',
                             bn: 'শুরুর খুচরা + নগদ নেওয়া' },
  'co.sh.closeTitle':      { en: 'Close the drawer',          bn: 'ড্রয়ার বন্ধ করুন' },
  'co.sh.countHint':       { en: 'Count the money and type what is actually there. Do not adjust it to match — catching the difference is the whole point of counting.',
                             bn: 'টাকা গুনে যা আসলে আছে তাই লিখুন। মিলিয়ে দেওয়ার জন্য বদলাবেন না — পার্থক্যটা ধরাই গোনার আসল কাজ।' },
  'co.sh.counted':         { en: 'Counted cash (৳)',          bn: 'গুনে পাওয়া নগদ (৳)' },
  'co.sh.note':            { en: 'Note (only if you want)',   bn: 'মন্তব্য (ইচ্ছা হলে)' },
  'co.sh.notePlaceholder': { en: 'Anything the manager should know',
                             bn: 'ম্যানেজারের জানা দরকার এমন কিছু' },
  'co.sh.difference':      { en: 'Difference',                bn: 'পার্থক্য' },
  'co.sh.close':           { en: 'Count and close',           bn: 'গুনে বন্ধ করুন' },
  'co.sh.closing':         { en: 'Closing…',                  bn: 'বন্ধ হচ্ছে…' },
  'co.sh.openTitle':       { en: 'Open the drawer',           bn: 'ড্রয়ার খুলুন' },
  'co.sh.openHint':        { en: 'Say how much change you are starting with. Only one drawer can be open on a counter at a time — two would make every taka unattributable.',
                             bn: 'শুরুতে আপনার হাতে কত খুচরা আছে লিখুন। একটি কাউন্টারে একসাথে একটিই ড্রয়ার খোলা থাকতে পারে — দুটি থাকলে কোন টাকা কার তা আর বলা যাবে না।' },
  'co.sh.floatLabel':      { en: 'Starting change (৳)',       bn: 'শুরুর খুচরা (৳)' },
  'co.sh.open':            { en: 'Open the drawer',           bn: 'ড্রয়ার খুলুন' },
  'co.sh.opening':         { en: 'Opening…',                  bn: 'খোলা হচ্ছে…' },
  'co.sh.openedFlash':     { en: 'Drawer open. Cash sales are counted against it from now on.',
                             bn: 'ড্রয়ার খোলা হয়েছে। এখন থেকে নগদ বিক্রি এর হিসাবেই যাবে।' },
  'co.sh.balanced':        { en: 'Drawer balanced at {amount}.',
                             bn: '{amount} — ড্রয়ার হুবহু মিলে গেছে।' },
  'co.sh.short':           { en: 'Closed {amount} short. A Cash Variance entry has been posted, so the books still balance and the difference stays visible in the accounts.',
                             bn: '{amount} কম নিয়ে বন্ধ হয়েছে। হিসাবে একটি ক্যাশ ভ্যারিয়েন্স এন্ট্রি বসেছে, তাই খাতা মিলেই থাকবে আর পার্থক্যটাও হিসাবে দেখা যাবে।' },
  'co.sh.over':            { en: 'Closed {amount} over. A Cash Variance entry has been posted, so the books still balance and the difference stays visible in the accounts.',
                             bn: '{amount} বেশি নিয়ে বন্ধ হয়েছে। হিসাবে একটি ক্যাশ ভ্যারিয়েন্স এন্ট্রি বসেছে, তাই খাতা মিলেই থাকবে আর পার্থক্যটাও হিসাবে দেখা যাবে।' },
  'co.sh.pending1':        { en: '1 sale made without the line has not been sent yet. Send it before closing — its cash is in the drawer but the sale is not in the books.',
                             bn: 'লাইন ছাড়া করা 1টি বিক্রি এখনো পাঠানো হয়নি। বন্ধ করার আগে পাঠান — ওর টাকা ড্রয়ারে আছে কিন্তু বিক্রিটা খাতায় নেই।' },
  'co.sh.pending':         { en: '{count} sales made without the line have not been sent yet. Send them before closing — their cash is in the drawer but the sales are not in the books.',
                             bn: 'লাইন ছাড়া করা {count}টি বিক্রি এখনো পাঠানো হয়নি। বন্ধ করার আগে পাঠান — ওগুলোর টাকা ড্রয়ারে আছে কিন্তু বিক্রিগুলো খাতায় নেই।' },
  'co.sh.failLoad':        { en: 'The drawer could not be loaded.',
                             bn: 'ড্রয়ারের হিসাব আনা গেল না।' },
  'co.sh.failOpen':        { en: 'The drawer could not be opened.',
                             bn: 'ড্রয়ার খোলা গেল না।' },
  'co.sh.failClose':       { en: 'The drawer could not be closed.',
                             bn: 'ড্রয়ার বন্ধ করা গেল না।' },
  'co.sh.history':         { en: 'Earlier shifts',            bn: 'আগের শিফট' },
  'co.sh.clerk':           { en: 'Who was on',                bn: 'যিনি ছিলেন' },
  'co.sh.sales':           { en: 'Sales',                     bn: 'বিক্রি' },
  'co.sh.countedShort':    { en: 'Counted',                   bn: 'গোনা' },
  'co.sh.result':          { en: 'Result',                    bn: 'ফল' },
  'co.sh.stillOpen':       { en: 'Still open',                bn: 'এখনো খোলা' },
  'co.sh.noneYet':         { en: 'No shifts yet.',            bn: 'এখনো কোনো শিফট নেই।' },

  /* --------------------------------------------------- driver · incidents */
  'dr.in.sub':             { en: 'Tell the office what happened, in your own words',
                             bn: 'কী হয়েছে নিজের ভাষায় অফিসকে জানান' },
  'dr.in.which':           { en: 'Which trip',                bn: 'কোন যাত্রা' },
  'dr.in.what':            { en: 'What happened',             bn: 'কী হয়েছে' },
  'dr.in.serious':         { en: 'How serious',               bn: 'কতটা জরুরি' },
  'dr.in.details':         { en: 'Tell them more',            bn: 'আরেকটু লিখুন' },
  'dr.in.placeholder':     { en: 'Held 20 minutes at the Meghna bridge',
                             bn: 'মেঘনা সেতুতে 20 মিনিট আটকে ছিলাম' },
  'dr.in.sent':            { en: 'Sent. The office can see this now.',
                             bn: 'পাঠানো হয়েছে। অফিস এখন এটা দেখতে পাচ্ছে।' },
  'dr.in.fail':            { en: 'It could not be sent.',     bn: 'পাঠানো গেল না।' },
  'dr.in.listTitle':       { en: 'Already told them',         bn: 'যা যা জানানো হয়েছে' },
  'dr.in.empty':           { en: 'Nothing reported.',         bn: 'কিছু জানানো হয়নি।' },
  'dr.in.by':              { en: 'Who told them',             bn: 'কে জানিয়েছেন' },
  'dr.in.foot':            { en: 'Sending this does more than write it down: the control room and the operator both get a message, and a breakdown opens an alert in the operations console. Nobody has to be watching this screen for it to be seen.',
                             bn: 'এটা পাঠালে শুধু লেখা হয় না: কন্ট্রোল রুম আর অপারেটর — দুজনেই খবর পান, আর বাস নষ্ট হলে অপারেশন্স কনসোলে সতর্কতা ওঠে। কেউ এই স্ক্রিনের দিকে তাকিয়ে না থাকলেও খবরটা পৌঁছে যায়।' },
  'dr.kind.BREAKDOWN':     { en: 'Bus broke down',            bn: 'বাস নষ্ট হয়েছে' },
  'dr.kind.ACCIDENT':      { en: 'Accident',                  bn: 'দুর্ঘটনা' },
  'dr.kind.ROUTE_INTERRUPTION': { en: 'Road blocked',         bn: 'রাস্তা বন্ধ' },
  'dr.kind.DELAY':         { en: 'Running late',              bn: 'দেরি হচ্ছে' },
  'dr.kind.PASSENGER_ISSUE': { en: 'Trouble with a passenger', bn: 'যাত্রী নিয়ে সমস্যা' },
  'dr.kind.OTHER':         { en: 'Something else',            bn: 'অন্য কিছু' },
  'dr.sev.LOW':            { en: 'Minor',                     bn: 'সামান্য' },
  'dr.sev.MEDIUM':         { en: 'Needs attention',           bn: 'দেখা দরকার' },
  'dr.sev.HIGH':           { en: 'Urgent',                    bn: 'জরুরি' },

  /* ---------------------------------------------------- driver · the list */
  'dr.mf.title':           { en: 'Passenger list',            bn: 'যাত্রী তালিকা' },
  'dr.mf.board':           { en: 'Start checking tickets',    bn: 'টিকিট দেখা শুরু' },
  'dr.mf.print':           { en: 'Print',                     bn: 'প্রিন্ট' },
  'dr.mf.cached':          { en: 'Showing the copy saved on this phone — the office cannot be reached right now.',
                             bn: 'এই ফোনে জমা রাখা কপি দেখানো হচ্ছে — এখন অফিসে পৌঁছানো যাচ্ছে না।' },
  'dr.mf.getsOn':          { en: 'Gets on / off',             bn: 'কোথায় ওঠে / নামে' },
  'dr.mf.phone':           { en: 'Phone',                     bn: 'ফোন' },
  'dr.mf.yes':             { en: 'on board',                  bn: 'উঠেছেন' },
  'dr.mf.empty':           { en: 'Nobody has booked this departure.',
                             bn: 'এই বাসে কেউ টিকিট কাটেননি।' },
  'dr.mf.foot':            { en: 'Not everyone gets on at the first stop. The third column says where each passenger joins — somebody boarding at Cumilla is not a no-show in Dhaka.',
                             bn: 'সবাই প্রথম স্টপ থেকে ওঠেন না। তৃতীয় ঘরে লেখা আছে কে কোথা থেকে উঠবেন — কুমিল্লা থেকে ওঠা যাত্রী ঢাকায় অনুপস্থিত নন।' },

  /* ---------------------------------------------------- agent · what sold */
  'ag.bk.title':           { en: 'Tickets you sold',          bn: 'আপনার বিক্রি করা টিকিট' },
  'ag.bk.sub':             { en: 'Newest first',              bn: 'নতুনটি আগে' },
  'ag.bk.passenger':       { en: 'Passenger',                 bn: 'যাত্রী' },
  'ag.bk.departure':       { en: 'Departure',                 bn: 'যে বাস' },
  'ag.bk.fare':            { en: 'Fare',                      bn: 'ভাড়া' },
  'ag.bk.sold':            { en: 'Sold',                      bn: 'বিক্রি' },
  'ag.bk.manage':          { en: 'Open',                      bn: 'দেখুন' },
  'ag.bk.empty':           { en: 'You have not sold anything yet.',
                             bn: 'আপনি এখনো কিছু বিক্রি করেননি।' },

  /* ----------------------------------------------------- agent · earnings */
  'ag.cm.sub':             { en: 'Credited to your wallet as each ticket is issued, never as a lump sum at the end of the month',
                             bn: 'প্রতিটি টিকিট হওয়ার সাথে সাথেই আপনার ওয়ালেটে জমা হয়, মাসের শেষে একসাথে নয়' },
  'ag.cm.earned':          { en: 'Earned so far',             bn: 'এ পর্যন্ত পেয়েছেন' },
  'ag.cm.tickets':         { en: 'Tickets',                   bn: 'টিকিট' },
  'ag.cm.average':         { en: 'Average per ticket',        bn: 'টিকিট প্রতি গড়' },
  'ag.cm.rule':            { en: 'Worked out as',             bn: 'যেভাবে হিসাব' },
  'ag.cm.pct':             { en: '{pct}% of the fare',        bn: 'ভাড়ার {pct}%' },
  'ag.cm.flat':            { en: 'A fixed amount',            bn: 'নির্দিষ্ট টাকা' },
  'ag.cm.empty':           { en: 'No commission yet.',        bn: 'এখনো কোনো কমিশন নেই।' },
  'ag.cm.foot':            { en: 'When several rules could apply, the most specific one wins: a rule naming both your agency and the operator beats one naming only the operator.',
                             bn: 'একাধিক নিয়ম খাটলে সবচেয়ে নির্দিষ্টটিই চলে: আপনার এজেন্সি ও অপারেটর দুটোরই নাম আছে এমন নিয়ম, শুধু অপারেটরের নাম থাকা নিয়মকে হারিয়ে দেয়।' },

  /* ----------------------------------------------------- agent · top-ups */
  'ag.rc.sub':             { en: 'Send the money, write it down here, and finance confirms it separately',
                             bn: 'টাকা পাঠান, এখানে লিখে রাখুন, ফাইন্যান্স আলাদাভাবে মিলিয়ে দেখবে' },
  'ag.rc.formTitle':       { en: 'Write down money you have sent',
                             bn: 'যে টাকা পাঠিয়েছেন তা লিখুন' },
  'ag.rc.amount':          { en: 'How much (৳)',              bn: 'কত টাকা (৳)' },
  'ag.rc.sentBy':          { en: 'How you sent it',           bn: 'যেভাবে পাঠিয়েছেন' },
  'ag.rc.bank':            { en: 'Bank transfer',             bn: 'ব্যাংক ট্রান্সফার' },
  'ag.rc.reference':       { en: 'Transaction number',        bn: 'ট্রানজেকশন নম্বর' },
  'ag.rc.submit':          { en: 'Write it down',             bn: 'লিখে রাখুন' },
  'ag.rc.saving':          { en: 'Saving…',                   bn: 'লেখা হচ্ছে…' },
  'ag.rc.saved':           { en: 'Written down. Your balance moves once finance confirms the money arrived.',
                             bn: 'লেখা হয়েছে। ফাইন্যান্স টাকা পৌঁছেছে বলে নিশ্চিত করলেই আপনার ব্যালেন্স বাড়বে।' },
  'ag.rc.fail':            { en: 'It could not be written down.',
                             bn: 'লেখা গেল না।' },
  'ag.rc.note':            { en: 'Writing it here does not add to your balance by itself. Nothing moves until a second person in finance confirms the money landed — and the system will not let one person do both halves.',
                             bn: 'এখানে লিখলেই ব্যালেন্স বাড়ে না। ফাইন্যান্সের অন্য একজন টাকা পৌঁছেছে বলে নিশ্চিত না করা পর্যন্ত কিছুই নড়ে না — আর একই লোক দুটো কাজই করতে চাইলে সিস্টেম তা করতে দেয় না।' },
  'ag.rc.history':         { en: 'Everything you have sent',  bn: 'আপনি যা যা পাঠিয়েছেন' },
  'ag.rc.requested':       { en: 'Written down',              bn: 'যখন লিখেছেন' },
  'ag.rc.agency':          { en: 'Agency',                    bn: 'এজেন্সি' },
  'ag.rc.method':          { en: 'How',                       bn: 'যেভাবে' },
  'ag.rc.by':              { en: 'Written by',                bn: 'লিখেছেন' },
  'ag.rc.approvedBy':      { en: 'Confirmed by',              bn: 'নিশ্চিত করেছেন' },
  'ag.rc.empty':           { en: 'Nothing sent yet.',         bn: 'এখনো কিছু পাঠানো হয়নি।' },

  /* --------------------------------------------------------- staff · door */
  'sl.title':              { en: 'Staff sign in',             bn: 'কর্মীদের সাইন ইন' },
  'sl.sub':                { en: 'Counter, agent, operator, admin, support and crew all sign in here.',
                             bn: 'কাউন্টার, এজেন্ট, অপারেটর, অ্যাডমিন, সাপোর্ট আর বাসের কর্মী — সবাই এখান থেকেই ঢোকেন।' },
  'sl.email':              { en: 'Work email',                bn: 'কাজের ইমেইল' },
  'sl.password':           { en: 'Password',                  bn: 'পাসওয়ার্ড' },
  'sl.code':               { en: 'Six-digit code',            bn: 'ছয় অঙ্কের কোড' },
  'sl.codeHint':           { en: 'From your authenticator app. Each code works once.',
                             bn: 'আপনার অথেনটিকেটর অ্যাপ থেকে। প্রতিটি কোড একবারই চলে।' },
  'sl.signIn':             { en: 'Sign in',                   bn: 'সাইন ইন' },
  'sl.signingIn':          { en: 'Signing in…',               bn: 'ঢোকা হচ্ছে…' },
  'sl.failed':             { en: 'Sign-in did not work.',     bn: 'সাইন ইন হয়নি।' },
  'sl.sessionNote':        { en: 'A session lasts 12 hours. Eight wrong passwords lock the account.',
                             bn: 'একবার ঢুকলে 12 ঘণ্টা থাকা যায়। আটবার ভুল পাসওয়ার্ড দিলে অ্যাকাউন্ট বন্ধ হয়ে যায়।' },
  'sl.demoTitle':          { en: 'Demo accounts — password {password}',
                             bn: 'ডেমো অ্যাকাউন্ট — পাসওয়ার্ড {password}' },
  'sl.demoNote':           { en: 'Fixtures for this local build. Pick one to see how differently the platform behaves for each job.',
                             bn: 'এই লোকাল বিল্ডের নমুনা অ্যাকাউন্ট। একেকটি বেছে দেখুন প্রতিটি দায়িত্বে সিস্টেম কত আলাদাভাবে চলে।' },
  'sl.back':               { en: 'Back to the passenger site', bn: 'যাত্রীদের সাইটে ফিরুন' },

  /* -------------------------------------------------------------- amenities */
  'amenity.WIFI':          { en: 'Wi-Fi',                    bn: 'ওয়াই-ফাই' },
  'amenity.CHARGING':      { en: 'Charging point',           bn: 'চার্জিং পয়েন্ট' },
  'amenity.WATER':         { en: 'Water bottle',             bn: 'পানির বোতল' },
  'amenity.BLANKET':       { en: 'Blanket',                  bn: 'কম্বল' },
  'amenity.SNACK':         { en: 'Snack',                    bn: 'হালকা খাবার' },
} satisfies Record<string, Entry>;

export type Key = keyof typeof S;

/* --------------------------------------------------------------- formatting */

/**
 * Bangla month and weekday names, kept here rather than delegated to
 * Intl.DateTimeFormat('bn-BD') because that returns Bengali numerals for the day
 * of the month, which would put ২৩ next to a Latin fare on the same card.
 */
const BN_MONTH = ['জানু', 'ফেব্রু', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
                  'জুলাই', 'আগস্ট', 'সেপ্ট', 'অক্টো', 'নভে', 'ডিসে'];
const BN_WEEKDAY = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];

const DHAKA = 'Asia/Dhaka';

/** Interpolates {placeholders}. Missing values are left visible rather than blank. */
function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, k) =>
    k in vars ? String(vars[k]) : whole);
}

/** A bound translator. `t('nav.search')`, `t('pay.pay', { amount: '৳1,200' })`. */
export type T = (key: Key, vars?: Record<string, string | number>) => string;

export function translator(lang: Lang): T {
  return (key, vars) => fill(S[key][lang] ?? S[key].en, vars);
}

/* ------------------------------------------------------- localised datetime */

/** Parts of a Dhaka-local date, script-independent. */
function dhakaParts(iso: string) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: DHAKA, weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return {
    day: Number(get('day')),
    month: Number(get('month')) - 1,
    year: Number(get('year')),
    // en-GB weekday short, converted to an index we can look up in Bangla.
    weekdayIdx: new Date(
      Number(get('year')), Number(get('month')) - 1, Number(get('day'))).getDay(),
  };
}

/** "Sat, 16 Aug" / "শনি, 16 আগস্ট" — Bangla words, Latin figures. */
export function dateIn(lang: Lang, iso: string): string {
  const p = dhakaParts(iso);
  if (lang === 'bn') {
    return `${BN_WEEKDAY[p.weekdayIdx]}, ${p.day} ${BN_MONTH[p.month]}`;
  }
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: DHAKA,
  });
}

/** 24-hour clock in both languages — universally read, and unambiguous at 1am. */
export function timeIn(_lang: Lang, iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: DHAKA,
  });
}

/** "5h 30m" / "5ঘ 30মি" */
export function durationIn(lang: Lang, minutes: number): string {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const [hu, mu] = lang === 'bn' ? ['ঘ', 'মি'] : ['h', 'm'];
  if (!h) return `${m}${mu}`;
  return m ? `${h}${hu} ${m}${mu}` : `${h}${hu}`;
}

/**
 * Money. The taka sign and Latin figures in both languages — a fare is read off
 * the same board by both kinds of reader, and grouping stays en-BD so 1,200 does
 * not become 1200 in one language and ১,২০০ in the other.
 */
export function takaIn(_lang: Lang, poisha: number, opts: { decimals?: boolean } = {}): string {
  const v = poisha / 100;
  return '৳' + v.toLocaleString('en-BD', {
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
  });
}

/** Today / Tomorrow / a date, in the reader's language. */
export function relativeDayIn(lang: Lang, iso: string): string {
  const t = translator(lang);
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: DHAKA }).format(new Date());
  const then = new Intl.DateTimeFormat('en-CA', { timeZone: DHAKA }).format(new Date(iso));
  const days = Math.round((Date.parse(then) - Date.parse(now)) / 864e5);
  if (days === 0) return t('common.today');
  if (days === 1) return t('common.tomorrow');
  if (days === -1) return t('common.yesterday');
  return dateIn(lang, iso);
}

export const STRINGS = S;

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
  'search.sortPrice':      { en: 'Fare',                     bn: 'ভাড়া' },
  'search.sortDuration':   { en: 'Journey time',             bn: 'যাত্রার সময়' },
  'search.sortSeats':      { en: 'Seats free',               bn: 'খালি আসন' },

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

  /* ----------------------------------------------------------------- money */
  'money.fare':            { en: 'Fare',                     bn: 'ভাড়া' },
  'money.fares':           { en: 'Seat fares',               bn: 'আসনের ভাড়া' },
  'money.serviceFee':      { en: 'Service charge',           bn: 'সার্ভিস চার্জ' },
  'money.discount':        { en: 'Discount',                 bn: 'ছাড়' },
  'money.coupon':          { en: 'Coupon',                   bn: 'কুপন' },
  'money.couponApply':     { en: 'Apply',                    bn: 'প্রয়োগ করুন' },
  'money.couponPlaceholder': { en: 'Coupon code',            bn: 'কুপন কোড' },
  'money.total':           { en: 'Total payable',            bn: 'মোট দিতে হবে' },
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

  /* ------------------------------------------------------------ seat types */
  'seatType.NORMAL':          { en: 'Standard',              bn: 'সাধারণ' },
  'seatType.BUSINESS':        { en: 'Business',              bn: 'বিজনেস' },
  'seatType.SLEEPER':         { en: 'Sleeper berth',         bn: 'স্লিপার' },
  'seatType.PREMIUM':         { en: 'Premium',               bn: 'প্রিমিয়াম' },
  'seatType.FEMALE_RESERVED': { en: 'Reserved for women',    bn: 'মহিলাদের জন্য সংরক্ষিত' },
  'seatType.ACCESSIBLE':      { en: 'Accessible',            bn: 'প্রতিবন্ধী-বান্ধব' },
  'seatType.BLOCKED':         { en: 'Not for sale',          bn: 'বিক্রির জন্য নয়' },
  'seatType.CREW':            { en: 'Crew',                  bn: 'স্টাফ' },

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

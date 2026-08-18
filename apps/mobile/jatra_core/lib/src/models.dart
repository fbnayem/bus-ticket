// The shapes the platform returns.
//
// Every money field is an integer of poisha, never a double. A fare is
// 120000 poisha, not 1200.0 taka — the plan is explicit that no float touches
// money anywhere, and a rounding error in a currency is not a display bug, it
// is a missing taka in somebody's drawer at closing time.

import 'i18n.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
String _str(Object? v) => v == null ? '' : '$v';
bool _bool(Object? v) => v == true;
List<String> _strs(Object? v) =>
    v is List ? v.map((e) => '$e').toList(growable: false) : const [];

class Place {
  Place(this.id, this.name, this.kind,
      {this.nameBn = '', this.parent = '', this.served = true});
  factory Place.fromJson(Map<String, dynamic> j) => Place(
        _str(j['id']),
        _str(j['name']),
        _str(j['kind']),
        nameBn: _str(j['name_bn']),
        // The district above a terminal, or the division above a district.
        // Blank when it would only repeat the name.
        parent: _str(j['parent']),
        // Whether any trip on the rolling horizon starts or ends here. Places
        // we do not serve are still offered — somebody whose own district
        // exists should find it — but the field says so instead of returning
        // an empty result page after they have committed to it.
        served: j['served'] == null ? true : _bool(j['served']),
      );
  final String id, name, kind, nameBn, parent;
  final bool served;

  bool get isTerminal => kind == 'TERMINAL';

  /// What to put in front of a reader, in their own language, falling back to
  /// whichever name exists.
  String label(bool bangla) =>
      bangla ? (nameBn.isNotEmpty ? nameBn : name) : (name.isNotEmpty ? name : nameBn);

  /// The other language's name, for the line beside it — empty when there is
  /// only one name, so the row does not render a duplicate.
  String alt(bool bangla) {
    final other = bangla ? name : nameBn;
    return other == label(bangla) ? '' : other;
  }
}

class TripSummary {
  TripSummary.fromJson(Map<String, dynamic> j)
      : tripId = _str(j['trip_id']),
        brand = _str(j['brand']),
        busType = _str(j['bus_type']),
        isAc = _bool(j['is_ac']),
        seatClass = _str(j['class']),
        registration = _str(j['registration']),
        departAt = _str(j['depart_at']),
        arriveAt = _str(j['arrive_at']),
        durationMin = _int(j['duration_min']),
        boardSeq = _int(j['board_seq']),
        dropSeq = _int(j['drop_seq']),
        origin = _str(j['origin']),
        destination = _str(j['destination']),
        farePoisha = _int(j['fare_poisha']),
        availableSeats = _int(j['available_seats']),
        totalSeats = _int(j['total_seats']),
        amenities = _strs(j['amenities']);

  final String tripId, brand, busType, seatClass, registration;
  final String departAt, arriveAt, origin, destination;
  final bool isAc;
  final int durationMin, boardSeq, dropSeq, farePoisha, availableSeats, totalSeats;
  final List<String> amenities;
}

class Stop {
  Stop.fromJson(Map<String, dynamic> j)
      : seq = _int(j['seq']),
        name = _str(j['name']),
        at = _str(j['at']),
        passed = _bool(j['passed']);
  final int seq;
  final String name, at;
  final bool passed;
}

class TripDetail {
  TripDetail.fromJson(Map<String, dynamic> j)
      : tripId = _str(j['trip_id']),
        brand = _str(j['brand']),
        busType = _str(j['bus_type']),
        isAc = _bool(j['is_ac']),
        seatClass = _str(j['class']),
        registration = _str(j['registration']),
        routeName = _str(j['route_name']),
        departAt = _str(j['depart_at']),
        farePoisha = _int(j['fare_poisha']),
        boardSeq = _int(j['board_seq']),
        dropSeq = _int(j['drop_seq']),
        durationMin = _int(j['duration_min']),
        amenities = _strs(j['amenities']),
        stops = (j['stops'] as List? ?? const [])
            .map((e) => Stop.fromJson(e as Map<String, dynamic>))
            .toList(growable: false);

  final String tripId, brand, busType, seatClass, registration, routeName, departAt;
  final bool isAc;
  final int farePoisha, boardSeq, dropSeq, durationMin;
  final List<String> amenities;
  final List<Stop> stops;
}

/// One physical seat, as the *central inventory* currently sees it.
///
/// Nothing in either app decides this. The app draws what it is told and asks
/// the platform to hold what the passenger tapped; if two people tap the same
/// seat, exactly one hold is granted and it is granted by one conditional
/// UPDATE in the inventory service, not by anything here.
class Seat {
  Seat.fromJson(Map<String, dynamic> j)
      : seatNo = _str(j['seat_no']),
        seatType = _str(j['seat_type']),
        deck = _int(j['deck']),
        row = _int(j['row']),
        col = _int(j['col']),
        available = _bool(j['available']),
        sold = _bool(j['sold']),
        held = _bool(j['held']),
        blocked = _bool(j['blocked']);

  final String seatNo, seatType;
  final int deck, row, col;
  final bool available, sold, held, blocked;

  bool get femaleReserved => seatType == 'FEMALE';
}

class SeatMap {
  SeatMap.fromJson(Map<String, dynamic> j)
      : tripId = _str(j['trip_id']),
        boardSeq = _int(j['board_seq']),
        dropSeq = _int(j['drop_seq']),
        seats = (j['seats'] as List? ?? const [])
            .map((e) => Seat.fromJson(e as Map<String, dynamic>))
            .toList(growable: false);
  final String tripId;
  final int boardSeq, dropSeq;
  final List<Seat> seats;
}

/// The price, frozen at hold time by the server and never recomputed here.
class Price {
  Price.fromJson(Map<String, dynamic> j)
      : farePoisha = _int(j['fare_poisha']),
        seatCount = _int(j['seat_count']),
        basePoisha = _int(j['base_poisha']),
        serviceFeePoisha = _int(j['service_fee_poisha']),
        discountPoisha = _int(j['discount_poisha']),
        totalPoisha = _int(j['total_poisha']),
        couponCode = _str(j['coupon_code']);
  final int farePoisha, seatCount, basePoisha, serviceFeePoisha, discountPoisha, totalPoisha;
  final String couponCode;
}

class Hold {
  Hold.fromJson(Map<String, dynamic> j)
      : holdId = _str(j['hold_id']),
        tripId = _str(j['trip_id']),
        seats = _strs(j['seats']),
        boardSeq = _int(j['board_seq']),
        dropSeq = _int(j['drop_seq']),
        expiresAt = _str(j['expires_at']),
        price = j['price'] == null ? null : Price.fromJson(j['price'] as Map<String, dynamic>);
  final String holdId, tripId, expiresAt;
  final List<String> seats;
  final int boardSeq, dropSeq;
  final Price? price;

  DateTime get expiry => DateTime.tryParse(expiresAt)?.toLocal() ?? DateTime.now();
  Duration get remaining => expiry.difference(DateTime.now());
}

class PassengerDetail {
  PassengerDetail({required this.seatNo, required this.fullName, this.gender, this.age});
  final String seatNo, fullName;
  final String? gender;
  final int? age;

  Map<String, dynamic> toJson() => {
        'seat_no': seatNo,
        'full_name': fullName,
        if (gender != null && gender!.isNotEmpty) 'gender': gender,
        if (age != null && age! > 0) 'age': age,
      };
}

/// Somebody this passenger travels with often enough to have typed once.
///
/// The NID number is held because a bus operator can ask for it at the door,
/// not because the platform needs it. It is only ever read back to the person
/// who saved it — every query behind these is scoped by user_id.
class SavedPassenger {
  SavedPassenger({
    this.id = '',
    required this.fullName,
    this.gender = '',
    this.age = 0,
    this.idType = '',
    this.idNumber = '',
  });

  factory SavedPassenger.fromJson(Map<String, dynamic> j) => SavedPassenger(
        id: _str(j['id']),
        fullName: _str(j['full_name']),
        gender: _str(j['gender']),
        age: _int(j['age']),
        idType: _str(j['id_type']),
        idNumber: _str(j['id_number']),
      );

  final String id, fullName, gender, idType, idNumber;
  final int age;

  Map<String, dynamic> toJson() => {
        'full_name': fullName,
        'gender': gender,
        'age': age,
        'id_type': idType,
        'id_number': idNumber,
      };

  SavedPassenger copyWith({
    String? fullName,
    String? gender,
    int? age,
    String? idType,
    String? idNumber,
  }) =>
      SavedPassenger(
        id: id,
        fullName: fullName ?? this.fullName,
        gender: gender ?? this.gender,
        age: age ?? this.age,
        idType: idType ?? this.idType,
        idNumber: idNumber ?? this.idNumber,
      );
}

class TicketStub {
  TicketStub.fromJson(Map<String, dynamic> j)
      : ticketId = _str(j['ticket_id']),
        seatNo = _str(j['seat_no']),
        qrToken = _str(j['qr_token']),
        status = _str(j['status']),
        passenger = _str(j['passenger']);
  final String ticketId, seatNo, qrToken, status, passenger;

  Map<String, dynamic> toJson() => {
        'ticket_id': ticketId, 'seat_no': seatNo, 'qr_token': qrToken,
        'status': status, 'passenger': passenger,
      };
}

class Booking {
  Booking.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        bookingId = _str(j['booking_id']),
        status = _str(j['status']),
        totalPoisha = _int(j['total_poisha']),
        channel = _str(j['channel']),
        createdAt = _str(j['created_at']),
        tripId = _str(j['trip_id']),
        brand = _str(j['brand']),
        busType = _str(j['bus_type']),
        registration = _str(j['registration']),
        departAt = _str(j['depart_at']),
        origin = _str(j['origin']),
        destination = _str(j['destination']),
        phone = _str(j['phone']),
        seats = _strs(j['seats']),
        tickets = (j['tickets'] as List? ?? const [])
            .map((e) => TicketStub.fromJson(e as Map<String, dynamic>))
            .toList(growable: false),
        raw = j;

  final String pnr, bookingId, status, channel, createdAt, tripId;
  final String brand, busType, registration, departAt, origin, destination, phone;
  final int totalPoisha;
  final List<String> seats;
  final List<TicketStub> tickets;

  /// Kept whole so a cached copy can be rebuilt on a device with no signal
  /// without this class having to be a lossless mirror of the server.
  final Map<String, dynamic> raw;

  DateTime? get departure => DateTime.tryParse(departAt)?.toLocal();
  bool get confirmed => status == 'TICKETED' || status == 'CONFIRMED' || status == 'COMPLETED';
}

class AccountBooking {
  AccountBooking.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        status = _str(j['status']),
        totalPoisha = _int(j['total_poisha']),
        departAt = _str(j['depart_at']),
        brand = _str(j['brand']),
        origin = _str(j['origin']),
        destination = _str(j['destination']),
        seatCount = _int(j['seat_count']),
        upcoming = _bool(j['upcoming']);
  final String pnr, status, departAt, brand, origin, destination;
  final int totalPoisha, seatCount;
  final bool upcoming;
}

class CancellationQuote {
  CancellationQuote.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        totalPoisha = _int(j['total_poisha']),
        hoursBefore = _int(j['hours_before']),
        refundPct = _int(j['refund_pct']),
        refundPoisha = _int(j['refund_poisha']),
        feePoisha = _int(j['fee_poisha']),
        cancellable = _bool(j['cancellable']),
        reason = _str(j['reason']);
  final String pnr, reason;
  final int totalPoisha, hoursBefore, refundPct, refundPoisha, feePoisha;
  final bool cancellable;
}

class Tracking {
  Tracking.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        state = _str(j['state']),
        departAt = _str(j['depart_at']),
        arriveAt = _str(j['arrive_at']),
        progress = _int(j['progress']),
        source = _str(j['source']),
        nextStop = _str(j['next_stop']),
        eta = _str(j['eta']),
        stops = (j['stops'] as List? ?? const [])
            .map((e) => Stop.fromJson(e as Map<String, dynamic>))
            .toList(growable: false);
  final String pnr, state, departAt, arriveAt, source, nextStop, eta;
  final int progress;
  final List<Stop> stops;

  /// Whether the position came from a bus or from a timetable. The passenger is
  /// told which, because "the bus is 20 minutes away" and "the bus is scheduled
  /// to be 20 minutes away" are different promises.
  bool get live => source == 'DRIVER_APP_GPS' || source == 'DEVICE_GPS';
}

class Offer {
  Offer.fromJson(Map<String, dynamic> j)
      : code = _str(j['code']),
        title = _str(j['title']),
        titleBn = _str(j['title_bn']),
        discountPct = _int(j['discount_pct']),
        discountPoisha = _int(j['discount_poisha']),
        maxDiscountPoisha = _int(j['max_discount_poisha']),
        minAmountPoisha = _int(j['min_amount_poisha']),
        endsAt = _str(j['ends_at']);
  final String code, title, titleBn, endsAt;
  final int discountPct, discountPoisha, maxDiscountPoisha, minAmountPoisha;
}

/* ------------------------------------------------------------------- crew */

class CrewTrip {
  CrewTrip.fromJson(Map<String, dynamic> j)
      : tripId = _str(j['trip_id']),
        departAt = _str(j['depart_at']),
        route = _str(j['route']),
        registration = _str(j['registration']),
        status = _str(j['status']),
        // `crew_role`, which is what the platform calls it. Reading `role` here
        // found nothing on every trip, so the pill on every card came out
        // empty and a crew member was never told whether they were driving
        // this one or helping on it — the one thing the card exists to say.
        role = _str(j['crew_role']),
        passengers = _int(j['passengers']),
        boarded = _int(j['boarded']);
  final String tripId, departAt, route, registration, status, role;
  final int passengers, boarded;

  DateTime? get departure => DateTime.tryParse(departAt)?.toLocal();
}

class ManifestPassenger {
  ManifestPassenger.fromJson(Map<String, dynamic> j)
      : seatNo = _str(j['seat_no']),
        pnr = _str(j['pnr']),
        passenger = _str(j['passenger']),
        phone = _str(j['phone']),
        channel = _str(j['channel']),
        ticketStatus = _str(j['ticket_status']),
        from = _str(j['from']),
        to = _str(j['to']);
  final String seatNo, pnr, passenger, phone, channel, ticketStatus, from, to;
  bool get boarded => ticketStatus == 'BOARDED';

  Map<String, dynamic> toJson() => {
        'seat_no': seatNo, 'pnr': pnr, 'passenger': passenger, 'phone': phone,
        'channel': channel, 'ticket_status': ticketStatus, 'from': from, 'to': to,
      };
}

class Manifest {
  Manifest.fromJson(Map<String, dynamic> j)
      : route = _str((j['trip'] as Map?)?['route']),
        operatorName = _str((j['trip'] as Map?)?['operator']),
        registration = _str((j['trip'] as Map?)?['registration']),
        departAt = _str((j['trip'] as Map?)?['depart_at']),
        status = _str((j['trip'] as Map?)?['status']),
        total = _int(j['total']),
        boarded = _int(j['boarded']),
        passengers = (j['passengers'] as List? ?? const [])
            .map((e) => ManifestPassenger.fromJson(e as Map<String, dynamic>))
            .toList(growable: false),
        raw = j;

  final String route, operatorName, registration, departAt, status;
  final int total, boarded;
  final List<ManifestPassenger> passengers;
  final Map<String, dynamic> raw;
}

/// The verdict on a boarding check.
///
/// [queued] means this device decided it against the list it downloaded before
/// leaving, and the platform has not confirmed it yet. The crew is told so
/// plainly; a provisional yes is never dressed up as a confirmed one.
class ScanVerdict {
  ScanVerdict({
    required this.result,
    required this.seatNo,
    required this.pnr,
    required this.message,
    this.passenger = '',
    this.queued = false,
  });

  factory ScanVerdict.fromJson(Map<String, dynamic> j, {bool queued = false}) => ScanVerdict(
        result: _str(j['result']),
        seatNo: _str(j['seat_no']),
        pnr: _str(j['pnr']),
        message: _str(j['message']),
        passenger: _str(j['passenger']),
        queued: queued,
      );

  final String result, seatNo, pnr, message, passenger;
  final bool queued;

  bool get letThemOn => result == 'BOARDED';
  bool get alreadyOn => result == 'ALREADY_BOARDED';

  /// The sentence the crew reads at the door.
  ///
  /// Keyed on [result], which is a platform constant and means the same in
  /// every language, rather than on [message], which the platform writes in
  /// English. It used to be shown verbatim, so the crew app spoke Bangla until
  /// the moment it had a verdict — and then said "This ticket was cancelled. Do
  /// not board." in English, to the person who has half a second to act on it.
  ///
  /// A queued verdict keeps its own words. Those were built on this device in
  /// the reader's language and they say the one thing no catalogue entry here
  /// can: that the check is written down but the office has not confirmed it.
  String words(L l) {
    if (queued) return message;
    final key = 'sc.msg.$result';
    if (kStrings.containsKey(key)) return l(key, {'seat': seatNo});
    return message.isNotEmpty ? message : l('sc.msg.UNKNOWN');
  }
}

class Incident {
  Incident.fromJson(Map<String, dynamic> j)
      : incidentId = _str(j['incident_id']),
        kind = _str(j['kind']),
        severity = _str(j['severity']),
        note = _str(j['note']),
        createdAt = _str(j['created_at']),
        reportedBy = _str(j['reported_by']),
        route = _str(j['route']),
        departAt = _str(j['depart_at']);
  final String incidentId, kind, severity, note, createdAt, reportedBy, route, departAt;
}

class StaffIdentity {
  StaffIdentity.fromJson(Map<String, dynamic> j)
      : staffId = _str(j['staff_id']),
        email = _str(j['email']),
        fullName = _str(j['full_name']),
        operatorId = _str(j['operator_id']),
        roles = _strs(j['roles']),
        permissions = _strs(j['permissions']);
  final String staffId, email, fullName, operatorId;
  final List<String> roles, permissions;

  bool can(String permission) => permissions.contains(permission);
}

// ============================================================ the on-board sale

/// What a conductor is holding, and how much of it is theirs.
///
/// Three numbers rather than one, deliberately. "Hand over 4,385" on its own is
/// a figure somebody has to take on trust; cash held, minus commission earned,
/// equals what the owner gets is a sum they can check against the notes in
/// their hand at the side of a road.
class DutySummary {
  DutySummary.fromJson(Map<String, dynamic> j)
      : dutyId = _str(j['duty_id']),
        floatPoisha = _int(j['opening_float_poisha']),
        collectedPoisha = _int(j['collected_poisha']),
        expectedPoisha = _int(j['expected_cash_poisha']),
        commissionPoisha = _int(j['commission_poisha']),
        remitPoisha = _int(j['remit_poisha']),
        discountPoisha = _int(j['discount_poisha']),
        salesCount = _int(j['sales_count']);
  final String dutyId;
  final int floatPoisha,
      collectedPoisha,
      expectedPoisha,
      commissionPoisha,
      remitPoisha,
      discountPoisha,
      salesCount;
}

/// A cash bag, open or closed.
class CrewDuty {
  CrewDuty.fromJson(Map<String, dynamic> j)
      : dutyId = _str(j['duty_id']),
        status = _str(j['status']),
        floatPoisha = _int(j['opening_float_poisha']),
        countedPoisha = _int(j['counted_cash_poisha']),
        expectedPoisha = _int(j['expected_cash_poisha']),
        variancePoisha = _int(j['variance_poisha']),
        commissionPoisha = _int(j['commission_poisha']),
        salesCount = _int(j['sales_count']),
        openedAt = _str(j['opened_at']),
        closedAt = _str(j['closed_at']);
  final String dutyId, status, openedAt, closedAt;
  final int floatPoisha,
      countedPoisha,
      expectedPoisha,
      variancePoisha,
      commissionPoisha,
      salesCount;

  bool get open => status == 'OPEN';
  DateTime? get opened => DateTime.tryParse(openedAt)?.toLocal();
}

/// Why a fare was reduced. The list comes from the server because an operator
/// can change it, and a hard-coded list inside an app is a policy nobody can
/// edit without a release.
class DiscountReason {
  DiscountReason.fromJson(Map<String, dynamic> j)
      : code = _str(j['code']),
        label = _str(j['label']),
        labelBn = _str(j['label_bn']),
        maxPctBp = _int(j['max_pct_bp']);
  final String code, label, labelBn;
  final int maxPctBp;

  String labelFor(Lang lang) => lang == Lang.bn && labelBn.isNotEmpty ? labelBn : label;
}

/// What this crew member may do on this bus, decided by the server.
///
/// The app uses it to hide controls. It is not what stops anybody: every field
/// here is checked again on the server when a sale is actually attempted.
class SellContext {
  SellContext.fromJson(Map<String, dynamic> j)
      : crewRole = _str(j['crew_role']),
        operatorBrand = _str(j['operator_brand']),
        maySell = _bool(j['may_sell']),
        mayDiscount = _bool(j['may_discount']),
        maxPctBp = _int(j['max_pct_bp']),
        maxAmountPoisha = _int(j['max_amount_poisha']),
        serviceFeePoisha = _int(j['service_fee_poisha']),
        commissionBp = _int(j['commission_bp']),
        commissionFlatPoisha = _int(j['commission_flat_poisha']),
        dutyId = _str(j['duty_id']),
        duty = j['duty'] == null
            ? null
            : DutySummary.fromJson(j['duty'] as Map<String, dynamic>),
        reasons = (j['reasons'] as List? ?? const [])
            .map((e) => DiscountReason.fromJson(e as Map<String, dynamic>))
            .toList(growable: false);
  final String crewRole, dutyId, operatorBrand;
  final bool maySell, mayDiscount;
  final int maxPctBp, maxAmountPoisha, serviceFeePoisha;
  final int commissionBp, commissionFlatPoisha;
  final DutySummary? duty;
  final List<DiscountReason> reasons;

  bool get onDuty => dutyId.isNotEmpty;

  /// What this sale earns before any discount, under the rule the server says
  /// will actually settle it.
  ///
  /// Resolved server-side rather than assumed here: a preview computed from a
  /// hardcoded rate agrees with the receipt right up until an operator
  /// configures anything but the default, and then disagrees silently.
  int commissionOn(int fullPoisha) {
    if (commissionFlatPoisha > 0) return commissionFlatPoisha;
    return (fullPoisha - serviceFeePoisha) * commissionBp ~/ 10000;
  }

  /// What a discount of [discountPoisha] leaves them, and what it took.
  /// The floor at zero is the server's rule, mirrored so the screen can show it.
  (int gross, int forfeit, int net) commissionAfter(int fullPoisha, int discountPoisha) {
    final gross = commissionOn(fullPoisha);
    final forfeit = discountPoisha > gross ? gross : discountPoisha;
    return (gross, forfeit, gross - forfeit);
  }

  /// The most that may come off this fare, by the same three-way minimum the
  /// server applies. Computed here so the ceiling can be shown BEFORE the sale:
  /// finding out a discount was refused after telling a passenger a price is
  /// the one outcome this screen exists to prevent.
  int capFor(int fullPoisha, {DiscountReason? reason}) {
    if (!mayDiscount) return 0;
    var cap = fullPoisha * maxPctBp ~/ 10000;
    if (maxAmountPoisha > 0 && maxAmountPoisha < cap) cap = maxAmountPoisha;
    if (reason != null && reason.maxPctBp > 0) {
      final rc = fullPoisha * reason.maxPctBp ~/ 10000;
      if (rc < cap) cap = rc;
    }
    return cap < 0 ? 0 : cap;
  }
}

/// One ticket this crew member sold.
class CrewSaleRow {
  CrewSaleRow.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        status = _str(j['status']),
        route = _str(j['route']),
        seats = _str(j['seats']),
        phone = _str(j['phone']),
        discountReason = _str(j['discount_reason']),
        totalPoisha = _int(j['total_poisha']),
        discountPoisha = _int(j['discount_poisha']),
        commissionPoisha = _int(j['commission_poisha']),
        createdAt = _str(j['created_at']),
        departAt = _str(j['depart_at']);
  final String pnr, status, route, seats, phone, discountReason, createdAt, departAt;
  final int totalPoisha, discountPoisha, commissionPoisha;

  DateTime? get sold => DateTime.tryParse(createdAt)?.toLocal();
  DateTime? get departure => DateTime.tryParse(departAt)?.toLocal();
}

/// A period of takings.
class CrewPeriod {
  CrewPeriod.fromJson(Map<String, dynamic>? j)
      : salesCount = _int(j?['sales_count']),
        grossPoisha = _int(j?['gross_poisha']),
        discountPoisha = _int(j?['discount_poisha']),
        commissionPoisha = _int(j?['commission_poisha']),
        handoverPoisha = _int(j?['handover_poisha']);
  final int salesCount, grossPoisha, discountPoisha, commissionPoisha;

  /// Cash taken this period, less the share that is theirs.
  ///
  /// The answer to "what do I owe" when no cash bag is being counted. With a
  /// bag open, [DutySummary.remitPoisha] is the better answer because it also
  /// knows the opening float; without one, this is bounded by the period rather
  /// than accumulating forever.
  final int handoverPoisha;
}

/// One bus run, with its own numbers, sealed when that run ended.
class CrewTripTotals {
  CrewTripTotals.fromJson(Map<String, dynamic> j)
      : tripId = _str(j['trip_id']),
        route = _str(j['route']),
        departAt = _str(j['depart_at']),
        salesCount = _int(j['sales_count']),
        grossPoisha = _int(j['gross_poisha']),
        discountPoisha = _int(j['discount_poisha']),
        commissionPoisha = _int(j['commission_poisha']),
        closedAt = _str(j['closed_at']);
  final String tripId, route, departAt, closedAt;
  final int salesCount, grossPoisha, discountPoisha, commissionPoisha;

  DateTime? get departure => DateTime.tryParse(departAt)?.toLocal();
  bool get closed => closedAt.isNotEmpty;
}

class CrewReport {
  CrewReport.fromJson(Map<String, dynamic> j)
      : today = CrewPeriod.fromJson(j['today'] as Map<String, dynamic>?),
        week = CrewPeriod.fromJson(j['week'] as Map<String, dynamic>?),
        duty = j['duty'] == null
            ? null
            : DutySummary.fromJson(j['duty'] as Map<String, dynamic>),
        trips = (j['trips'] as List? ?? const [])
            .map((e) => CrewTripTotals.fromJson(e as Map<String, dynamic>))
            .toList(growable: false);
  final CrewPeriod today, week;
  final DutySummary? duty;
  final List<CrewTripTotals> trips;
}

/// What one sale earned, and what a discount cost.
///
/// Both numbers are kept because only the pair explains itself: 15 taka tells a
/// conductor nothing; 40 earned and 25 given away tells them everything.
class CrewCommissionRow {
  CrewCommissionRow.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        grossPoisha = _int(j['gross_poisha']),
        forfeitPoisha = _int(j['forfeit_poisha']),
        amountPoisha = _int(j['amount_poisha']),
        discountReason = _str(j['discount_reason']),
        createdAt = _str(j['created_at']);
  final String pnr, discountReason, createdAt;
  final int grossPoisha, forfeitPoisha, amountPoisha;

  DateTime? get earned => DateTime.tryParse(createdAt)?.toLocal();
}

/// The receipt for an on-board sale.
class CrewSaleResult {
  CrewSaleResult.fromJson(Map<String, dynamic> j)
      : pnr = _str(j['pnr']),
        bookingId = _str(j['booking_id']),
        seats = _strs(j['seats']),
        fullPoisha = _int(j['full_poisha']),
        discountPoisha = _int(j['discount_poisha']),
        totalPoisha = _int(j['total_poisha']),
        commissionPoisha = _int(j['commission_poisha']),
        forfeitPoisha = _int(j['forfeit_poisha']);
  final String pnr, bookingId;
  final List<String> seats;
  final int fullPoisha, discountPoisha, totalPoisha, commissionPoisha, forfeitPoisha;
}

/// Where this account is signed in.
class StaffSessionInfo {
  StaffSessionInfo.fromJson(Map<String, dynamic> j)
      : sessionId = _str(j['session_id']),
        current = _bool(j['current']),
        issuedAt = _str(j['issued_at']),
        userAgent = _str(j['user_agent']),
        ip = _str(j['ip']);
  final String sessionId, issuedAt, userAgent, ip;
  final bool current;

  DateTime? get issued => DateTime.tryParse(issuedAt)?.toLocal();
}

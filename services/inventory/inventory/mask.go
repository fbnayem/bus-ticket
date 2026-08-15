package inventory

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
)

// MaxSegments is bounded by the signed 64-bit column that stores the masks.
const MaxSegments = 62

var (
	// ErrSeatUnavailable means at least one requested seat was already held,
	// sold or blocked on at least one requested segment. The hold is all-or-nothing:
	// when this is returned, zero seats were taken.
	ErrSeatUnavailable = errors.New("inventory: seat unavailable for requested segments")
	ErrHoldNotFound    = errors.New("inventory: hold not found")
	ErrHoldNotActive   = errors.New("inventory: hold is not in HELD state")
	ErrHoldExpired     = errors.New("inventory: hold expired")
	ErrHoldLost        = errors.New("inventory: hold no longer owns its segments")
	ErrBadSegments     = errors.New("inventory: invalid segment range")
)

// SegmentMask converts a journey (boarding stop -> dropping stop) into the set
// of segment ordinals it occupies.
//
// Stops are 0-based and dense, so a journey from stop b to stop d occupies
// segments b, b+1, ... d-1:
//
//	mask(b,d) = (1<<d) - (1<<b)
//
// On the spec's Dhaka(0) -> Cumilla(1) -> Feni(2) -> Chattogram(3) route:
//
//	Dhaka->Cumilla      mask(0,1) = 0b001
//	Cumilla->Chattogram mask(1,3) = 0b110   -> AND = 0, both sell on one seat
//	Dhaka->Feni         mask(0,2) = 0b011
//	                    0b011 & 0b110 = 0b010 != 0 -> overlap, exactly one wins
//
// Segment resale is therefore an arithmetic property, not application logic.
func SegmentMask(boardSeq, dropSeq int) (int64, error) {
	if boardSeq < 0 || dropSeq <= boardSeq || dropSeq > MaxSegments {
		return 0, fmt.Errorf("%w: board=%d drop=%d", ErrBadSegments, boardSeq, dropSeq)
	}
	return int64(1)<<uint(dropSeq) - int64(1)<<uint(boardSeq), nil
}

// Overlaps reports whether two journeys contend for any common segment.
func Overlaps(a, b int64) bool { return a&b != 0 }

// newUUID returns a RFC 4122 version 4 UUID string. Generating it in-process
// (rather than a round trip to gen_random_uuid) lets the hot path attempt the
// seat acquisition BEFORE writing any hold rows, so a losing contender in a
// stampede costs one failed UPDATE and nothing else.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	s := hex.EncodeToString(b[:])
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32], nil
}

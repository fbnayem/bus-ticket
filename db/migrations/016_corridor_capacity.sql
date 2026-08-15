-- 016_corridor_capacity.sql — a second Green Line departure.
--
-- Green Line ran one bus a day on Dhaka–Chattogram, which is both unrealistic
-- for the busiest corridor in the country and a practical problem: the browser
-- suites sell real tickets on that departure every time they run, and forty
-- seats is about five runs.
--
-- Two buses and two departures is the honest fix. Widening the fixture is
-- better than teaching the tests to tolerate a full bus, because a full bus is
-- exactly the condition they exist to exercise elsewhere.
--
-- valid_from is deliberately not pinned to a seeded date: this migration is
-- also applied to databases that have been running for a while, and a schedule
-- that starts in the past generates nothing.

SET client_min_messages = warning;

INSERT INTO catalog.buses (bus_id, operator_id, registration, bus_type_id, layout_id, status)
VALUES ('d0000000-0000-0000-0000-000000000011',
        '11111111-1111-1111-1111-111111111111',
        'DHAKA METRO-B-11-7788',
        'b0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000001',
        'ACTIVE')
ON CONFLICT (bus_id) DO NOTHING;

INSERT INTO catalog.bus_amenities (bus_id, amenity)
SELECT 'd0000000-0000-0000-0000-000000000011', a.amenity
  FROM (VALUES ('WIFI'),('CHARGING'),('WATER'),('BLANKET')) AS a(amenity)
ON CONFLICT DO NOTHING;

-- A morning departure alongside the existing 22:00, on the same multi-stop
-- route, so the segment cases still apply to both.
INSERT INTO catalog.schedules (schedule_id, operator_id, route_id, bus_id, depart_local, days_mask, valid_from)
VALUES ('f0000000-0000-0000-0000-000000000011',
        '11111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-000000000001',
        'd0000000-0000-0000-0000-000000000011',
        '08:30:00', 127, current_date - 1)
ON CONFLICT (schedule_id) DO NOTHING;

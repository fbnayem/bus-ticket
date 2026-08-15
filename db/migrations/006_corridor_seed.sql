-- 006_corridor_seed.sql — enough operators, buses and departures for the
-- passenger web app to look and behave like a real marketplace.

SET client_min_messages = warning;

-- Extra cities so search has more than one corridor.
INSERT INTO catalog.locations (location_id, kind, name, lat, lng) VALUES
    ('a0000000-0000-0000-0000-000000000005', 'CITY', 'Sylhet',     24.894929, 91.868706),
    ('a0000000-0000-0000-0000-000000000006', 'CITY', 'Narsingdi',  23.920840, 90.718290),
    ('a0000000-0000-0000-0000-000000000007', 'CITY', 'Cox''s Bazar', 21.427229, 92.005806);

INSERT INTO catalog.location_aliases (alias, location_id) VALUES
    ('sylhet', 'a0000000-0000-0000-0000-000000000005'),
    ('slt',    'a0000000-0000-0000-0000-000000000005'),
    ('narsingdi', 'a0000000-0000-0000-0000-000000000006'),
    ('coxs bazar', 'a0000000-0000-0000-0000-000000000007'),
    ('cox''s bazar', 'a0000000-0000-0000-0000-000000000007'),
    ('cxb',    'a0000000-0000-0000-0000-000000000007');

-- Four more operators.
INSERT INTO catalog.operators (operator_id, legal_name, brand, status) VALUES
    ('11111111-1111-1111-1111-111111111112', 'Shohagh Paribahan Ltd',  'Shohagh',   'ACTIVE'),
    ('11111111-1111-1111-1111-111111111113', 'Hanif Enterprise',       'Hanif',     'ACTIVE'),
    ('11111111-1111-1111-1111-111111111114', 'Ena Transport Pvt Ltd',  'Ena',       'ACTIVE'),
    ('11111111-1111-1111-1111-111111111115', 'Saudia Coach Service',   'Saudia S.', 'ACTIVE');

INSERT INTO catalog.bus_types (bus_type_id, name, is_ac, class) VALUES
    ('b0000000-0000-0000-0000-000000000002', 'AC Economy',   true,  'ECONOMY'),
    ('b0000000-0000-0000-0000-000000000003', 'Non-AC Chair', false, 'ECONOMY'),
    ('b0000000-0000-0000-0000-000000000004', 'AC Sleeper',   true,  'SLEEPER');

-- Layouts: a 36-seat 2x2, a 40-seat non-AC, and a 24-berth sleeper.
INSERT INTO catalog.seat_layouts (layout_id, operator_id, name, version, decks, frozen) VALUES
    ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111112', 'AC Economy 2x2 36', 1, 1, true),
    ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111113', 'Non-AC Chair 40',   1, 1, true),
    ('c0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111114', 'AC Sleeper 24',     1, 2, true),
    ('c0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111115', 'AC Business 40',    1, 1, true);

INSERT INTO catalog.seat_layout_items (layout_id, seat_no, deck, row_idx, col_idx, seat_type, fare_class)
SELECT 'c0000000-0000-0000-0000-000000000002', chr(65+r)||c::text, 1, r, c, 'NORMAL', 'BASE'
  FROM generate_series(0,8) r, generate_series(1,4) c;

INSERT INTO catalog.seat_layout_items (layout_id, seat_no, deck, row_idx, col_idx, seat_type, fare_class)
SELECT 'c0000000-0000-0000-0000-000000000003', chr(65+r)||c::text, 1, r, c,
       CASE WHEN r >= 8 THEN 'FEMALE_RESERVED' ELSE 'NORMAL' END, 'BASE'
  FROM generate_series(0,9) r, generate_series(1,4) c;

-- Sleeper: two decks, two berths per row per deck.
INSERT INTO catalog.seat_layout_items (layout_id, seat_no, deck, row_idx, col_idx, seat_type, fare_class)
SELECT 'c0000000-0000-0000-0000-000000000004',
       CASE WHEN d = 1 THEN 'L' ELSE 'U' END || chr(65+r) || c::text,
       d, r, c, 'SLEEPER', 'BASE'
  FROM generate_series(1,2) d, generate_series(0,5) r, generate_series(1,2) c;

INSERT INTO catalog.seat_layout_items (layout_id, seat_no, deck, row_idx, col_idx, seat_type, fare_class)
SELECT 'c0000000-0000-0000-0000-000000000005', chr(65+r)||c::text, 1, r, c,
       CASE WHEN r = 0 THEN 'BUSINESS' ELSE 'NORMAL' END, 'BASE'
  FROM generate_series(0,9) r, generate_series(1,4) c;

INSERT INTO catalog.buses (bus_id, operator_id, registration, bus_type_id, layout_id) VALUES
    ('d0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111112', 'DHAKA METRO-B-12-3344', 'b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002'),
    ('d0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111113', 'DHAKA METRO-B-13-4455', 'b0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003'),
    ('d0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111114', 'DHAKA METRO-B-14-5566', 'b0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004'),
    ('d0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111115', 'DHAKA METRO-B-15-6677', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000005');

-- Each operator runs the same 4-stop Chattogram corridor, so segment inventory
-- is exercised across every operator in the marketplace.
INSERT INTO catalog.routes (route_id, operator_id, name) VALUES
    ('e0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111112', 'Dhaka - Chattogram (Shohagh)'),
    ('e0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111113', 'Dhaka - Chattogram (Hanif)'),
    ('e0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111114', 'Dhaka - Chattogram (Ena)'),
    ('e0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111115', 'Dhaka - Sylhet (Saudia)');

INSERT INTO catalog.route_stops (route_id, stop_seq, location_id)
SELECT r.route_id, s.stop_seq, s.location_id
  FROM (VALUES
        ('e0000000-0000-0000-0000-000000000002'::uuid),
        ('e0000000-0000-0000-0000-000000000003'::uuid),
        ('e0000000-0000-0000-0000-000000000004'::uuid)) AS r(route_id),
       (VALUES (0,'a0000000-0000-0000-0000-000000000001'::uuid),
               (1,'a0000000-0000-0000-0000-000000000002'::uuid),
               (2,'a0000000-0000-0000-0000-000000000003'::uuid),
               (3,'a0000000-0000-0000-0000-000000000004'::uuid)) AS s(stop_seq, location_id);

-- Sylhet corridor: Dhaka -> Narsingdi -> Sylhet (2 segments).
INSERT INTO catalog.route_stops (route_id, stop_seq, location_id) VALUES
    ('e0000000-0000-0000-0000-000000000005', 0, 'a0000000-0000-0000-0000-000000000001'),
    ('e0000000-0000-0000-0000-000000000005', 1, 'a0000000-0000-0000-0000-000000000006'),
    ('e0000000-0000-0000-0000-000000000005', 2, 'a0000000-0000-0000-0000-000000000005');

-- Fares for every segment pair on each Chattogram route, scaled per operator.
INSERT INTO catalog.route_fares (route_id, from_stop_seq, to_stop_seq, fare_class, amount_poisha)
SELECT r.route_id, p.f, p.t, 'BASE', (p.base * r.mult)::bigint
  FROM (VALUES
        ('e0000000-0000-0000-0000-000000000002'::uuid, 0.95),
        ('e0000000-0000-0000-0000-000000000003'::uuid, 0.70),
        ('e0000000-0000-0000-0000-000000000004'::uuid, 1.35)) AS r(route_id, mult),
       (VALUES (0,1,45000),(1,2,35000),(2,3,40000),
               (0,2,75000),(1,3,70000),(0,3,115000)) AS p(f,t,base);

INSERT INTO catalog.route_fares (route_id, from_stop_seq, to_stop_seq, fare_class, amount_poisha) VALUES
    ('e0000000-0000-0000-0000-000000000005', 0, 1, 'BASE',  30000),
    ('e0000000-0000-0000-0000-000000000005', 1, 2, 'BASE',  55000),
    ('e0000000-0000-0000-0000-000000000005', 0, 2, 'BASE',  80000);

-- Departures across the day so the results page has something to sort and filter.
INSERT INTO catalog.schedules (schedule_id, operator_id, route_id, bus_id, depart_local, days_mask, valid_from) VALUES
    ('f0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111112','e0000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-000000000002','07:30',127,CURRENT_DATE),
    ('f0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111112','e0000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-000000000002','14:15',127,CURRENT_DATE),
    ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111113','e0000000-0000-0000-0000-000000000003','d0000000-0000-0000-0000-000000000003','06:00',127,CURRENT_DATE),
    ('f0000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111113','e0000000-0000-0000-0000-000000000003','d0000000-0000-0000-0000-000000000003','23:45',127,CURRENT_DATE),
    ('f0000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111114','e0000000-0000-0000-0000-000000000004','d0000000-0000-0000-0000-000000000004','21:00',127,CURRENT_DATE),
    ('f0000000-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111115','e0000000-0000-0000-0000-000000000005','d0000000-0000-0000-0000-000000000005','22:30',127,CURRENT_DATE);

-- Amenities drive the results-page filters.
CREATE TABLE IF NOT EXISTS catalog.bus_amenities (
    bus_id  uuid NOT NULL REFERENCES catalog.buses(bus_id) ON DELETE CASCADE,
    amenity text NOT NULL,
    PRIMARY KEY (bus_id, amenity)
);

INSERT INTO catalog.bus_amenities (bus_id, amenity) VALUES
    ('d0000000-0000-0000-0000-000000000001','WIFI'),
    ('d0000000-0000-0000-0000-000000000001','CHARGING'),
    ('d0000000-0000-0000-0000-000000000001','WATER'),
    ('d0000000-0000-0000-0000-000000000001','BLANKET'),
    ('d0000000-0000-0000-0000-000000000002','CHARGING'),
    ('d0000000-0000-0000-0000-000000000002','WATER'),
    ('d0000000-0000-0000-0000-000000000003','WATER'),
    ('d0000000-0000-0000-0000-000000000004','WIFI'),
    ('d0000000-0000-0000-0000-000000000004','CHARGING'),
    ('d0000000-0000-0000-0000-000000000004','BLANKET'),
    ('d0000000-0000-0000-0000-000000000004','SNACK'),
    ('d0000000-0000-0000-0000-000000000005','WIFI'),
    ('d0000000-0000-0000-0000-000000000005','CHARGING');

-- Approximate segment durations, used for arrival times and trip duration.
CREATE TABLE IF NOT EXISTS catalog.route_segment_minutes (
    route_id      uuid NOT NULL REFERENCES catalog.routes(route_id) ON DELETE CASCADE,
    from_stop_seq int  NOT NULL,
    minutes       int  NOT NULL,
    PRIMARY KEY (route_id, from_stop_seq)
);

INSERT INTO catalog.route_segment_minutes (route_id, from_stop_seq, minutes)
SELECT r.route_id, m.seq, m.mins
  FROM (VALUES
        ('e0000000-0000-0000-0000-000000000001'::uuid),
        ('e0000000-0000-0000-0000-000000000002'::uuid),
        ('e0000000-0000-0000-0000-000000000003'::uuid),
        ('e0000000-0000-0000-0000-000000000004'::uuid)) AS r(route_id),
       (VALUES (0,120),(1,75),(2,105)) AS m(seq, mins);

INSERT INTO catalog.route_segment_minutes (route_id, from_stop_seq, minutes) VALUES
    ('e0000000-0000-0000-0000-000000000005', 0, 70),
    ('e0000000-0000-0000-0000-000000000005', 1, 260);

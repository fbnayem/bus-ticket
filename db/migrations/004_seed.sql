-- 004_seed.sql — the Dhaka -> Cumilla -> Feni -> Chattogram corridor from the spec.
-- Fixed UUIDs so tests and demos can reference them without a lookup round-trip.

SET client_min_messages = warning;

INSERT INTO catalog.operators (operator_id, legal_name, brand, status) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Green Line Paribahan Ltd', 'Green Line', 'ACTIVE');

-- Geography. Aliases collapse to ONE canonical id at write time, so every
-- downstream row stores an id and never a spelling.
INSERT INTO catalog.locations (location_id, kind, name, lat, lng) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'CITY', 'Dhaka',       23.810332, 90.412518),
    ('a0000000-0000-0000-0000-000000000002', 'CITY', 'Cumilla',     23.460000, 91.180000),
    ('a0000000-0000-0000-0000-000000000003', 'CITY', 'Feni',        23.023231, 91.396355),
    ('a0000000-0000-0000-0000-000000000004', 'CITY', 'Chattogram',  22.356851, 91.783182);

INSERT INTO catalog.location_aliases (alias, location_id) VALUES
    ('dhaka',       'a0000000-0000-0000-0000-000000000001'),
    ('dacca',       'a0000000-0000-0000-0000-000000000001'),
    ('dhk',         'a0000000-0000-0000-0000-000000000001'),
    ('cumilla',     'a0000000-0000-0000-0000-000000000002'),
    ('comilla',     'a0000000-0000-0000-0000-000000000002'),
    ('feni',        'a0000000-0000-0000-0000-000000000003'),
    ('chattogram',  'a0000000-0000-0000-0000-000000000004'),
    ('chittagong',  'a0000000-0000-0000-0000-000000000004'),
    ('ctg',         'a0000000-0000-0000-0000-000000000004');

INSERT INTO catalog.bus_types (bus_type_id, name, is_ac, class) VALUES
    ('b0000000-0000-0000-0000-000000000001', 'AC Business', true, 'BUSINESS');

INSERT INTO catalog.seat_layouts (layout_id, operator_id, name, version, decks, frozen) VALUES
    ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'AC Business 2x2 40', 1, 1, true);

-- 40 seats: rows A..J, columns 1..4 (2x2 with a centre aisle between 2 and 3).
INSERT INTO catalog.seat_layout_items (layout_id, seat_no, deck, row_idx, col_idx, seat_type, fare_class)
SELECT 'c0000000-0000-0000-0000-000000000001',
       chr(65 + r) || c::text,
       1, r, c,
       CASE WHEN r = 0 THEN 'BUSINESS' ELSE 'NORMAL' END,
       'BASE'
  FROM generate_series(0, 9) AS r,
       generate_series(1, 4) AS c;

INSERT INTO catalog.buses (bus_id, operator_id, registration, bus_type_id, layout_id, status) VALUES
    ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'DHAKA METRO-B-11-2233', 'b0000000-0000-0000-0000-000000000001',
     'c0000000-0000-0000-0000-000000000001', 'ACTIVE');

INSERT INTO catalog.routes (route_id, operator_id, name) VALUES
    ('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'Dhaka - Chattogram via Cumilla, Feni');

-- 4 stops, 0-based and dense => 3 segments.
INSERT INTO catalog.route_stops (route_id, stop_seq, location_id) VALUES
    ('e0000000-0000-0000-0000-000000000001', 0, 'a0000000-0000-0000-0000-000000000001'),
    ('e0000000-0000-0000-0000-000000000001', 1, 'a0000000-0000-0000-0000-000000000002'),
    ('e0000000-0000-0000-0000-000000000001', 2, 'a0000000-0000-0000-0000-000000000003'),
    ('e0000000-0000-0000-0000-000000000001', 3, 'a0000000-0000-0000-0000-000000000004');

-- Fares differ per segment pair — the spec's "support different prices between
-- segments" requirement. Amounts in poisha (1/100 BDT).
INSERT INTO catalog.route_fares (route_id, from_stop_seq, to_stop_seq, fare_class, amount_poisha) VALUES
    ('e0000000-0000-0000-0000-000000000001', 0, 1, 'BASE',  45000),  -- Dhaka -> Cumilla       450.00
    ('e0000000-0000-0000-0000-000000000001', 1, 2, 'BASE',  35000),  -- Cumilla -> Feni        350.00
    ('e0000000-0000-0000-0000-000000000001', 2, 3, 'BASE',  40000),  -- Feni -> Chattogram     400.00
    ('e0000000-0000-0000-0000-000000000001', 0, 2, 'BASE',  75000),  -- Dhaka -> Feni          750.00
    ('e0000000-0000-0000-0000-000000000001', 1, 3, 'BASE',  70000),  -- Cumilla -> Chattogram  700.00
    ('e0000000-0000-0000-0000-000000000001', 0, 3, 'BASE', 115000);  -- Dhaka -> Chattogram   1150.00

INSERT INTO catalog.schedules (schedule_id, operator_id, route_id, bus_id, depart_local, days_mask, valid_from) VALUES
    ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
     '22:00', 127, CURRENT_DATE);

INSERT INTO catalog.permissions (permission) VALUES
    ('trip.view'),('trip.create'),('trip.update'),
    ('booking.create'),('booking.cancel'),
    ('payment.refund'),('settlement.approve'),
    ('operator.manage'),('user.manage')
ON CONFLICT DO NOTHING;

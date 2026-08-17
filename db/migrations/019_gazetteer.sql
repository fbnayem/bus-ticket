-- 019_gazetteer.sql — the place names of Bangladesh, in both languages.
--
-- Until now the platform knew seven cities: enough to prove a corridor, not
-- enough to let a passenger type where they are going. A free-text field over
-- seven rows does not fail loudly — it fails as "we don't recognise that
-- departure city" for a person who spelled their own district correctly.
--
-- What goes in here, and why each part earns its row:
--
--   DIVISION (8)  — not passenger-facing on its own, but it is what lets a
--                   suggestion read "Bogura · Rajshahi" so the several -ganj
--                   towns are told apart at a glance.
--   CITY (64)     — every district. This is the unit a passenger thinks in:
--                   nobody books a bus to an upazila, they book to Feni.
--   CITY (extra)  — the places that are not districts but are genuine
--                   intercity destinations with daily coaches: Kuakata,
--                   Sreemangal, Benapole, Teknaf, Burimari, Jaflong. Leaving
--                   these out would be a bigger gap than any district.
--   TERMINAL      — the intercity terminals people name instead of the city.
--                   In Dhaka nobody says "Dhaka", they say Gabtoli or
--                   Sayedabad, and those face opposite ends of the country.
--
-- Bangla is not a translation here, it is the name. A passenger on a Bangla
-- keyboard types চট্টগ্রাম, and a field that only matches Latin text simply
-- fails them. Every row carries name_bn, and every Bangla name is also written
-- into location_aliases so typing it resolves even without the picker.
--
-- The old spellings matter as much as the new ones. The country renamed
-- Chittagong to Chattogram, Comilla to Cumilla, Jessore to Jashore, Barisal to
-- Barishal and Bogra to Bogura in 2018; the people typing into this field did
-- not all get the memo, and the printed tickets in their drawer still say the
-- old name. Both spellings resolve to one id, which is what location_aliases
-- is for.
--
-- Coordinates are the district town centre to about 0.01° — right for sorting,
-- mapping and distance heuristics, and deliberately not claimed to be good
-- enough to navigate a bus to a gate.

SET client_min_messages = warning;

-- ---------------------------------------------------------------- columns --

ALTER TABLE catalog.locations
    ADD COLUMN IF NOT EXISTS name_bn text NOT NULL DEFAULT '';

-- trips_to matters as much as trips_from once the list is national. A picker
-- over 113 places has to put the ones we actually run buses to at the top, and
-- a destination is served by arrivals, not departures.
ALTER TABLE search.location_index
    ADD COLUMN IF NOT EXISTS name_bn     text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS parent_name text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS trips_to    int  NOT NULL DEFAULT 0;

-- ------------------------------------------------------------- hierarchy --

INSERT INTO catalog.locations (location_id, kind, name, name_bn, lat, lng) VALUES
    ('c0000000-0000-0000-0000-0000000000bd', 'COUNTRY', 'Bangladesh', 'বাংলাদেশ', 23.685000, 90.356331)
ON CONFLICT (location_id) DO NOTHING;

INSERT INTO catalog.locations (location_id, kind, name, name_bn, parent_id, lat, lng) VALUES
    ('c0000000-0000-0000-0000-00000000d001', 'DIVISION', 'Dhaka',      'ঢাকা',      'c0000000-0000-0000-0000-0000000000bd', 23.810332, 90.412518),
    ('c0000000-0000-0000-0000-00000000d002', 'DIVISION', 'Chattogram', 'চট্টগ্রাম',   'c0000000-0000-0000-0000-0000000000bd', 22.356852, 91.783182),
    ('c0000000-0000-0000-0000-00000000d003', 'DIVISION', 'Rajshahi',   'রাজশাহী',    'c0000000-0000-0000-0000-0000000000bd', 24.363589, 88.624135),
    ('c0000000-0000-0000-0000-00000000d004', 'DIVISION', 'Khulna',     'খুলনা',      'c0000000-0000-0000-0000-0000000000bd', 22.845641, 89.540328),
    ('c0000000-0000-0000-0000-00000000d005', 'DIVISION', 'Barishal',   'বরিশাল',     'c0000000-0000-0000-0000-0000000000bd', 22.701002, 90.353451),
    ('c0000000-0000-0000-0000-00000000d006', 'DIVISION', 'Sylhet',     'সিলেট',      'c0000000-0000-0000-0000-0000000000bd', 24.894929, 91.868706),
    ('c0000000-0000-0000-0000-00000000d007', 'DIVISION', 'Rangpur',    'রংপুর',      'c0000000-0000-0000-0000-0000000000bd', 25.746490, 89.250797),
    ('c0000000-0000-0000-0000-00000000d008', 'DIVISION', 'Mymensingh', 'ময়মনসিংহ',  'c0000000-0000-0000-0000-0000000000bd', 24.747149, 90.420273)
ON CONFLICT (location_id) DO NOTHING;

-- ------------------------------------------------------- the 64 districts --
--
-- The seven that already exist (Dhaka, Chattogram, Cumilla, Feni, Sylhet,
-- Narsingdi, Cox's Bazar) are matched by name and left in place — routes,
-- trips and sold tickets point at those ids and must keep pointing at them.
-- They learn their Bangla name and their division; everything else is new.

CREATE TEMP TABLE _districts (name text, name_bn text, division text, lat numeric, lng numeric);
INSERT INTO _districts VALUES
    -- Dhaka division
    ('Dhaka',            'ঢাকা',            'd001', 23.810332, 90.412518),
    ('Gazipur',          'গাজীপুর',         'd001', 23.999410, 90.420633),
    ('Narayanganj',      'নারায়ণগঞ্জ',      'd001', 23.623326, 90.499992),
    ('Narsingdi',        'নরসিংদী',         'd001', 23.920840, 90.718290),
    ('Munshiganj',       'মুন্সিগঞ্জ',       'd001', 23.542210, 90.530510),
    ('Manikganj',        'মানিকগঞ্জ',       'd001', 23.861600, 90.004800),
    ('Tangail',          'টাঙ্গাইল',        'd001', 24.251200, 89.916700),
    ('Kishoreganj',      'কিশোরগঞ্জ',       'd001', 24.444900, 90.776500),
    ('Faridpur',         'ফরিদপুর',         'd001', 23.607080, 89.842910),
    ('Gopalganj',        'গোপালগঞ্জ',       'd001', 23.005040, 89.826630),
    ('Madaripur',        'মাদারীপুর',       'd001', 23.164100, 90.189600),
    ('Shariatpur',       'শরীয়তপুর',       'd001', 23.242300, 90.428700),
    ('Rajbari',          'রাজবাড়ী',         'd001', 23.757400, 89.644400),
    -- Chattogram division
    ('Chattogram',       'চট্টগ্রাম',        'd002', 22.356852, 91.783182),
    ('Cumilla',          'কুমিল্লা',         'd002', 23.460000, 91.180000),
    ('Feni',             'ফেনী',            'd002', 23.023300, 91.396700),
    ('Noakhali',         'নোয়াখালী',        'd002', 22.869100, 91.099300),
    ('Lakshmipur',       'লক্ষ্মীপুর',       'd002', 22.942300, 90.841000),
    ('Chandpur',         'চাঁদপুর',         'd002', 23.233200, 90.671300),
    ('Brahmanbaria',     'ব্রাহ্মণবাড়িয়া',   'd002', 23.957100, 91.111500),
    ('Cox''s Bazar',     'কক্সবাজার',        'd002', 21.427229, 92.005806),
    ('Bandarban',        'বান্দরবান',        'd002', 22.195300, 92.218300),
    ('Rangamati',        'রাঙ্গামাটি',       'd002', 22.656900, 92.174200),
    ('Khagrachhari',     'খাগড়াছড়ি',        'd002', 23.119300, 91.984700),
    -- Rajshahi division
    ('Rajshahi',         'রাজশাহী',         'd003', 24.363589, 88.624135),
    ('Bogura',           'বগুড়া',           'd003', 24.848500, 89.372900),
    ('Pabna',            'পাবনা',           'd003', 24.006400, 89.249900),
    ('Sirajganj',        'সিরাজগঞ্জ',       'd003', 24.454900, 89.700700),
    ('Natore',           'নাটোর',           'd003', 24.420600, 88.986200),
    ('Naogaon',          'নওগাঁ',           'd003', 24.803400, 88.943900),
    ('Joypurhat',        'জয়পুরহাট',        'd003', 25.094500, 89.023300),
    ('Chapai Nawabganj', 'চাঁপাইনবাবগঞ্জ',   'd003', 24.596500, 88.277500),
    -- Khulna division
    ('Khulna',           'খুলনা',           'd004', 22.845641, 89.540328),
    ('Jashore',          'যশোর',            'd004', 23.166900, 89.208100),
    ('Kushtia',          'কুষ্টিয়া',         'd004', 23.901300, 89.120600),
    ('Satkhira',         'সাতক্ষীরা',       'd004', 22.708500, 89.071100),
    ('Bagerhat',         'বাগেরহাট',        'd004', 22.651600, 89.785400),
    ('Jhenaidah',        'ঝিনাইদহ',         'd004', 23.544900, 89.153900),
    ('Magura',           'মাগুরা',          'd004', 23.487100, 89.419800),
    ('Narail',           'নড়াইল',           'd004', 23.172500, 89.512700),
    ('Chuadanga',        'চুয়াডাঙ্গা',       'd004', 23.640200, 88.841000),
    ('Meherpur',         'মেহেরপুর',        'd004', 23.762200, 88.631800),
    -- Barishal division
    ('Barishal',         'বরিশাল',          'd005', 22.701002, 90.353451),
    ('Patuakhali',       'পটুয়াখালী',       'd005', 22.359600, 90.329800),
    ('Bhola',            'ভোলা',            'd005', 22.685900, 90.648200),
    ('Pirojpur',         'পিরোজপুর',        'd005', 22.579100, 89.975900),
    ('Barguna',          'বরগুনা',          'd005', 22.150000, 90.126100),
    ('Jhalokathi',       'ঝালকাঠি',         'd005', 22.640600, 90.198700),
    -- Sylhet division
    ('Sylhet',           'সিলেট',           'd006', 24.894929, 91.868706),
    ('Moulvibazar',      'মৌলভীবাজার',      'd006', 24.482900, 91.777400),
    ('Habiganj',         'হবিগঞ্জ',         'd006', 24.374900, 91.415900),
    ('Sunamganj',        'সুনামগঞ্জ',       'd006', 25.065200, 91.395000),
    -- Rangpur division
    ('Rangpur',          'রংপুর',           'd007', 25.746490, 89.250797),
    ('Dinajpur',         'দিনাজপুর',        'd007', 25.627400, 88.637800),
    ('Kurigram',         'কুড়িগ্রাম',       'd007', 25.805400, 89.636200),
    ('Gaibandha',        'গাইবান্ধা',       'd007', 25.328500, 89.528900),
    ('Nilphamari',       'নীলফামারী',       'd007', 25.931200, 88.856000),
    ('Lalmonirhat',      'লালমনিরহাট',      'd007', 25.917900, 89.427700),
    ('Thakurgaon',       'ঠাকুরগাঁও',       'd007', 26.033900, 88.462800),
    ('Panchagarh',       'পঞ্চগড়',          'd007', 26.331100, 88.554100),
    -- Mymensingh division
    ('Mymensingh',       'ময়মনসিংহ',       'd008', 24.747149, 90.420273),
    ('Jamalpur',         'জামালপুর',        'd008', 24.937500, 89.937100),
    ('Netrokona',        'নেত্রকোণা',       'd008', 24.870900, 90.727900),
    ('Sherpur',          'শেরপুর',          'd008', 25.020400, 90.014800);

UPDATE catalog.locations l
   SET name_bn   = d.name_bn,
       parent_id = ('c0000000-0000-0000-0000-00000000' || d.division)::uuid,
       lat       = COALESCE(l.lat, d.lat),
       lng       = COALESCE(l.lng, d.lng)
  FROM _districts d
 WHERE l.kind = 'CITY' AND lower(l.name) = lower(d.name);

INSERT INTO catalog.locations (kind, name, name_bn, parent_id, lat, lng)
SELECT 'CITY', d.name, d.name_bn,
       ('c0000000-0000-0000-0000-00000000' || d.division)::uuid, d.lat, d.lng
  FROM _districts d
 WHERE NOT EXISTS (
       SELECT 1 FROM catalog.locations l
        WHERE l.kind = 'CITY' AND lower(l.name) = lower(d.name));

-- --------------------------------- destinations that are not districts --
--
-- Every one of these has scheduled intercity coaches from Dhaka. A gazetteer
-- that lists all 64 districts but cannot find Kuakata is still broken for the
-- passenger who is going to Kuakata.

CREATE TEMP TABLE _towns (name text, name_bn text, district text, lat numeric, lng numeric);
INSERT INTO _towns VALUES
    ('Kuakata',    'কুয়াকাটা',   'Patuakhali',   21.821400, 90.119700),
    ('Sreemangal', 'শ্রীমঙ্গল',   'Moulvibazar',  24.308200, 91.729800),
    ('Benapole',   'বেনাপোল',    'Jashore',      23.043900, 88.892000),
    ('Teknaf',     'টেকনাফ',     'Cox''s Bazar', 20.865800, 92.302700),
    ('Burimari',   'বুড়িমারী',   'Lalmonirhat',  26.383300, 88.983300),
    ('Jaflong',    'জাফলং',      'Sylhet',       25.163900, 92.019400),
    ('Chowmuhani', 'চৌমুহনী',    'Noakhali',     22.936100, 91.109700),
    ('Elenga',     'এলেঙ্গা',     'Tangail',      24.334200, 89.917800),
    ('Hatikumrul', 'হাটিকুমরুল',  'Sirajganj',    24.383300, 89.516700);

INSERT INTO catalog.locations (kind, name, name_bn, parent_id, lat, lng)
SELECT 'CITY', t.name, t.name_bn, p.location_id, t.lat, t.lng
  FROM _towns t
  JOIN catalog.locations p ON p.kind = 'CITY' AND lower(p.name) = lower(t.district)
 WHERE NOT EXISTS (
       SELECT 1 FROM catalog.locations l
        WHERE l.kind = 'CITY' AND lower(l.name) = lower(t.name));

-- -------------------------------------------------------------- terminals --
--
-- Dhaka is the reason this table earns its rows. "Dhaka" is not an answer to
-- where a coach leaves from — Gabtoli faces north and west, Sayedabad faces
-- east and south, Mohakhali faces north, and boarding at the wrong one is a
-- lost fare and a missed bus.

CREATE TEMP TABLE _terminals (name text, name_bn text, city text, lat numeric, lng numeric);
INSERT INTO _terminals VALUES
    ('Gabtoli',        'গাবতলী',        'Dhaka',        23.786600, 90.343400),
    ('Sayedabad',      'সায়েদাবাদ',     'Dhaka',        23.708300, 90.435800),
    ('Mohakhali',      'মহাখালী',       'Dhaka',        23.780800, 90.404400),
    ('Kalyanpur',      'কল্যাণপুর',     'Dhaka',        23.796900, 90.358600),
    ('Shyamoli',       'শ্যামলী',       'Dhaka',        23.774400, 90.365300),
    ('Arambagh',       'আরামবাগ',       'Dhaka',        23.729700, 90.417800),
    ('Fakirapool',     'ফকিরাপুল',      'Dhaka',        23.733300, 90.415000),
    ('Malibagh',       'মালিবাগ',       'Dhaka',        23.746900, 90.415800),
    ('Abdullahpur',    'আব্দুল্লাহপুর',  'Dhaka',        23.876900, 90.399700),
    ('Jatrabari',      'যাত্রাবাড়ী',     'Dhaka',        23.710300, 90.435300),
    ('Panthapath',     'পান্থপথ',       'Dhaka',        23.751400, 90.386900),
    ('Dampara',        'দামপাড়া',       'Chattogram',   22.353600, 91.822800),
    ('AK Khan',        'একে খান',       'Chattogram',   22.383900, 91.775600),
    ('Oxygen Mor',     'অক্সিজেন মোড়',  'Chattogram',   22.386400, 91.831900),
    ('Bahaddarhat',    'বহদ্দারহাট',    'Chattogram',   22.365300, 91.845000),
    ('Alangkar Mor',   'অলংকার মোড়',   'Chattogram',   22.377800, 91.766700),
    ('Kadamtali',      'কদমতলী',        'Sylhet',       24.887500, 91.885300),
    ('Kolatoli',       'কলাতলী',        'Cox''s Bazar', 21.418100, 92.002800),
    ('Jhawtola',       'ঝাউতলা',        'Cox''s Bazar', 21.441700, 91.977800),
    ('Sonadanga',      'সোনাডাঙ্গা',     'Khulna',       22.812500, 89.539700),
    ('Shiroil',        'শিরোইল',        'Rajshahi',     24.371400, 88.599700),
    ('Naodapara',      'নওদাপাড়া',      'Rajshahi',     24.401900, 88.632800),
    ('Charmatha',      'চারমাথা',       'Bogura',       24.860300, 89.372200),
    ('Thanthania',     'ঠনঠনিয়া',       'Bogura',       24.845600, 89.371700),
    ('Kamarpara',      'কামারপাড়া',     'Rangpur',      25.756900, 89.253600),
    ('Modern Mor',     'মডার্ন মোড়',    'Rangpur',      25.720800, 89.235000),
    ('Jangalia',       'জাঙ্গালিয়া',     'Cumilla',      23.451400, 91.190300),
    ('Shasongachha',   'শাসনগাছা',      'Cumilla',      23.469700, 91.166900),
    ('Padua Bazar',    'পদুয়ার বাজার',  'Cumilla',      23.421900, 91.157200),
    ('Mohipal',        'মহিপাল',        'Feni',         23.031900, 91.386900),
    ('Nathullabad',    'নথুল্লাবাদ',     'Barishal',     22.716900, 90.348900),
    ('Rupatoli',       'রূপাতলী',       'Barishal',     22.679700, 90.362800),
    ('Mashkanda',      'মাসকান্দা',      'Mymensingh',   24.780300, 90.406900),
    ('Patgudam',       'পাটগুদাম',      'Mymensingh',   24.752800, 90.415300),
    ('Monihar',        'মণিহার',        'Jashore',      23.150800, 89.220600),
    ('Chowrasta',      'চৌরাস্তা',      'Gazipur',      23.999200, 90.420800),
    ('Board Bazar',    'বোর্ড বাজার',   'Gazipur',      23.945800, 90.399700),
    ('Chashara',       'চাষাঢ়া',        'Narayanganj',  23.622500, 90.500600),
    ('Mojompur',       'মজমপুর',        'Kushtia',      23.897800, 89.121700),
    ('Maijdee',        'মাইজদী',        'Noakhali',     22.869400, 91.098100);

INSERT INTO catalog.locations (kind, name, name_bn, parent_id, lat, lng)
SELECT 'TERMINAL', tm.name, tm.name_bn, p.location_id, tm.lat, tm.lng
  FROM _terminals tm
  JOIN catalog.locations p ON p.kind = 'CITY' AND lower(p.name) = lower(tm.city)
 WHERE NOT EXISTS (
       SELECT 1 FROM catalog.locations l
        WHERE l.kind = 'TERMINAL' AND lower(l.name) = lower(tm.name)
          AND l.parent_id = p.location_id);

-- ---------------------------------------------------------------- aliases --
--
-- Three sources, all of them things a real person types:
--   1. the Bangla name, for anyone on a Bangla keyboard;
--   2. the pre-2018 English spelling, which is still on their old ticket;
--   3. the short forms people actually use out loud.

-- 1. Every Bangla name resolves.
INSERT INTO catalog.location_aliases (alias, location_id)
SELECT lower(name_bn), location_id
  FROM catalog.locations
 WHERE name_bn <> '' AND kind IN ('CITY','TERMINAL')
ON CONFLICT (alias) DO NOTHING;

-- Also the canonical English name, so ResolveLocation has one uniform path.
INSERT INTO catalog.location_aliases (alias, location_id)
SELECT lower(name), location_id
  FROM catalog.locations
 WHERE kind IN ('CITY','TERMINAL')
ON CONFLICT (alias) DO NOTHING;

-- 2 and 3. The spellings history left behind, and the ones people say.
CREATE TEMP TABLE _aliases (alias text, city text);
INSERT INTO _aliases VALUES
    ('chittagong', 'Chattogram'), ('chattagram', 'Chattogram'), ('ctg', 'Chattogram'),
    ('chatto', 'Chattogram'), ('চিটাগাং', 'Chattogram'), ('চট্টগ্রাম শহর', 'Chattogram'),
    ('comilla', 'Cumilla'), ('komilla', 'Cumilla'), ('cumila', 'Cumilla'),
    ('jessore', 'Jashore'), ('josore', 'Jashore'), ('যশোহর', 'Jashore'),
    ('barisal', 'Barishal'), ('borishal', 'Barishal'),
    ('bogra', 'Bogura'), ('bagura', 'Bogura'),
    ('dacca', 'Dhaka'), ('dhaka city', 'Dhaka'), ('dhk', 'Dhaka'),
    ('nawabganj', 'Chapai Nawabganj'), ('chapainawabganj', 'Chapai Nawabganj'),
    ('chapai', 'Chapai Nawabganj'),
    ('netrakona', 'Netrokona'),
    ('khagrachari', 'Khagrachhari'), ('khagrachori', 'Khagrachhari'),
    ('rangamati hill', 'Rangamati'),
    ('coxs bazar', 'Cox''s Bazar'), ('cox bazar', 'Cox''s Bazar'), ('cxb', 'Cox''s Bazar'),
    ('coxsbazar', 'Cox''s Bazar'),
    ('b baria', 'Brahmanbaria'), ('b.baria', 'Brahmanbaria'), ('bbaria', 'Brahmanbaria'),
    ('brahmanbaria', 'Brahmanbaria'),
    ('maulvibazar', 'Moulvibazar'), ('moulavibazar', 'Moulvibazar'), ('sremangal', 'Sreemangal'),
    ('srimangal', 'Sreemangal'), ('sreemongol', 'Sreemangal'),
    ('laxmipur', 'Lakshmipur'), ('lakhipur', 'Lakshmipur'),
    ('naryanganj', 'Narayanganj'), ('narayangonj', 'Narayanganj'),
    ('serajganj', 'Sirajganj'), ('sirajgonj', 'Sirajganj'),
    ('kishorganj', 'Kishoreganj'), ('kisoreganj', 'Kishoreganj'),
    ('nilfamari', 'Nilphamari'),
    ('thakurgan', 'Thakurgaon'), ('thakurgao', 'Thakurgaon'),
    ('jaipurhat', 'Joypurhat'), ('joypurhaat', 'Joypurhat'),
    ('panchagor', 'Panchagarh'), ('pachagarh', 'Panchagarh'),
    ('bikrampur', 'Munshiganj'), ('munsiganj', 'Munshiganj'),
    ('slt', 'Sylhet'), ('sylhat', 'Sylhet'),
    ('mymensing', 'Mymensingh'), ('mymansingh', 'Mymensingh'), ('momensingh', 'Mymensingh'),
    ('kuakata sea beach', 'Kuakata'),
    ('rajshahi city', 'Rajshahi'),
    ('khulna city', 'Khulna');

INSERT INTO catalog.location_aliases (alias, location_id)
SELECT a.alias, l.location_id
  FROM _aliases a
  JOIN catalog.locations l ON l.kind = 'CITY' AND lower(l.name) = lower(a.city)
ON CONFLICT (alias) DO NOTHING;

DROP TABLE _districts;
DROP TABLE _towns;
DROP TABLE _terminals;
DROP TABLE _aliases;

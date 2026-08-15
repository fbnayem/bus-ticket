-- 008_channels_seed.sql — roles, permissions, staff, counters, agencies.
--
-- Roles are seeded as DATA. Adding "Regional Supervisor" tomorrow is an INSERT
-- into catalog.roles plus rows in catalog.role_permissions; no code changes,
-- no deploy. That is the whole reason permissions are strings of the form
-- resource.action rather than an enum in Go.
--
-- Every demo account below uses the password  Jatra#2026
-- (PBKDF2-HMAC-SHA256, 210,000 iterations, per-user salt). These are fixtures
-- for a local harness, which is precisely why they are weak and public: no
-- real credential is ever committed to this repository.

BEGIN;

-- ================================================================ permissions =

INSERT INTO catalog.permissions (permission) VALUES
    ('platform.admin'),
    ('operator.read'), ('operator.write'),
    ('fleet.read'), ('fleet.write'),
    ('route.read'), ('route.write'),
    ('fare.read'), ('fare.write'),
    ('schedule.read'), ('schedule.write'),
    ('trip.read'), ('trip.write'),
    ('booking.read'), ('booking.refund'),
    ('payment.read'),
    ('ledger.read'), ('ledger.adjust'),
    ('settlement.read'), ('settlement.calculate'),
    ('audit.read'),
    ('support.read'), ('support.write'),
    ('agent.read'), ('agent.write'),
    ('wallet.sell'), ('wallet.recharge'), ('wallet.approve'),
    ('counter.sell'), ('counter.shift'), ('counter.quota'), ('counter.report'),
    ('staff.read'), ('staff.write'),
    ('boarding.scan'), ('driver.trip'),
    ('report.read'), ('system.health')
ON CONFLICT DO NOTHING;

-- ===================================================================== roles =

INSERT INTO catalog.roles (role_id, role_key, family) VALUES
    ('c0000000-0000-0000-0000-000000000001','SUPER_ADMIN',     'PLATFORM'),
    ('c0000000-0000-0000-0000-000000000002','FINANCE_ADMIN',   'PLATFORM'),
    ('c0000000-0000-0000-0000-000000000003','SUPPORT_AGENT',   'PLATFORM'),
    ('c0000000-0000-0000-0000-000000000004','AUDITOR',         'PLATFORM'),
    ('c0000000-0000-0000-0000-000000000005','OPS_ADMIN',       'PLATFORM'),
    ('c0000000-0000-0000-0000-000000000011','OPERATOR_OWNER',  'OPERATOR'),
    ('c0000000-0000-0000-0000-000000000012','OPERATOR_MANAGER','OPERATOR'),
    ('c0000000-0000-0000-0000-000000000013','DISPATCHER',      'OPERATOR'),
    ('c0000000-0000-0000-0000-000000000014','ACCOUNTANT',      'OPERATOR'),
    ('c0000000-0000-0000-0000-000000000015','COUNTER_AGENT',   'OPERATOR'),
    ('c0000000-0000-0000-0000-000000000016','DRIVER',          'OPERATOR'),
    ('c0000000-0000-0000-0000-000000000017','HELPER',          'OPERATOR'),
    ('c0000000-0000-0000-0000-000000000021','AGENT_OWNER',     'PARTNER'),
    ('c0000000-0000-0000-0000-000000000022','SUB_AGENT',       'PARTNER')
ON CONFLICT (role_key) DO NOTHING;

-- SUPER_ADMIN holds every permission by construction, so a new permission is
-- never accidentally unreachable.
INSERT INTO catalog.role_permissions (role_id, permission)
SELECT 'c0000000-0000-0000-0000-000000000001', permission FROM catalog.permissions
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission) VALUES
    -- FINANCE_ADMIN: the money, and nothing that sells a seat.
    ('c0000000-0000-0000-0000-000000000002','ledger.read'),
    ('c0000000-0000-0000-0000-000000000002','ledger.adjust'),
    ('c0000000-0000-0000-0000-000000000002','settlement.read'),
    ('c0000000-0000-0000-0000-000000000002','settlement.calculate'),
    ('c0000000-0000-0000-0000-000000000002','settlement.approve'),
    ('c0000000-0000-0000-0000-000000000002','payment.read'),
    ('c0000000-0000-0000-0000-000000000002','booking.read'),
    ('c0000000-0000-0000-0000-000000000002','booking.refund'),
    ('c0000000-0000-0000-0000-000000000002','operator.read'),
    ('c0000000-0000-0000-0000-000000000002','agent.read'),
    ('c0000000-0000-0000-0000-000000000002','wallet.approve'),
    ('c0000000-0000-0000-0000-000000000002','report.read'),
    ('c0000000-0000-0000-0000-000000000002','audit.read'),

    -- SUPPORT_AGENT: sees everything about a booking, changes almost nothing.
    ('c0000000-0000-0000-0000-000000000003','booking.read'),
    ('c0000000-0000-0000-0000-000000000003','booking.cancel'),
    ('c0000000-0000-0000-0000-000000000003','payment.read'),
    ('c0000000-0000-0000-0000-000000000003','support.read'),
    ('c0000000-0000-0000-0000-000000000003','support.write'),
    ('c0000000-0000-0000-0000-000000000003','trip.read'),
    ('c0000000-0000-0000-0000-000000000003','operator.read'),

    -- AUDITOR: reads everything, writes nothing. Deliberately no *.write.
    ('c0000000-0000-0000-0000-000000000004','booking.read'),
    ('c0000000-0000-0000-0000-000000000004','payment.read'),
    ('c0000000-0000-0000-0000-000000000004','ledger.read'),
    ('c0000000-0000-0000-0000-000000000004','settlement.read'),
    ('c0000000-0000-0000-0000-000000000004','audit.read'),
    ('c0000000-0000-0000-0000-000000000004','operator.read'),
    ('c0000000-0000-0000-0000-000000000004','agent.read'),
    ('c0000000-0000-0000-0000-000000000004','report.read'),
    ('c0000000-0000-0000-0000-000000000004','trip.read'),

    -- OPS_ADMIN: the road, not the money.
    ('c0000000-0000-0000-0000-000000000005','trip.read'),
    ('c0000000-0000-0000-0000-000000000005','trip.write'),
    ('c0000000-0000-0000-0000-000000000005','fleet.read'),
    ('c0000000-0000-0000-0000-000000000005','operator.read'),
    ('c0000000-0000-0000-0000-000000000005','system.health'),
    ('c0000000-0000-0000-0000-000000000005','report.read'),

    -- OPERATOR_OWNER: everything inside their own operator_id.
    ('c0000000-0000-0000-0000-000000000011','operator.read'),
    ('c0000000-0000-0000-0000-000000000011','operator.write'),
    ('c0000000-0000-0000-0000-000000000011','fleet.read'),
    ('c0000000-0000-0000-0000-000000000011','fleet.write'),
    ('c0000000-0000-0000-0000-000000000011','route.read'),
    ('c0000000-0000-0000-0000-000000000011','route.write'),
    ('c0000000-0000-0000-0000-000000000011','fare.read'),
    ('c0000000-0000-0000-0000-000000000011','fare.write'),
    ('c0000000-0000-0000-0000-000000000011','schedule.read'),
    ('c0000000-0000-0000-0000-000000000011','schedule.write'),
    ('c0000000-0000-0000-0000-000000000011','trip.read'),
    ('c0000000-0000-0000-0000-000000000011','trip.write'),
    ('c0000000-0000-0000-0000-000000000011','booking.read'),
    ('c0000000-0000-0000-0000-000000000011','settlement.read'),
    ('c0000000-0000-0000-0000-000000000011','agent.read'),
    ('c0000000-0000-0000-0000-000000000011','staff.read'),
    ('c0000000-0000-0000-0000-000000000011','staff.write'),
    ('c0000000-0000-0000-0000-000000000011','counter.report'),
    ('c0000000-0000-0000-0000-000000000011','report.read'),

    -- OPERATOR_MANAGER: the owner's rights minus staff and money.
    ('c0000000-0000-0000-0000-000000000012','operator.read'),
    ('c0000000-0000-0000-0000-000000000012','fleet.read'),
    ('c0000000-0000-0000-0000-000000000012','fleet.write'),
    ('c0000000-0000-0000-0000-000000000012','route.read'),
    ('c0000000-0000-0000-0000-000000000012','route.write'),
    ('c0000000-0000-0000-0000-000000000012','fare.read'),
    ('c0000000-0000-0000-0000-000000000012','fare.write'),
    ('c0000000-0000-0000-0000-000000000012','schedule.read'),
    ('c0000000-0000-0000-0000-000000000012','schedule.write'),
    ('c0000000-0000-0000-0000-000000000012','trip.read'),
    ('c0000000-0000-0000-0000-000000000012','trip.write'),
    ('c0000000-0000-0000-0000-000000000012','booking.read'),
    ('c0000000-0000-0000-0000-000000000012','report.read'),

    -- DISPATCHER: runs today. Provably cannot open a finance screen — the
    -- Phase 2 exit gate asks for exactly this test.
    ('c0000000-0000-0000-0000-000000000013','trip.read'),
    ('c0000000-0000-0000-0000-000000000013','trip.write'),
    ('c0000000-0000-0000-0000-000000000013','fleet.read'),
    ('c0000000-0000-0000-0000-000000000013','booking.read'),
    ('c0000000-0000-0000-0000-000000000013','operator.read'),

    -- ACCOUNTANT: operator-side finance.
    ('c0000000-0000-0000-0000-000000000014','settlement.read'),
    ('c0000000-0000-0000-0000-000000000014','booking.read'),
    ('c0000000-0000-0000-0000-000000000014','payment.read'),
    ('c0000000-0000-0000-0000-000000000014','report.read'),
    ('c0000000-0000-0000-0000-000000000014','operator.read'),
    ('c0000000-0000-0000-0000-000000000014','counter.report'),

    -- COUNTER_AGENT: sells and runs a drawer. Cannot see settlements.
    ('c0000000-0000-0000-0000-000000000015','counter.sell'),
    ('c0000000-0000-0000-0000-000000000015','counter.shift'),
    ('c0000000-0000-0000-0000-000000000015','counter.quota'),
    ('c0000000-0000-0000-0000-000000000015','counter.report'),
    ('c0000000-0000-0000-0000-000000000015','booking.read'),
    ('c0000000-0000-0000-0000-000000000015','booking.cancel'),
    ('c0000000-0000-0000-0000-000000000015','trip.read'),
    ('c0000000-0000-0000-0000-000000000015','operator.read'),

    -- DRIVER / HELPER: the trip in front of them and nothing else.
    ('c0000000-0000-0000-0000-000000000016','driver.trip'),
    ('c0000000-0000-0000-0000-000000000016','trip.read'),
    ('c0000000-0000-0000-0000-000000000016','boarding.scan'),
    ('c0000000-0000-0000-0000-000000000017','driver.trip'),
    ('c0000000-0000-0000-0000-000000000017','trip.read'),
    ('c0000000-0000-0000-0000-000000000017','boarding.scan'),

    -- AGENT_OWNER / SUB_AGENT: sell against the wallet.
    ('c0000000-0000-0000-0000-000000000021','wallet.sell'),
    ('c0000000-0000-0000-0000-000000000021','wallet.recharge'),
    ('c0000000-0000-0000-0000-000000000021','agent.read'),
    ('c0000000-0000-0000-0000-000000000021','agent.write'),
    ('c0000000-0000-0000-0000-000000000021','booking.read'),
    ('c0000000-0000-0000-0000-000000000021','booking.cancel'),
    ('c0000000-0000-0000-0000-000000000021','trip.read'),
    ('c0000000-0000-0000-0000-000000000021','report.read'),
    ('c0000000-0000-0000-0000-000000000022','wallet.sell'),
    ('c0000000-0000-0000-0000-000000000022','agent.read'),
    ('c0000000-0000-0000-0000-000000000022','booking.read'),
    ('c0000000-0000-0000-0000-000000000022','trip.read')
ON CONFLICT DO NOTHING;

-- ================================================================== counters =

INSERT INTO counter.counters (counter_id, operator_id, name, location_id, address) VALUES
    ('d0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
     'Arambagh Counter','a0000000-0000-0000-0000-000000000001','21 Arambagh, Motijheel, Dhaka'),
    ('d0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
     'Dampara Counter','a0000000-0000-0000-0000-000000000004','Dampara, Chattogram'),
    ('d0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111112',
     'Kallyanpur Counter','a0000000-0000-0000-0000-000000000001','Kallyanpur, Dhaka')
ON CONFLICT DO NOTHING;

-- ================================================================== agencies =

INSERT INTO agent.agencies (agency_id, name, parent_id, phone, address, kyc_status) VALUES
    ('e0000000-0000-0000-0000-000000000001','Shafi Travels', NULL,
     '+8801711000001','Gulistan, Dhaka','VERIFIED'),
    ('e0000000-0000-0000-0000-000000000002','Shafi Travels — Feni Desk',
     'e0000000-0000-0000-0000-000000000001','+8801711000002','Trunk Road, Feni','VERIFIED')
ON CONFLICT DO NOTHING;

-- ৳25,000 loaded, ৳50,000 credit — the pilot cap from the plan.
INSERT INTO agent.wallets (wallet_id, agency_id, available_poisha, credit_limit_poisha) VALUES
    ('e1000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001', 2500000, 5000000),
    ('e1000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-000000000002',  500000, 1000000)
ON CONFLICT DO NOTHING;

-- The opening balance exists as a transaction, not just a number, so the
-- wallet can be rebuilt from its log and still match.
INSERT INTO agent.wallet_transactions (wallet_id, kind, delta_poisha, ref, note) VALUES
    ('e1000000-0000-0000-0000-000000000001','RECHARGE', 2500000,'SEED','opening balance'),
    ('e1000000-0000-0000-0000-000000000002','RECHARGE',  500000,'SEED','opening balance')
ON CONFLICT DO NOTHING;

-- Most-specific wins: Shafi on the Green Line corridor earns 6%; any agency
-- selling Green Line earns 4%; anything else falls through to 3%.
INSERT INTO agent.commission_rules (operator_id, agency_id, kind, value_bp, priority) VALUES
    ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001','PCT', 600, 30),
    ('11111111-1111-1111-1111-111111111111', NULL,                                 'PCT', 400, 20)
ON CONFLICT DO NOTHING;
INSERT INTO agent.commission_rules (operator_id, agency_id, kind, value_bp, priority) VALUES
    (NULL, NULL, 'PCT', 300, 10)
ON CONFLICT DO NOTHING;

-- ============================================================== staff users ==

INSERT INTO staff.staff_users
    (staff_id, email, full_name, phone, password_hash, password_salt,
     operator_id, counter_id, agency_id) VALUES
    ('f0000000-0000-0000-0000-000000000001','admin@jatra.test','Nadia Rahman','+8801700000001',
     'f3a4da39d79fc845dbfb5ec75c64df431302550ce26297a061fcfcd5a307e829','43871074b22cdb19f35349e32ba126e5',
     NULL,NULL,NULL),
    ('f0000000-0000-0000-0000-000000000002','finance@jatra.test','Tanvir Hasan','+8801700000002',
     '5d6e0747360441a0155178170a58565ea341e109bcb7b849497394b88c7f06ca','914c3b8b28cdaa9593d5dc1dcf64c449',
     NULL,NULL,NULL),
    ('f0000000-0000-0000-0000-000000000003','auditor@jatra.test','Shirin Akter','+8801700000003',
     '6275e57cf11c559bd84e8e5306a620c914875db335d91aad8dcc49ee08014754','701c9a693e87a9e8d29c4677825b8f23',
     NULL,NULL,NULL),
    ('f0000000-0000-0000-0000-000000000004','support@jatra.test','Rafiq Chowdhury','+8801700000004',
     '6c37aa53138a3a1c933d3200d037f241652efa35ee9cc18129cee64e11940343','df6f9902e3b40e968ba0b4d75d95889f',
     NULL,NULL,NULL),
    ('f0000000-0000-0000-0000-000000000005','ops@jatra.test','Mahmuda Khatun','+8801700000005',
     'e153c3c13b728b04511ce23cb139f17a20409e945e755d97efe04221cd8540c3','1a51d942c3dba8a9b8c9019362ee6f53',
     NULL,NULL,NULL),
    ('f0000000-0000-0000-0000-000000000011','owner@greenline.test','Kamrul Islam','+8801700000011',
     '222634bb15b96556dfbb9b0ec815ce1fba3f02066740fabe9cfbfb499f4d56d2','0ad2ec2663284a686251a7090cf15187',
     '11111111-1111-1111-1111-111111111111',NULL,NULL),
    ('f0000000-0000-0000-0000-000000000012','dispatch@greenline.test','Sabbir Ahmed','+8801700000012',
     '706ecf1dd63aca23ab58397f5040182e48d6d7193fd3017eaee89a4bc0be1a3b','f3fea6f6f42ac1f3f95512371423bb7a',
     '11111111-1111-1111-1111-111111111111',NULL,NULL),
    ('f0000000-0000-0000-0000-000000000013','accounts@greenline.test','Farhana Yasmin','+8801700000013',
     '8bf4bda33a756474b449cf31842ceac72b57f7980d15ae09508d0e1f08c7e5bc','149080e4e467d81225dddb90127e5f43',
     '11111111-1111-1111-1111-111111111111',NULL,NULL),
    ('f0000000-0000-0000-0000-000000000014','counter.dhaka@greenline.test','Jamal Uddin','+8801700000014',
     'a5eb64166fb1a7941d4f05813ec74c925d24abab4210b024a49f87b1f9e87d91','abfcf84b07f0dab00042cbac9bcea69c',
     '11111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-000000000001',NULL),
    ('f0000000-0000-0000-0000-000000000015','counter.ctg@greenline.test','Ruma Das','+8801700000015',
     'a0810a60f3970902d1f60242e6e6ace777e16771a9edade99a5f2939089bac4c','8e97064dbc7fe0a2e5560f77cf8a0647',
     '11111111-1111-1111-1111-111111111111','d0000000-0000-0000-0000-000000000002',NULL),
    ('f0000000-0000-0000-0000-000000000016','driver@greenline.test','Abdul Karim','+8801700000016',
     '648c257bc496aa2d88170bc2fca3952025ad88245b1b70dcc106c130aa18cc4e','a4fac1ba72234afb56a447107e24c73e',
     '11111111-1111-1111-1111-111111111111',NULL,NULL),
    ('f0000000-0000-0000-0000-000000000017','helper@greenline.test','Sumon Mia','+8801700000017',
     '7d0f143dc60c3f120632488169dfceec72b7bce466345dec0befd1e31fefecbc','90d1fca51e9a857f3d43ec71a5599960',
     '11111111-1111-1111-1111-111111111111',NULL,NULL),
    ('f0000000-0000-0000-0000-000000000018','owner@shohagh.test','Nurul Amin','+8801700000018',
     '0458338f96f99ace1e3a2ed989583f790b606e145bedad1e35835997db64999e','cbacdf02f1ae641e5d7d66ae3f217d73',
     '11111111-1111-1111-1111-111111111112',NULL,NULL),
    ('f0000000-0000-0000-0000-000000000021','agent@shafi.test','Shafiqul Alam','+8801700000021',
     '0b2d708007c2454b791e4468123c15c8a023b7274767b7fc0611b5a33f6fd7f3','ea9fe0ce92f0349474364000b6b74b9c',
     NULL,NULL,'e0000000-0000-0000-0000-000000000001'),
    ('f0000000-0000-0000-0000-000000000022','subagent@shafi.test','Mizanur Rahman','+8801700000022',
     '0b6c8bc95ff882a7f3f3e6048b2b89d53915bb72e9424e679e84902510683672','bc5aae8c4eb20fa5f97ed22c0d079097',
     NULL,NULL,'e0000000-0000-0000-0000-000000000002')
ON CONFLICT (email) DO NOTHING;

INSERT INTO staff.user_roles (staff_id, role_id) VALUES
    ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001'),
    ('f0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000002'),
    ('f0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000004'),
    ('f0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000003'),
    ('f0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000005'),
    ('f0000000-0000-0000-0000-000000000011','c0000000-0000-0000-0000-000000000011'),
    ('f0000000-0000-0000-0000-000000000012','c0000000-0000-0000-0000-000000000013'),
    ('f0000000-0000-0000-0000-000000000013','c0000000-0000-0000-0000-000000000014'),
    ('f0000000-0000-0000-0000-000000000014','c0000000-0000-0000-0000-000000000015'),
    ('f0000000-0000-0000-0000-000000000015','c0000000-0000-0000-0000-000000000015'),
    ('f0000000-0000-0000-0000-000000000016','c0000000-0000-0000-0000-000000000016'),
    ('f0000000-0000-0000-0000-000000000017','c0000000-0000-0000-0000-000000000017'),
    ('f0000000-0000-0000-0000-000000000018','c0000000-0000-0000-0000-000000000011'),
    ('f0000000-0000-0000-0000-000000000021','c0000000-0000-0000-0000-000000000021'),
    ('f0000000-0000-0000-0000-000000000022','c0000000-0000-0000-0000-000000000022')
ON CONFLICT DO NOTHING;

COMMIT;

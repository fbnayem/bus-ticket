-- 012_platform_seed.sql — permissions and roles for the consoles added in 011,
-- plus the demo data the new workstreams need.
--
-- Every new capability gets its own resource.action permission and is granted
-- to roles by INSERT. Nothing in the API tests a role name; adding "Risk
-- Analyst" tomorrow is two INSERTs and no deploy.

SET client_min_messages = warning;

-- The permission table is a list of strings; the description of what each one
-- allows lives here, next to the grants, where it is read.
INSERT INTO catalog.permissions (permission) VALUES
    ('risk.read'),      -- view risk rules, events and cases
    ('risk.manage'),    -- change rule modes, block and unblock subjects
    ('partner.read'),   -- view partners, quotas and webhook deliveries
    ('partner.manage'), -- certify partners, change tiers, replay webhooks
    ('recon.read'),     -- view reconciliation runs and exceptions
    ('recon.manage'),   -- import settlement files and resolve exceptions
    ('promo.read'),     -- view campaigns, redemptions and referrals
    ('promo.manage'),   -- create and retire campaigns
    ('ops.monitor'),    -- view the operations control centre
    ('ops.manage'),     -- acknowledge alerts and run a bus replacement
    ('notify.read'),    -- view the notification delivery log and spend
    ('notify.manage'),  -- change providers, templates and routing
    ('events.read'),    -- view the event log, consumer lag and dead letters
    ('events.manage')   -- replay dead-lettered events
ON CONFLICT (permission) DO NOTHING;

-- Super Admin holds every permission by construction, re-applied here so the
-- ones added above are included. This is the same statement 008 used, and it is
-- meant to be re-runnable for exactly this reason.
INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, p.permission
  FROM catalog.roles r, catalog.permissions p
 WHERE r.role_key = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;

-- Operations admin runs the control centre and the event backbone.
INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, p
  FROM catalog.roles r,
       unnest(ARRAY['ops.monitor','ops.manage','events.read','events.manage',
                    'notify.read','notify.manage','risk.read','partner.read']) AS p
 WHERE r.role_key = 'OPS_ADMIN'
ON CONFLICT DO NOTHING;

-- Finance owns reconciliation. Note what is NOT here: finance cannot manage
-- partners or risk rules, and ops cannot resolve a reconciliation exception.
INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, p
  FROM catalog.roles r,
       unnest(ARRAY['recon.read','recon.manage','promo.read','notify.read']) AS p
 WHERE r.role_key = 'FINANCE_ADMIN'
ON CONFLICT DO NOTHING;

-- The auditor reads everything new and changes none of it.
INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, p
  FROM catalog.roles r,
       unnest(ARRAY['risk.read','partner.read','recon.read','promo.read',
                    'ops.monitor','notify.read','events.read']) AS p
 WHERE r.role_key = 'AUDITOR'
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, p
  FROM catalog.roles r, unnest(ARRAY['risk.read','promo.read']) AS p
 WHERE r.role_key = 'SUPPORT_AGENT'
ON CONFLICT DO NOTHING;

-- An operator watches its own buses and can put a replacement on the road.
INSERT INTO catalog.role_permissions (role_id, permission)
SELECT r.role_id, p
  FROM catalog.roles r, unnest(ARRAY['ops.monitor','ops.manage','promo.read']) AS p
 WHERE r.role_key IN ('OPERATOR_OWNER','OPERATOR_MANAGER','DISPATCHER')
ON CONFLICT DO NOTHING;

-- Dispatchers watch; they do not swap buses or approve anything.
DELETE FROM catalog.role_permissions
 WHERE role_id = (SELECT role_id FROM catalog.roles WHERE role_key = 'DISPATCHER')
   AND permission = 'ops.manage';

-- The coupons that lived in commerce.coupons move into the campaigns engine.
-- That table only ever supported a flat discount with a global usage counter;
-- the codes printed on tickets and pasted into chat groups have to keep working,
-- so they are migrated rather than reissued. commerce.coupons is left in place,
-- unread, until a later migration drops it.
INSERT INTO promo.campaigns
    (code, title, kind, discount_pct, discount_poisha, max_discount_poisha,
     min_amount_poisha, max_redemptions, per_user_limit, starts_at, ends_at, active)
SELECT c.code, c.title, 'COUPON',
       COALESCE(c.discount_pct, 0), COALESCE(c.discount_poisha, 0),
       COALESCE(c.max_discount_poisha, 0), c.min_amount_poisha,
       c.usage_limit, 3, c.starts_at, c.ends_at, c.active
  FROM commerce.coupons c
ON CONFLICT (code) DO NOTHING;

-- The platform's own control-room notification preference: English, and every
-- channel on. Passengers default to Bangla.
INSERT INTO notify.preferences (user_key, lang, marketing)
VALUES ('control-room', 'en', false)
ON CONFLICT (user_key) DO NOTHING;

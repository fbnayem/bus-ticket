-- The counter clerk's post-sale power: refund a cash ticket from their own drawer.
--
-- Refunding is a separate permission from selling on purpose. A refund puts cash
-- back on the counter, which is a distinct trust from taking it in — an operator
-- may let an agent sell all day and still route refunds through a supervisor. The
-- grant below gives it to the counter agent and the operator's own management; an
-- operator who wants it tighter simply revokes it from the agent role.

INSERT INTO catalog.permissions (permission) VALUES ('counter.refund')
ON CONFLICT DO NOTHING;

INSERT INTO catalog.role_permissions (role_id, permission) VALUES
    ('c0000000-0000-0000-0000-000000000001','counter.refund'), -- SUPER_ADMIN
    ('c0000000-0000-0000-0000-000000000011','counter.refund'), -- OPERATOR_OWNER
    ('c0000000-0000-0000-0000-000000000012','counter.refund'), -- OPERATOR_MANAGER
    ('c0000000-0000-0000-0000-000000000015','counter.refund')  -- COUNTER_AGENT
ON CONFLICT DO NOTHING;

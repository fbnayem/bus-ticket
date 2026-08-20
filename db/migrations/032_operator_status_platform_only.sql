-- Changing an operator's ACCOUNT STATUS (active/suspended/blocked/terminated) is a
-- PLATFORM action, not an operator one. It was guarded by 'operator.write', which
-- was also granted to OPERATOR_OWNER — so any operator owner could suspend,
-- terminate, or re-activate ANY operator, including a competitor or their own
-- suspended account. operator.write guards no operator-facing endpoint (only the
-- status flip), so removing it from OPERATOR_OWNER costs the operator nothing.
--
-- SUPER_ADMIN keeps it by construction (it holds every permission). OPS_ADMIN is
-- the platform role that runs operator lifecycle, so it is granted explicitly.

DELETE FROM catalog.role_permissions
 WHERE role_id = 'c0000000-0000-0000-0000-000000000011' -- OPERATOR_OWNER
   AND permission = 'operator.write';

INSERT INTO catalog.role_permissions (role_id, permission) VALUES
    ('c0000000-0000-0000-0000-000000000005','operator.write') -- OPS_ADMIN
ON CONFLICT DO NOTHING;

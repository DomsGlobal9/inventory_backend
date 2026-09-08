import { Router } from 'express';
import { requirePermission } from '../middleware/permission.middleware';
import {
  listMembers, listRoles, listActivity, inviteMember, updateMemberRole, setMemberStatus,
  viewMemberPassword,
  resendMemberCredentials, setMemberPassword
} from '../controllers/team.controller';

const router = Router();
// Team management is gated by `admin:users` -- granted to SUPER_ADMIN (via wildcard) and
// ADMIN. A per-target hierarchy guard inside team.service.ts additionally blocks ADMIN from
// managing a SUPER_ADMIN's role/status/password -- Super Admin outranks Admin.
router.use(requirePermission('admin:users'));

router.get('/members', listMembers);
router.get('/roles', listRoles);
router.get('/activity', listActivity);
router.post('/members', inviteMember);
router.patch('/members/:id/role', updateMemberRole);
router.patch('/members/:id/status', setMemberStatus);
// POST (not GET) deliberately -- viewing a password is a meaningful, auditable action, and
// only mutation methods flow through auditLogger's activity feed.
router.post('/members/:id/password/view', viewMemberPassword);
// Sends the EXISTING login again -- the alternative when a message goes missing is changing
// the password, which breaks it for anyone already using it to solve a delivery problem.
router.post('/members/:id/credentials/resend', resendMemberCredentials);
router.post('/members/:id/password', setMemberPassword);

export default router;

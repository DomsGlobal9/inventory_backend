import { Router } from 'express';
import { requirePermission } from '../middleware/permission.middleware';
import {
  listRoles, getCatalogue, createRole, updateRole, roleImpact, deleteRole
} from '../controllers/role.controller';

const router = Router();

// Composing roles is managing the team -- the same authority, applied to the shape of a job
// rather than to a person. Deliberately not its own permission: a separate `role:manage` would
// let a shop grant "may decide what everyone can do" to somebody who cannot see the team, which
// is not a job anybody has.
//
// The rules about what a role may actually contain are in services/role-management, not here.
// This gate only answers "may you be on this screen at all".
router.use(requirePermission('admin:users'));

router.get('/', listRoles);
// The permission list as the screen draws it: grouped, in plain language, each one flagged
// with whether THIS person is allowed to hand it out.
router.get('/catalogue', getCatalogue);
router.post('/', createRole);
router.patch('/:id', updateRole);
// POST, not GET: it takes the proposed permission list in the body so the screen can say who
// loses what BEFORE the change is saved, while the person is still deciding.
router.post('/:id/impact', roleImpact);
router.delete('/:id', deleteRole);

export default router;

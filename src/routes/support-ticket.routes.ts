import { Router } from 'express';
import { createTicket, listMyClientTickets, getMyClientTicket, replyToMyClientTicket } from '../controllers/support-ticket.controller';

const router = Router();
router.get('/', listMyClientTickets);
router.post('/', createTicket);
router.get('/:id', getMyClientTicket);
router.post('/:id/messages', replyToMyClientTicket);

export default router;

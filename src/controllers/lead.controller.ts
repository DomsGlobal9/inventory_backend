import { Request, Response, NextFunction } from 'express';
import { leadService } from '../services/lead.service';
import {
  createLeadSchema,
  updateLeadSchema,
  convertLeadSchema,
  listLeadsSchema
} from '../validations/lead.schema';

/** Public. No authentication, and it must never provision anything -- see lead.service.ts. */
export const submitLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createLeadSchema.parse(req.body);
    const result = await leadService.create({
      ...data,
      // req.ip is trustworthy here because server.ts sets `trust proxy` to 1 in production,
      // so it resolves to the client rather than to Render's load balancer.
      sourceIp: req.ip,
      userAgent: req.get('user-agent') || undefined
    });

    res.status(201).json({
      success: true,
      // The response is identical whatever we hold, so it cannot be used to test whether an
      // address or business is already known to us.
      message: "Thanks -- we've got your details and someone will be in touch shortly.",
      data: result
    });
  } catch (error) {
    next(error);
  }
};

export const listLeads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = listLeadsSchema.parse(req.query);
    const result = await leadService.list(params);
    res.json({ success: true, data: result.items, meta: result.meta });
  } catch (error) {
    next(error);
  }
};

export const updateLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateLeadSchema.parse(req.body);
    const lead = await leadService.update(String(req.params.id), data);
    res.json({ success: true, data: lead });
  } catch (error) {
    next(error);
  }
};

export const convertLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overrides = convertLeadSchema.parse(req.body || {});
    const result = await leadService.convert(String(req.params.id), overrides);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

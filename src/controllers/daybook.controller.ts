import { Request, Response, NextFunction } from 'express';
import { dayBookService } from '../services/daybook.service';
import { isValidDayKey } from '../utils/businessDay';

const tenant = (req: Request) => (req as any).user?.clientId as string;

export const getDayBook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dayKey = String(req.query.date || '');
    const locationId = req.query.locationId ? String(req.query.locationId) : undefined;

    // Validated before it reaches a date calculation: "2026-02-31" would otherwise roll into
    // March and silently report the wrong day.
    if (dayKey && !isValidDayKey(dayKey)) {
      throw Object.assign(new Error('Provide a date as YYYY-MM-DD.'), { statusCode: 400 });
    }

    const data = dayKey
      ? await dayBookService.getDay(tenant(req), dayKey, locationId)
      : await dayBookService.getToday(tenant(req), locationId);

    res.json({ success: true, data });
  } catch (error) { next(error); }
};

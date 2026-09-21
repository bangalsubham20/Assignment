import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { searchService } from './search.service';

export const searchRouter = Router();

const searchQuerySchema = z.object({
  specialty: z.string().optional(),
  maxFee: z.string().optional().transform((val) => (val ? parseFloat(val) : undefined)),
  minRating: z.string().optional().transform((val) => (val ? parseFloat(val) : undefined)),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
  offset: z.string().optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
});

searchRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = searchQuerySchema.parse(req.query);
    const results = await searchService.searchDoctors(validated);
    res.status(200).json(results);
  } catch (err) {
    next(err);
  }
});

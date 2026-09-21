import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../infrastructure/telemetry/logger';

export class AppError extends Error {
  public statusCode: number;
  public details?: any;

  constructor(message: string, statusCode: number = 400, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const correlationId = req.correlationId || 'unknown';

  // 1. Zod Validation Error
  if (err instanceof ZodError) {
    res.status(400).json({
      type: 'https://amrutam.global/errors/validation-error',
      title: 'Validation Failed',
      status: 400,
      detail: 'The submitted request payload does not conform to required schema specifications.',
      invalidParams: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
      correlationId,
    });
    return;
  }

  // 2. Custom AppError
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      type: 'https://amrutam.global/errors/application-error',
      title: err.message,
      status: err.statusCode,
      detail: err.message,
      extra: err.details,
      correlationId,
    });
    return;
  }

  // 3. Fallback Internal Server Error (RFC 7807)
  logger.error('Unhandled Exception in Request Pipeline', {
    error: err.message,
    stack: err.stack,
    correlationId,
    url: req.originalUrl,
  });

  res.status(500).json({
    type: 'https://amrutam.global/errors/internal-server-error',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected server error occurred. Our site reliability team has been notified.',
    correlationId,
  });
};

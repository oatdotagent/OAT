/** Application-level error with a stable machine-readable code and HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('validation_error', message, 400, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError('unauthorized', message, 401);
export const forbidden = (message = 'Insufficient permissions') => new AppError('forbidden', message, 403);
// Ownership failures surface as 404 so record IDs cannot be probed.
export const notFound = (resource: string) => new AppError('not_found', `${resource} not found`, 404);
export const conflict = (message: string) => new AppError('conflict', message, 409);

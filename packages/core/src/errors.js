// @ts-check

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, details?: unknown, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code ?? 'APP_ERROR';
    this.status = options.status ?? 500;
    this.details = options.details;
  }
}

export class ValidationError extends AppError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}

export class NotFoundError extends AppError {
  /** @param {string} entity @param {string} id */
  constructor(entity, id) {
    super(`${entity} not found: ${id}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { entity, id },
    });
  }
}

export class ConflictError extends AppError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: 'CONFLICT', status: 409, details });
  }
}

export class ForbiddenError extends AppError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: 'FORBIDDEN', status: 403, details });
  }
}

/** @param {unknown} error */
export function normalizeError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(error.message, { cause: error });
  }
  return new AppError('Unknown error', { details: error });
}

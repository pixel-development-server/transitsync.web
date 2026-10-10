import { unprocessable } from './errors.js';

/**
 * Wrap an async route handler so rejected promises reach Express' error pipeline.
 */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Validate `req[source]` against a Zod schema and replace it with the parsed
 * value (so downstream handlers get coerced types, not raw strings).
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
        code: issue.code,
      }));
      return next(unprocessable('Validation failed.', details));
    }
    if (source === 'query') {
      // Express 5 makes req.query a getter; assign field-by-field to stay safe.
      for (const [key, value] of Object.entries(result.data)) req.query[key] = value;
    } else {
      req[source] = result.data;
    }
    return next();
  };
}

export function parsePagination(query, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

export function paginationMeta({ total, limit, page }) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    total,
    limit,
    page,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export default { asyncHandler, validate, parsePagination, paginationMeta };

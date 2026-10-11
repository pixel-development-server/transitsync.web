import config from '../config/env.js';
import { AppError } from '../lib/errors.js';

export function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No API route matches ${req.method} ${req.originalUrl}`,
    },
  });
}

/** Map driver-level constraint violations onto meaningful 4xx responses. */
function translateDatabaseError(error) {
  const message = String(error?.message ?? '');

  if (message.includes('UNIQUE constraint failed')) {
    const columns = message.split('UNIQUE constraint failed:')[1]?.trim() ?? '';
    return new AppError(409, `A record with that ${humaniseColumns(columns)} already exists.`, {
      code: 'DUPLICATE',
      details: [{ field: 'value', message: `${humaniseColumns(columns)} is already in use.` }],
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new AppError(409, 'That operation references a record which is still in use.', {
      code: 'FK_VIOLATION',
    });
  }
  if (message.includes('CHECK constraint failed')) {
    return new AppError(422, 'A value is outside the allowed range for this field.', {
      code: 'CONSTRAINT_VIOLATION',
      details: [{ field: 'value', message: 'A value is outside the allowed range for this field.' }],
    });
  }
  if (message.includes('no such column')) {
    return new AppError(500, 'The database schema is out of date. Run `npm run migrate`.', {
      code: 'SCHEMA_DRIFT',
    });
  }
  return null;
}

function humaniseColumns(columns) {
  return columns
    .split(',')
    .map((column) => column.trim().split('.').pop())
    .filter(Boolean)
    .join(', ');
}

/** Terminal error handler. Keeps internals out of responses in production. */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(error, req, res, next) {
  let status = error.status ?? error.statusCode ?? 500;
  let code = error.code ?? 'INTERNAL_ERROR';
  let message = error.message ?? 'Something went wrong.';
  let details = error.details ?? null;

  if (error.name === 'ZodError') {
    status = 422;
    code = 'VALIDATION_FAILED';
    message = 'Validation failed.';
    details = error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
  } else if (!(error instanceof AppError)) {
    const translated = translateDatabaseError(error);
    if (translated) {
      status = translated.status;
      code = translated.code;
      message = translated.message;
      details = translated.details;
    }
  }

  const isServerFault = status >= 500;
  if (isServerFault) {
    process.stderr.write(
      `[error] ${req.method} ${req.originalUrl} -> ${status} ${code}\n${error.stack ?? error.message}\n`,
    );
  }

  const responseMessage = isServerFault && config.isProduction ? 'An unexpected server error occurred.' : message;

  res.status(status).json({
    success: false,
    message: responseMessage,
    error: {
      code,
      message: responseMessage,
      ...(details && !isServerFault ? { details } : {}),
      ...(config.isProduction || !isServerFault
        ? {}
        : { debug: { stack: String(error.stack ?? '').split('\n').slice(0, 6) } }),
    },
  });
}

export default { errorHandler, notFoundHandler };

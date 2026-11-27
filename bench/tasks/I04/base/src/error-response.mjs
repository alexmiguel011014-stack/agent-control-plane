import { AppError } from './app-error.mjs';

export function toErrorResponse(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message },
    };
  }

  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: error?.message ?? String(error) },
  };
}

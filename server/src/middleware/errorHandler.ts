import { NextFunction, Request, Response } from 'express'

/**
 * Uniform error envelope: { error: { code, message } }. Throw objects with
 * { status, code, message } (or use http-errors style) anywhere in a route.
 *
 * 5xx messages are replaced with a generic string by default, because an
 * unexpected server error's message is a stack-adjacent internal detail (a
 * driver error naming a table, a filesystem path) and does not belong in a
 * response. A handler that has written a 5xx message deliberately FOR the user
 * can opt out by setting `expose` — see apiError below.
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const status = typeof err?.status === 'number' ? err.status : 500
  const code = typeof err?.code === 'string' ? err.code : 'INTERNAL'
  const safeToShow = status < 500 || err?.expose === true
  const message = safeToShow ? String(err?.message ?? 'Request failed') : 'Internal server error'
  if (status >= 500) console.error('[error]', err)
  res.status(status).json({ error: { code, message } })
}

export interface ApiErrorObject extends Error {
  status: number
  code: string
  /** True when `message` was written for the user and may be returned as-is. */
  expose?: boolean
}

/**
 * Convenience for throwing API errors: `throw apiError(400, 'BAD_INPUT', '…')`
 *
 * Pass `expose` on a 5xx when the message is one you have written for the
 * person reading it, e.g. "we could not send your sign-in code". Anything
 * below 500 is shown regardless.
 */
export function apiError(status: number, code: string, message: string, expose = false): ApiErrorObject {
  const e = new Error(message) as ApiErrorObject
  e.status = status
  e.code = code
  if (expose) e.expose = true
  return e
}

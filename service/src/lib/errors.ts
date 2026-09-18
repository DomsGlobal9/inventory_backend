// Every error a person may see is plain English. Routes throw AppError; the error handler
// turns it into `{ error: { code, message } }` and never shows a stack trace.

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message: string, extra?: Record<string, unknown>) => new AppError(400, 'bad_request', message, extra),
  unauthorized: () => new AppError(401, 'unauthorized', 'This key is not valid for the WhatsApp service.'),
  forbidden: (message: string) => new AppError(403, 'forbidden', message),
  notFound: (message: string) => new AppError(404, 'not_found', message),
  conflict: (message: string, extra?: Record<string, unknown>) => new AppError(409, 'conflict', message, extra),
  tooLarge: (message: string) => new AppError(413, 'too_large', message),
  notLinked: () =>
    new AppError(409, 'not_linked', "This shop's WhatsApp is not linked. Link it in Settings → WhatsApp."),
  disconnected: () =>
    new AppError(
      409,
      'disconnected',
      "This shop's WhatsApp is disconnected. Reconnect it in Settings → WhatsApp, then try again.",
    ),
  scaleezyNotConnected: () =>
    new AppError(503, 'scaleezy_not_connected', "ScaleEzy's WhatsApp number is not connected right now. Please try again later."),
  engineUnavailable: () =>
    new AppError(503, 'engine_unavailable', 'WhatsApp is not reachable right now. Please try again in a few minutes.'),
  internal: () => new AppError(500, 'internal', 'Something went wrong on our side. Please try again.'),
};

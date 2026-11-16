/**
 * Carrier error taxonomy — ported from shipping-cli
 * (`src/shipping_cli/exceptions.py`): ShippingError base + AuthenticationError,
 * RateLimitError, ConfigurationError, ValidationError, APIError.
 *
 * The logistics services translate these into the pinned route error contract
 * (`UpstreamHttpError` / `UpstreamUnavailableError`) so the HTTP responses
 * stay byte-identical to the legacy upstream shapes.
 */

/** Base error for every carrier operation. */
export class CarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarrierError";
  }
}

/** Carrier OAuth authentication failed (token request rejected). */
export class CarrierAuthError extends CarrierError {
  constructor(message: string) {
    super(message);
    this.name = "CarrierAuthError";
  }
}

/** Carrier answered with a non-2xx status. */
export class CarrierApiError extends CarrierError {
  readonly status: number;
  readonly body: unknown;

  constructor(args: { status: number; message: string; body?: unknown }) {
    super(args.message);
    this.name = "CarrierApiError";
    this.status = args.status;
    this.body = args.body;
  }
}

/** Carrier credentials / configuration missing. */
export class CarrierConfigError extends CarrierError {
  constructor(message: string) {
    super(message);
    this.name = "CarrierConfigError";
  }
}

/** Carrier rejected the request as invalid (validation). */
export class CarrierValidationError extends CarrierError {
  constructor(message: string) {
    super(message);
    this.name = "CarrierValidationError";
  }
}

/** Carrier rate limit exceeded. */
export class CarrierRateLimitError extends CarrierError {
  constructor(message: string) {
    super(message);
    this.name = "CarrierRateLimitError";
  }
}

/** Carrier could not be reached (network / timeout). */
export class CarrierUnavailableError extends CarrierError {
  constructor(cause?: unknown, message?: string) {
    super(message ?? "Carrier is unavailable");
    this.name = "CarrierUnavailableError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

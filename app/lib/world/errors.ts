export type WorldIntegrationErrorCode =
  | "configuration"
  | "cancelled"
  | "invalid_request"
  | "invalid_response"
  | "invalid_proof"
  | "verification_unavailable"
  | "invalid_callback"
  | "expired_transaction"
  | "authentication_failed";

/** Safe-to-return error code for World integration failures. Never attach proof or token payloads. */
export class WorldIntegrationError extends Error {
  readonly code: WorldIntegrationErrorCode;

  constructor(code: WorldIntegrationErrorCode) {
    super(code);
    this.name = "WorldIntegrationError";
    this.code = code;
  }
}

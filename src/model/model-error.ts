export type ModelAdapterErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "invalid_response"
  | "authentication_failed"
  | "rate_limited"
  | "timed_out"
  | "cancelled"
  | "provider_failed";

export class ModelAdapterError extends Error {
  public readonly code: ModelAdapterErrorCode;

  public constructor(code: ModelAdapterErrorCode, message: string) {
    super(message);
    this.name = "ModelAdapterError";
    this.code = code;
  }
}

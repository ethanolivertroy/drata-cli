export class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CliError";
    this.cliCode = code;
    this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new CliError(code, message, details);
}

export function serializeError(error) {
  if (error instanceof CliError) {
    return {
      code: error.cliCode,
      message: error.message,
      details: error.details ?? null,
    };
  }

  return {
    code: typeof error?.code === "string" ? error.code.toLowerCase() : "internal_error",
    message: error?.message ?? String(error),
    details: error?.details ?? null,
  };
}


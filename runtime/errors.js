/** Ego-compatible error helpers (docs/native-bindings-api.md:64-106). */

export function invalidArgument(message) {
  const error = new TypeError(message);
  error.error_code = "EGO_INVALID_ARGUMENT";
  return error;
}

export function egoError(message, errorCode) {
  const error = new Error(message);
  if (errorCode) error.error_code = errorCode;
  return error;
}

/** A resolved error object, which invokeEgo() turns into a thrown Error. */
export function errorResult(message, errorCode) {
  return { error: message, error_code: errorCode };
}

export function assertNoExtraArgs(name, provided, allowed) {
  if (provided > allowed) {
    throw invalidArgument(
      `${name} accepts ${allowed} argument${allowed === 1 ? "" : "s"}, got ${provided}`,
    );
  }
}

export function assertString(name, value) {
  if (typeof value !== "string") {
    throw invalidArgument(`${name} requires a string, got ${describe(value)}`);
  }
}

export function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}

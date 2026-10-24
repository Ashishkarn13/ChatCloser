// src/core/errors.js
// Typed application errors. The HTTP layer maps `status` straight onto the
// response code and `expose` decides whether the message may be shown to a
// user. Anything that is not exposed is logged rather than returned.

export class AppError extends Error {
  constructor(message, { status = 400, code = "app_error", expose = true, details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 422, code: "validation_failed", details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, { status: 404, code: "not_found" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that") {
    super(message, { status: 403, code: "forbidden" });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Sign in required") {
    super(message, { status: 401, code: "unauthorized" });
  }
}

export class ConflictError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 409, code: "conflict", details });
  }
}

export class StateTransitionError extends AppError {
  constructor(from, to, allowed) {
    super(`Cannot move an order from "${from}" to "${to}". Allowed next states: ${allowed.join(", ")}.`, {
      status: 409,
      code: "invalid_state_transition",
      details: { from, to, allowed },
    });
  }
}

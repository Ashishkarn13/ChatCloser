// src/server/app.js
// The HTTP application: sessions, CSRF, security headers, login throttling
// and the shared authentication/authorisation helpers.
//
// The admin panel (dashboard/server.js) and the JSON API
// (src/server/routes/api.js) are both mounted on top of this.

import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import { config } from "../config.js";
import { SqliteSessionStore } from "./session-store.js";
import { can, canAny, PERMISSIONS } from "../core/rbac.js";
import { ForbiddenError, UnauthorizedError } from "../core/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Creates the Express application with all the shared middleware. */
export function createApp({ businessId = config.defaultBusinessId } = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // ---------- security headers ----------
  app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.locals.cspNonce = nonce;
    req.cspNonce = nonce;

    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");

    next();
  });

  // ---------- body parsing ----------
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));

  // ---------- sessions ----------
  app.use(
    session({
      name: "chatcloser.sid",
      secret: config.sessionSecret || "insecure-development-secret-change-me",
      resave: false,
      saveUninitialized: false,
      store: new SqliteSessionStore(),
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
        maxAge: 1000 * 60 * 60 * 12,
      },
    })
  );

  // ---------- CSRF ----------
  // A session token plus a double-submit cookie. HTML forms get the token
  // injected by the layout; the JSON API sends it in a header.
  app.use((req, res, next) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    }
    res.cookie("csrf_token", req.session.csrfToken, {
      httpOnly: false,
      sameSite: "lax",
      secure: config.cookieSecure,
    });
    next();
  });

  /**
   * Regenerates the session id — used after a successful sign-in so a
   * session id that an attacker planted cannot be reused. The CSRF token is
   * rotated with it and the cookie is re-issued.
   */
  app.locals.regenerateSession = (req, res, data, done) => {
    req.session.regenerate((err) => {
      if (err) return done(err);
      Object.assign(req.session, data);
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      res.cookie("csrf_token", req.session.csrfToken, {
        httpOnly: false,
        sameSite: "lax",
        secure: config.cookieSecure,
      });
      req.session.save((saveErr) => done(saveErr));
    });
  };

  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const sent =
      req.get("x-csrf-token") ||
      req.body?._csrf ||
      req.query?._csrf;

    const expected = req.session?.csrfToken;
    const cookieValue = req.cookies?.csrf_token;

    const valid =
      typeof sent === "string" &&
      sent.length > 0 &&
      typeof expected === "string" &&
      sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected)) &&
      (!cookieValue || cookieValue === sent);

    if (!valid) {
      return res.status(403).json({ error: "Invalid or missing CSRF token." });
    }
    return next();
  });

  // ---------- authentication helpers ----------
  app.use((req, res, next) => {
    req.user = req.session?.username
      ? {
          username: req.session.username,
          role: req.session.role,
          businessId: req.session.businessId ?? businessId,
          permissions: req.session.permissions || {},
        }
      : null;
    next();
  });

  app.use((req, res, next) => {
    if (!req.user) {
      // The sign-in page and the health probe must stay reachable.
      if (req.path === "/login" || req.path === "/login/" || req.path === "/health") {
        return next();
      }
      if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Sign in required." });
      }
      return res.redirect("/login");
    }
    next();
  });

  // A session that has not been bound to a business yet is bound now.
  app.use((req, res, next) => {
    if (req.session && !req.session.businessId) {
      req.session.businessId = businessId;
    }
    if (req.user) req.user.businessId = req.session.businessId ?? businessId;
    next();
  });

  // ---------- helpers exposed to routers ----------
  app.locals.requirePermission = (permission) => (req, res, next) => {
    if (can(req.user, permission)) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(403).json({ error: `You do not have the "${permission}" permission.` });
    }
    return next();
  };

  app.locals.requireAnyPermission = (permissions) => (req, res, next) => {
    if (canAny(req.user, permissions)) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(403).json({ error: "You do not have permission to do that." });
    }
    return next();
  };

  app.locals.requireOwner = (req, res, next) => {
    if (req.user?.role === "owner") return next();
    if (req.path.startsWith("/api/")) {
      return res.status(403).json({ error: "Owner access required." });
    }
    return next();
  };

  return app;
}

/** Escapes text for safe interpolation into HTML. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wraps a handler so thrown errors become clean responses. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export { PERMISSIONS, can, canAny };

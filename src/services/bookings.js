// src/services/bookings.js
// Appointments, site visits, table bookings and service slots.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str } from "../core/validation.js";

export const BOOKING_STATUSES = ["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"];

export function listBookings(
  businessId,
  { status = null, from = null, to = null, assignedTo = null, limit = 200 } = {}
) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (assignedTo) {
    where.push("assigned_to = ?");
    params.push(assignedTo);
  }
  if (from) {
    where.push("starts_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("starts_at <= ?");
    params.push(to);
  }
  params.push(Math.min(Number(limit) || 200, 500));

  return db
    .prepare(`SELECT * FROM bookings WHERE ${where.join(" AND ")} ORDER BY starts_at ASC LIMIT ?`)
    .all(...params);
}

export function getBooking(businessId, bookingId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bookings WHERE business_id = ? AND id = ?").get(businessId, bookingId);
  if (!row) throw new NotFoundError("No such booking.");
  return row;
}

export function createBooking(businessId, input, actor = "system") {
  const db = getDb();
  const startsAt = str(input.startsAt, { field: "startsAt", required: true, max: 40 });
  if (Number.isNaN(new Date(startsAt).getTime())) {
    throw new ValidationError("startsAt must be a valid date and time.");
  }

  const duration = Number(input.durationMinutes) || 60;
  const endsAt = new Date(new Date(startsAt).getTime() + duration * 60_000).toISOString();

  const info = db
    .prepare(
      `INSERT INTO bookings
         (business_id, customer_id, service_id, title, starts_at, ends_at, status, assigned_to, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    )
    .run(
      businessId,
      input.customerId ?? null,
      input.serviceId ?? null,
      str(input.title, { field: "title", max: 200 }) || "Appointment",
      startsAt,
      endsAt,
      str(input.assignedTo, { field: "assignedTo", max: 100 }),
      str(input.notes, { field: "notes", max: 2000 })
    );

  const id = Number(info.lastInsertRowid);
  const reference = `BK-${new Date().getFullYear()}-${String(id).padStart(4, "0")}`;
  db.prepare("UPDATE bookings SET title = COALESCE(NULLIF(title,''), ?) WHERE id = ?").run(reference, id);

  audit({
    businessId,
    actor,
    action: "booking.created",
    details: { booking_id: id, starts_at: startsAt },
  });

  return getBooking(businessId, id);
}

export function updateBooking(businessId, bookingId, fields, actor = "system") {
  const db = getDb();
  const current = getBooking(businessId, bookingId);

  const status = fields.status !== undefined ? fields.status : current.status;
  if (!BOOKING_STATUSES.includes(status)) {
    throw new ValidationError(`Status must be one of: ${BOOKING_STATUSES.join(", ")}.`);
  }

  db.prepare(
    `UPDATE bookings SET status = ?, assigned_to = ?, notes = ?, title = ?, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND id = ?`
  ).run(
    status,
    fields.assignedTo !== undefined ? str(fields.assignedTo, { field: "assignedTo", max: 100 }) : current.assigned_to,
    fields.notes !== undefined ? str(fields.notes, { field: "notes", max: 2000 }) : current.notes,
    fields.title !== undefined ? str(fields.title, { field: "title", max: 200 }) : current.title,
    businessId,
    bookingId
  );

  audit({ businessId, actor, action: "booking.updated", details: { booking_id: bookingId, status } });
  return getBooking(businessId, bookingId);
}

export function cancelBooking(businessId, bookingId, actor = "system", reason = "") {
  return updateBooking(businessId, bookingId, { status: "cancelled", notes: reason }, actor);
}

/** Bookings that start within the next `hours` and have not been reminded. */
export function upcomingBookings(businessId, hours = 24) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM bookings
       WHERE business_id = ? AND status IN ('scheduled', 'confirmed')
         AND reminder_sent = 0
         AND datetime(starts_at) BETWEEN datetime('now') AND datetime('now', ?)
       ORDER BY starts_at ASC`
    )
    .all(businessId, `+${hours} hours`);
}

export function markReminded(businessId, bookingId) {
  const db = getDb();
  db.prepare("UPDATE bookings SET reminder_sent = 1 WHERE business_id = ? AND id = ?").run(businessId, bookingId);
}

// src/services/ai/tools/service-tools.js
// Bookings, support tickets and scheduled follow-ups.

import { getDb } from "../../../db/connection.js";
import { audit } from "../../../core/audit.js";
import { createBooking as createBookingService } from "../../bookings.js";
import { createTask } from "../../tasks.js";
import { scheduleMessage } from "../../scheduler.js";
import { ValidationError } from "../../../core/errors.js";

export async function createBooking(ctx, args) {
  const booking = createBookingService(ctx.businessId, {
    customerId: ctx.customerId,
    serviceId: args.serviceId ? Number(args.serviceId) : null,
    title: args.serviceName || "Appointment",
    startsAt: args.startsAt,
    durationMinutes: args.durationMinutes ? Number(args.durationMinutes) : 60,
    customerName: args.customerName,
    phone: args.phone,
    notes: args.notes,
  });

  if (typeof ctx.sendMessage === "function") {
    await ctx.sendMessage(
      `Your appointment is booked for ${booking.startsAt}. Reference: ${booking.reference}.`
    );
  }

  return { ok: true, bookingId: booking.id, reference: booking.reference, startsAt: booking.starts_at };
}

export async function createSupportTicket(ctx, args) {
  const task = createTask(ctx.businessId, {
    title: args.title,
    description: args.description,
    priority: args.priority || "normal",
    assignedTo: "",
    entityType: "conversation",
    entityId: ctx.threadId || null,
    createdBy: ctx.actor || "ai",
  });

  audit({
    businessId: ctx.businessId,
    actor: ctx.actor || "ai",
    action: "ai.support_ticket_created",
    details: { task_id: task.id, title: args.title },
  });

  return { ok: true, ticketId: task.id, message: "A team member will pick this up." };
}

export async function scheduleFollowUp(ctx, args) {
  const sendAt = new Date(args.sendAt);
  if (Number.isNaN(sendAt.getTime())) {
    throw new ValidationError("sendAt must be a valid date and time.");
  }
  if (sendAt.getTime() < Date.now() - 60_000) {
    throw new ValidationError("sendAt must be in the future.");
  }

  const scheduled = scheduleMessage(ctx.businessId, {
    threadId: ctx.threadId,
    chatId: ctx.chatId,
    body: args.message,
    sendAt: sendAt.toISOString(),
    reason: args.reason || "",
  });

  return { ok: true, scheduledId: scheduled.id, sendAt: scheduled.send_at };
}

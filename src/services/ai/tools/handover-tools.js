// src/services/ai/tools/handover-tools.js
// Handing a conversation to a human.

import { takeoverThread } from "../../conversations.js";

export async function requestHumanTakeover(ctx, args) {
  const result = takeoverThread(ctx.businessId, ctx.threadId, {
    actor: ctx.actor || "ai",
    reason: args.reason || "Requested by the assistant",
    summary: args.handoverSummary || "",
  });

  if (typeof ctx.sendMessage === "function") {
    await ctx.sendMessage(
      "I'm passing this to a member of our team, who will get back to you shortly."
    );
  }

  return {
    ok: true,
    handedOver: true,
    threadId: ctx.threadId,
    reason: args.reason,
    detail: result,
  };
}

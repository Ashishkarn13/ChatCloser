// src/services/ai/tools/definitions.js
// The tools the AI may ask the backend to perform.
//
// Every tool declares:
//
//   name              unique identifier the model uses
//   description       what the tool does and when to use it
//   inputSchema       JSON Schema for the arguments
//   outputSchema      JSON Schema for the result
//   requiredPermissions  RBAC permissions the *business* must have granted
//   sideEffects       "read" | "write" | "transactional"
//   approvalRequired  true when a human must approve before it runs
//   idempotent        whether repeating the call with the same input is safe
//   handler           the implementation (ctx, args) -> result
//
// The model never runs any of this code itself. It proposes a call; this
// layer validates the arguments, checks the business's permissions and
// approval settings, executes the operation against the real database and
// returns a structured result. Only after that does the model see anything.

import {
  searchProducts,
  getProductDetails,
  checkStock,
  calculateQuote,
  getDeliveryOptions,
} from "./catalog-tools.js";
import {
  createOrderDraft,
  submitOrderForConfirmation,
  confirmCustomerOrder,
  getOrderStatus,
  cancelOrder,
} from "./order-tools.js";
import { createBooking, createSupportTicket, scheduleFollowUp } from "./service-tools.js";
import { getPaymentStatus } from "./payment-tools.js";
import { requestHumanTakeover } from "./handover-tools.js";
import { captureLead, closeSale } from "./legacy-tools.js";

export const TOOL_DEFINITIONS = [
  // ---------- read-only catalogue tools ----------

  {
    name: "search_products",
    description:
      "Find products or services in the business catalogue by name, description, SKU or barcode. Use this before quoting anything. Returns verified names and prices from the catalogue — never quote a price that did not come back from this tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the customer is asking about" },
        limit: { type: "integer", description: "Maximum number of results (1-20)", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        results: { type: "array" },
        count: { type: "integer" },
      },
    },
    requiredPermissions: ["catalog.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: searchProducts,
  },
  {
    name: "get_product_details",
    description:
      "Full details of one catalogue item: description, price, tax rate, unit, stock availability and any attributes. Use after search_products when the customer asks a follow-up question about a specific item.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "integer", description: "Catalogue item id" },
        name: { type: "string", description: "Item name, if the id is unknown" },
      },
    },
    outputSchema: { type: "object", properties: { product: { type: "object" } } },
    requiredPermissions: ["catalog.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: getProductDetails,
  },
  {
    name: "check_stock",
    description:
      "How many units of an item are available right now, and whether the requested quantity can be supplied. Use before promising a delivery date.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "integer" },
        name: { type: "string" },
        variantId: { type: "integer" },
        quantity: { type: "number", minimum: 0 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        available: { type: "number" },
        canSupply: { type: "boolean" },
      },
    },
    requiredPermissions: ["inventory.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: checkStock,
  },
  {
    name: "calculate_quote",
    description:
      "Price a list of catalogue items and return the exact subtotal, discount, tax, delivery charge and total. Use this to build the order summary. The figures come from the backend's pricing rules, not from your own arithmetic.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Items to price",
          items: {
            type: "object",
            properties: {
              productId: { type: "integer" },
              name: { type: "string" },
              variantId: { type: "integer" },
              quantity: { type: "number", minimum: 0 },
            },
          },
        },
        discountAmount: { type: "number", minimum: 0 },
      },
      required: ["items"],
    },
    outputSchema: {
      type: "object",
      properties: {
        subtotal: { type: "number" },
        taxAmount: { type: "number" },
        deliveryAmount: { type: "number" },
        total: { type: "number" },
        currency: { type: "string" },
      },
    },
    requiredPermissions: ["catalog.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: calculateQuote,
  },
  {
    name: "get_delivery_options",
    description:
      "The delivery charge, free-delivery threshold and service area for this business. Use it when the customer asks about delivery cost or timing.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: { type: "object", properties: {} },
    requiredPermissions: ["orders.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: getDeliveryOptions,
  },

  // ---------- order tools ----------

  {
    name: "create_order_draft",
    description:
      "Prepare an order summary for the customer to approve. This does NOT create an order and does NOT charge anything — it produces a priced summary and asks the customer to confirm. Always show the summary and wait for an explicit yes before calling confirm_customer_order.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              productId: { type: "integer" },
              name: { type: "string" },
              variantId: { type: "integer" },
              quantity: { type: "number", minimum: 0 },
            },
          },
        },
        customerName: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
        locality: { type: "string" },
        district: { type: "string" },
        municipality: { type: "string" },
        ward: { type: "string" },
        notes: { type: "string" },
      },
      required: ["items"],
    },
    outputSchema: {
      type: "object",
      properties: {
        draftId: { type: "integer" },
        summary: { type: "string" },
        total: { type: "number" },
        currency: { type: "string" },
        problems: { type: "array" },
      },
    },
    requiredPermissions: ["orders.create"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: false,
    handler: createOrderDraft,
  },
  {
    name: "submit_order_for_confirmation",
    description:
      "Send the prepared order summary to the customer and ask them to confirm. Use this once a draft exists and the summary is ready to be shown.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "integer" },
      },
      required: ["draftId"],
    },
    outputSchema: { type: "object", properties: { sent: { type: "boolean" } } },
    requiredPermissions: ["orders.create"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: true,
    handler: submitOrderForConfirmation,
  },
  {
    name: "confirm_customer_order",
    description:
      "Turn a confirmed draft into a real order. ONLY call this when the customer has explicitly agreed to the exact items, quantities and total (for example they replied 'yes', 'confirm', 'ठीक छ' or 'जमा गरिदिनुस्'). Never call it based on your own reading of the conversation. If the price changed since the draft was shown, the call fails and you must ask the customer to confirm the new total.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "integer" },
        confirmationText: {
          type: "string",
          description: "The customer's own words that constitute the approval",
        },
      },
      required: ["draftId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        orderId: { type: "integer" },
        orderNumber: { type: "string" },
        total: { type: "number" },
        status: { type: "string" },
      },
    },
    requiredPermissions: ["orders.create"],
    sideEffects: "transactional",
    approvalRequired: false,
    idempotent: true,
    handler: confirmCustomerOrder,
  },
  {
    name: "get_order_status",
    description:
      "The current state of an order — confirmed, processing, dispatched, delivered — and its payment status. Use when a customer asks about an existing order.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "integer" },
        orderNumber: { type: "string" },
      },
    },
    outputSchema: { type: "object", properties: { order: { type: "object" } } },
    requiredPermissions: ["orders.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: getOrderStatus,
  },
  {
    name: "cancel_order",
    description:
      "Cancel an order that has not yet been dispatched. This releases reserved stock. Use only when the customer explicitly asks to cancel.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "integer" },
        reason: { type: "string" },
      },
      required: ["orderId"],
    },
    outputSchema: { type: "object", properties: { cancelled: { type: "boolean" } } },
    requiredPermissions: ["orders.cancel"],
    sideEffects: "transactional",
    approvalRequired: true,
    idempotent: true,
    handler: cancelOrder,
  },

  // ---------- service tools ----------

  {
    name: "create_booking",
    description:
      "Book an appointment, service visit or table. Collect the date/time and any details the business requires before calling this.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: { type: "integer" },
        serviceName: { type: "string" },
        startsAt: { type: "string", description: "ISO date and time" },
        durationMinutes: { type: "integer", minimum: 5 },
        customerName: { type: "string" },
        phone: { type: "string" },
        notes: { type: "string" },
      },
      required: ["startsAt"],
    },
    outputSchema: {
      type: "object",
      properties: { bookingId: { type: "integer" }, startsAt: { type: "string" } },
    },
    requiredPermissions: ["bookings.edit"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: false,
    handler: createBooking,
  },
  {
    name: "create_support_ticket",
    description:
      "Raise a support ticket for the human team. Use for problems the assistant cannot resolve itself — a complaint, a fault with a delivered item, a request for a refund.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      },
      required: ["title", "description"],
    },
    outputSchema: { type: "object", properties: { ticketId: { type: "integer" } } },
    requiredPermissions: ["orders.create"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: false,
    handler: createSupportTicket,
  },
  {
    name: "schedule_follow_up",
    description:
      "Arrange for the business to follow up with this customer later (a quotation follow-up, a delivery check, a reminder). The message is sent by the platform, not by you.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        sendAt: { type: "string", description: "ISO date and time" },
        reason: { type: "string" },
      },
      required: ["message", "sendAt"],
    },
    outputSchema: { type: "object", properties: { scheduledId: { type: "integer" } } },
    requiredPermissions: ["orders.create"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: false,
    handler: scheduleFollowUp,
  },

  // ---------- payment tools ----------

  {
    name: "get_payment_status",
    description:
      "The verified payment status of an order. Returns what the payment provider confirmed — never what a customer claims to have paid.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "integer" },
        orderNumber: { type: "string" },
      },
    },
    outputSchema: { type: "object", properties: { status: { type: "string" } } },
    requiredPermissions: ["payments.view"],
    sideEffects: "read",
    approvalRequired: false,
    idempotent: true,
    handler: getPaymentStatus,
  },

  // ---------- handover tools ----------

  {
    name: "request_human_takeover",
    description:
      "Hand the conversation to a human member of staff and stop replying automatically. Use this when the customer asks for a person, when you are not confident, or when the issue is sensitive.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        handoverSummary: { type: "string", description: "What the human needs to know" },
      },
      required: ["reason"],
    },
    outputSchema: { type: "object", properties: { handedOver: { type: "boolean" } } },
    requiredPermissions: ["conversations.takeover"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: true,
    handler: requestHumanTakeover,
  },

  // ---------- ChatCloser 1.x compatibility ----------

  {
    name: "capture_lead",
    description:
      "Record a qualified lead for the human team. Call once you have the service they want plus a name or contact number.",
    inputSchema: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        contact_number: { type: "string" },
        service_requested: { type: "string" },
        location: { type: "string" },
        urgency: { type: "string" },
        preferred_date: { type: "string" },
        notes: { type: "string" },
      },
      required: ["service_requested"],
    },
    outputSchema: { type: "object", properties: { leadId: { type: "integer" } } },
    requiredPermissions: ["leads.edit"],
    sideEffects: "write",
    approvalRequired: false,
    idempotent: false,
    handler: captureLead,
  },
  {
    name: "close_sale",
    description:
      "Legacy tool kept for ChatCloser 1.x compatibility: records a payment link for a single priced item. New conversations should use create_order_draft and confirm_customer_order instead.",
    inputSchema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Must exactly match a catalogue item" },
        customer_name: { type: "string" },
      },
      required: ["item_name"],
    },
    outputSchema: { type: "object", properties: { orderId: { type: "integer" } } },
    requiredPermissions: ["orders.create"],
    sideEffects: "transactional",
    approvalRequired: false,
    idempotent: false,
    handler: closeSale,
  },
];

export const TOOLS_BY_NAME = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));

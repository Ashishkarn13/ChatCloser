// seed.js
// Run once (`node seed.js`) to create business_id=1 with a starter
// knowledge base. Edit the fields below before running, or edit them
// later from the dashboard's knowledge-base editor.

import { upsertBusiness } from "./db.js";

const BUSINESS_ID = Number(process.env.BUSINESS_ID || 1);

const business = upsertBusiness(BUSINESS_ID, {
  name: "BuildRight Construction",

  system_prompt_extra: `You are a helpful assistant for "BuildRight Construction", a construction and renovation company.

Rules you must follow:
- Only answer using the information in the knowledge base below. Never guess or make up prices, timelines, or availability.
- Never give a firm quote or final price over chat — costs depend on a site visit. Give the general price range from the knowledge base and offer to book a free site visit/estimate.
- If you don't know something, say so honestly and offer to connect them with a human.
- Keep replies short and conversational — this is WhatsApp, not email. 1-3 sentences unless the customer asks for detail.
- Never discuss competitors, politics, or anything unrelated to this business.
- If the customer mentions a safety issue, an active job-site problem, a dispute, a complaint, or wants to cancel a contract, say a human team member will follow up, and do not attempt to resolve it yourself.
- Once you have at least the service they want, plus a name or contact number, call the capture_lead tool to pass their details to the team. Don't call it for general questions with no service interest expressed.`,

  knowledge_base: {
    services: "residential & commercial construction, home renovations, kitchen/bathroom remodeling, extensions, roofing, painting, flooring, general contracting",
    hours: "Mon-Sat, 8am-6pm. Closed Sundays and public holidays.",
    site_visit: "Free site visit & estimate, available within 2-3 business days of request. Ask for the customer's location/area and preferred date to book one.",
    timelines: "Bathroom remodel: 1-2 weeks. Kitchen remodel: 2-4 weeks. Room extension: 4-8 weeks. Full home renovation: 2-6 months. (Rough estimates only, confirmed after site visit.)",
    price_ranges: "Bathroom remodel: starting from $3,000. Kitchen remodel: starting from $6,000. Room extension: starting from $15,000. Painting (per room): starting from $300. Final quote always requires a site visit.",
    materials: "We can work with customer-supplied materials or source materials ourselves; sourcing costs quoted separately.",
    warranty: "1-year workmanship warranty on all completed projects.",
    payment_terms: "30% deposit to book, 40% at midpoint, 30% on completion. Bank transfer and card accepted.",
    service_area: "Within 30km of the city center. Confirm the customer's location before booking a site visit.",
    licensing: "Fully licensed and insured; documentation available on request.",
  },

  escalation_keywords: [
    "complaint", "angry", "unsafe", "safety issue", "accident", "injury",
    "lawyer", "legal", "sue", "dispute", "cancel contract", "cancel my project",
    "refund", "speak to a human", "speak to a person", "manager", "site emergency",
  ],

  escalation_message:
    "Thanks for letting us know — I've flagged this for our project manager and someone will follow up with you shortly. 🙏",

  away_message:
    "Thanks for reaching out to BuildRight Construction! We're currently closed (Mon-Sat, 8am-6pm). We'll get back to you as soon as we're open.",
});

console.log(`Seeded business_id=${business.id}: "${business.name}"`);
console.log("Edit this any time from the dashboard's Knowledge Base tab.");

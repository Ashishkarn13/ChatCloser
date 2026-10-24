// src/services/ai/language.js
// Language detection and Nepali text handling.
//
// ChatCloser has to cope with three things a customer may write:
//
//   * Nepali in Devanagari (नेपाली)
//   * Nepali in Roman script ( Nepali lai / kati / chaina )
//   * English
//
// and with messages that mix them. Detection is a heuristic, so it is
// never treated as authoritative: the business can pin the language, the
// customer can change it, and the prompt always tells the assistant to
// reply in the language the customer used.

const DEVANAGARI = /[\u0900-\u097F]/;

/** Romanised Nepali markers. Deliberately short and common — this is a
 * hint, not a proof. */
const ROMAN_NEPALI_MARKERS = [
  "namaste", "namaskar", "kati", "ketni", "kina", "kina", "chha", "chaina", "bhanus", "bhanne",
  "garo", "sak", "baki", "paisa", "rupaiya", "rupya", "sammal", "bijji", "puchhu", "puchhne",
  "pathayunu", "pathaunu", "patha", "lai", "lai", "banaidinu", "banaunu", "garaunu", "garna",
  "kina", "katti", "ekdam", "thik", "thikcha", "kharab", "sasto", "mahango", "tika",
  "bhani", "ghar", "jagga", "kaka", "didi", "bhai", "uncle", "aunty", "bhaiya",
  "mila", "milne", "kati", "hodko", "phans", "bhani", "banaidina", "halnu", "garaidina",
];

const ENGLISH_MARKERS = [
  "hello", "hi", "please", "price", "how much", "order", "want", "need", "book", "bookings",
  "thank", "thanks", "where", "when", "delivery", "payment", "available", "stock",
];

export const LANGUAGES = {
  NEPALI: "ne",
  NEPALI_ROMAN: "ne-roman",
  ENGLISH: "en",
  MIXED: "mixed",
};

/**
 * Detects the language of a message.
 * @param {string} text
 * @returns {{language: string, confidence: number, reason: string}}
 */
export function detectLanguage(text) {
  const value = String(text || "").trim();
  if (!value) return { language: LANGUAGES.ENGLISH, confidence: 0, reason: "empty message" };

  const devanagariChars = (value.match(/[\u0900-\u097F]/g) || []).length;
  const letters = (value.match(/[\p{L}]/gu) || []).length || 1;
  const devanagariRatio = devanagariChars / letters;

  if (devanagariRatio > 0.4) {
    return { language: LANGUAGES.NEPALI, confidence: Math.min(1, devanagariRatio), reason: "Devanagari script" };
  }

  const lower = value.toLowerCase();
  const romanHits = ROMAN_NEPALI_MARKERS.filter((m) => lower.includes(m)).length;
  const englishHits = ENGLISH_MARKERS.filter((m) => lower.includes(m)).length;

  if (romanHits > 0 && englishHits > 0) {
    // A sentence written in Romanised Nepali often borrows one English
    // word ("sari ko price kati ho"). It only counts as mixed when the
    // English markers are at least as frequent as the Nepali ones.
    if (englishHits >= romanHits) {
      return {
        language: LANGUAGES.MIXED,
        confidence: 0.6,
        reason: `mixed markers (roman-nepali:${romanHits}, english:${englishHits})`,
      };
    }
  }
  if (romanHits > 0) {
    return { language: LANGUAGES.NEPALI_ROMAN, confidence: 0.7, reason: "Romanised Nepali markers" };
  }
  return { language: LANGUAGES.ENGLISH, confidence: 0.5, reason: "default" };
}

/** The instruction the system prompt uses for a detected language. */
export function languageInstruction(language, businessLocale) {
  switch (language) {
    case LANGUAGES.NEPALI:
      return "The customer is writing in Nepali (Devanagari). Reply in natural Nepali. Use रु. or नेपाली रुपैयाँ for amounts and the Bikāye Sambat or Gregorian date, whichever the business uses — ask if it is unclear.";
    case LANGUAGES.NEPALI_ROMAN:
      return "The customer is writing Romanised Nepali. Reply in Romanised Nepali so they can read it comfortably. Do not switch to Devanagari unless they do first.";
    case LANGUAGES.MIXED:
      return "The customer mixes Nepali and English. Reply in the same mix they used — keep English terms they used in English and everything else in Nepali.";
    default:
      return businessLocale && businessLocale.toLowerCase().startsWith("ne")
        ? "The customer wrote in English but this business works in Nepali. Reply in English unless they switch to Nepali."
        : "Reply in the customer's own language.";
  }
}

// ---------- intent detection ----------

export const INTENTS = {
  GREETING: "greeting",
  PRICE_INQUIRY: "price_inquiry",
  PRODUCT_INQUIRY: "product_inquiry",
  ORDER_INTENT: "order_intent",
  ORDER_STATUS: "order_status",
  BOOKING_REQUEST: "booking_request",
  PAYMENT_STATUS: "payment_status",
  COMPLAINT: "complaint",
  HUMAN_REQUEST: "human_request",
  FOLLOW_UP: "follow_up",
  GENERAL: "general",
};

const INTENT_MARKERS = [
  { intent: INTENTS.HUMAN_REQUEST, markers: ["human", "agent", "person", "manager", "speak to", "talk to", "kasa", "manav", "helpdesk", "complaint", "complain"] },
  { intent: INTENTS.PRICE_INQUIRY, markers: ["price", "cost", "how much", "rate", "kati", "kitni", "daam", "price list", "catalogue", "catalog", "available"] },
  { intent: INTENTS.ORDER_STATUS, markers: ["order status", "my order", "where is my", "delivered", "dispatched", "track", "mero order", "order ko"] },
  { intent: INTENTS.PAYMENT_STATUS, markers: ["payment", "paid", "pay", "refund", "transaction", "bhayeda", "payment gar", "paid gar"] },
  { intent: INTENTS.BOOKING_REQUEST, markers: ["book", "booking", "appointment", "schedule", "visit", "reserve", "table", "slot", "buka", "appointment mila"] },
  { intent: INTENTS.ORDER_INTENT, markers: ["i want", "i'll take", "i will take", "give me", "order", "malgir", "malgirne", "kharid", "laga", "pathaidu"] },
  { intent: INTENTS.COMPLAINT, markers: ["complaint", "not received", "broken", "damaged", "wrong", "refund", "bikai", "bikai chha", "galat", "not working"] },
  { intent: INTENTS.PRODUCT_INQUIRY, markers: ["do you have", "do you sell", "tell me about", "difference between", "which one", "specification", "available"] },
  { intent: INTENTS.GREETING, markers: ["hello", "hi ", "hey", "namaste", "namaskar", "good morning", "good afternoon", "good evening"] },
];

/**
 * A transparent, keyword-based intent classifier.
 *
 * It is deliberately simple and inspectable: a business can see exactly why
 * a message was classified the way it was. It never claims to know the
 * customer's intent with certainty — it only decides where to start.
 */
export function detectIntent(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return { intent: INTENTS.GENERAL, confidence: 0, matched: [] };

  const matches = [];
  for (const { intent, markers } of INTENT_MARKERS) {
    const hits = markers.filter((m) => value.includes(m));
    if (hits.length > 0) matches.push({ intent, hits });
  }

  if (matches.length === 0) return { intent: INTENTS.GENERAL, confidence: 0.2, matched: [] };

  // The longest match wins — "order status" beats "order".
  matches.sort((a, b) => {
    const aLen = Math.max(...a.hits.map((h) => h.length));
    const bLen = Math.max(...b.hits.map((h) => h.length));
    return bLen - aLen;
  });

  const best = matches[0];
  const confidence = Math.min(0.9, 0.4 + best.hits.length * 0.1);
  return { intent: best.intent, confidence, matched: best.hits };
}

/** Normalises a Nepali number written in Devanagari digits. */
export function normaliseDigits(text) {
  const devanagariDigits = "०१२३४५६७८९";
  return String(text || "").replace(/[०-९]/g, (d) => {
    const index = devanagariDigits.indexOf(d);
    return index === -1 ? d : String(index);
  });
}

/** Very small fuzzy matcher used to spot product names inside a message. */
export function similarity(a, b) {
  const s1 = String(a || "").toLowerCase().trim();
  const s2 = String(b || "").toLowerCase().trim();
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s2.includes(s1) || s1.includes(s2)) return 0.85;

  const setA = new Set(s1.split(/\s+/));
  const setB = new Set(s2.split(/\s+/));
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.max(setA.size, setB.size);
}

export { DEVANAGARI };

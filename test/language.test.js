// test/language.test.js
// Nepali language handling and the order-confirmation guard.
//
// The confirmation guard is the safety-critical part: the backend must
// never treat silence, ambiguity or a negation as a customer's approval
// to create an order.

import test from "node:test";
import assert from "node:assert/strict";

import {
  detectLanguage,
  detectIntent,
  languageInstruction,
  normaliseDigits,
  LANGUAGES,
  INTENTS,
} from "../src/services/ai/language.js";
import { detectConfirmation, validateReply } from "../src/services/ai/engine.js";

test("Devanagari is detected as Nepali", () => {
  const result = detectLanguage("नमस्ते, तपाईंको साडीको price कति हो?");
  assert.equal(result.language, LANGUAGES.NEPALI);
});

test("Romanised Nepali is detected as Nepali", () => {
  const result = detectLanguage("namaste, sari ko price kati ho?");
  assert.equal(result.language, LANGUAGES.NEPALI_ROMAN);
});

test("English is detected as English", () => {
  const result = detectLanguage("Hello, how much is the blue sari?");
  assert.equal(result.language, LANGUAGES.ENGLISH);
});

test("a mixed Nepali and English message is detected as mixed", () => {
  const result = detectLanguage("namaste, I want to book appointment for hair cut");
  assert.equal(result.language, LANGUAGES.MIXED);
});

test("an empty message does not crash the detector", () => {
  const result = detectLanguage("");
  assert.ok(result.language);
  assert.equal(result.confidence, 0);
});

test("the language instruction matches the detected language", () => {
  assert.match(languageInstruction(LANGUAGES.NEPALI, "ne"), /Nepali/i);
  assert.match(languageInstruction(LANGUAGES.NEPALI_ROMAN, "ne"), /Romanised/i);
  assert.match(languageInstruction(LANGUAGES.MIXED, "ne"), /mix/i);
});

test("intents are detected for the common customer messages", () => {
  assert.equal(detectIntent("how much is the sari?").intent, INTENTS.PRICE_INQUIRY);
  assert.equal(detectIntent("I want to order two saris").intent, INTENTS.ORDER_INTENT);
  assert.equal(detectIntent("where is my order?").intent, INTENTS.ORDER_STATUS);
  assert.equal(detectIntent("I want to speak to a human").intent, INTENTS.HUMAN_REQUEST);
  assert.equal(detectIntent("the delivery is damaged, I want a refund").intent, INTENTS.COMPLAINT);
  assert.equal(detectIntent("can I book an appointment for tomorrow?").intent, INTENTS.BOOKING_REQUEST);
});

test("an unrelated message falls back to a general intent", () => {
  assert.equal(detectIntent("hmm").intent, INTENTS.GENERAL);
});

test("Devanagari digits are normalised", () => {
  assert.equal(normaliseDigits("१२३४५"), "12345");
});

test("an explicit yes is an approval", () => {
  assert.equal(detectConfirmation("yes").approved, true);
  assert.equal(detectConfirmation("Yes please").approved, true);
  assert.equal(detectConfirmation("ठीक छ").approved, true);
  assert.equal(detectConfirmation("ठीक छ भएको छ").approved, true);
  assert.equal(detectConfirmation("confirm गर्नुहोस्").approved, true);
  assert.equal(detectConfirmation("जमा गरिदिनुस्").approved, true);
});

test("a negation is never an approval", () => {
  assert.equal(detectConfirmation("no").approved, false);
  assert.equal(detectConfirmation("no, cancel it").approved, false);
  assert.equal(detectConfirmation("ठीक छैन").approved, false);
  assert.equal(detectConfirmation("not yet").approved, false);
});

test("an ambiguous reply is not an approval", () => {
  assert.equal(detectConfirmation("what is the total again?").approved, false);
  assert.equal(detectConfirmation("").approved, false);
  assert.equal(detectConfirmation("ok... maybe").approved, false);
});

test("a reply that invents a price is corrected", () => {
  const catalogue = [{ name: "Sari", price: 1500 }];
  const result = validateReply("The sari is Rs. 900. Shall I add it to your order?", { catalogue });

  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.doesNotMatch(result.safeReply, /900/);
  assert.match(result.safeReply, /only quote prices/);
});

test("a reply that uses a catalogue price is left alone", () => {
  const catalogue = [{ name: "Sari", price: 1500 }];
  const result = validateReply("The sari is Rs. 1,500. Would you like it?", { catalogue });

  assert.equal(result.ok, true);
  assert.equal(result.safeReply, "The sari is Rs. 1,500. Would you like it?");
});

test("an amount produced by a tool is allowed", () => {
  const catalogue = [];
  const result = validateReply("Your total is Rs. 2,000.", {
    catalogue,
    allowedAmounts: [2000],
  });
  assert.equal(result.ok, true);
});

test("a reply with no amount is never touched", () => {
  const result = validateReply("Namaste! How can I help you today?", { catalogue: [] });
  assert.equal(result.ok, true);
  assert.equal(result.safeReply, "Namaste! How can I help you today?");
});

test("a payment claim is not corrected away — the engine simply never makes one", () => {
  // The guard here is architectural (the assistant has no tool that can
  // assert a payment), but the price guard must not mangle a legitimate
  // reply that happens to mention the amount the customer already agreed.
  const result = validateReply("Your order total is Rs. 1,500 as shown.", {
    catalogue: [{ name: "Sari", price: 1500 }],
  });
  assert.equal(result.ok, true);
});

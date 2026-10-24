// test/knowledge.test.js
// The knowledge base: chunking, indexing, retrieval and reindexing.
//
// The point of the knowledge base is that the assistant can answer from
// *verified* business information and say where the answer came from.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness } from "./helpers.js";

import {
  upsertDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  search,
  chunkDocument,
  reindexBusiness,
  importLegacyKnowledgeBase,
} from "../src/services/knowledge.js";
import { getDb } from "../src/db/connection.js";

test("a document is split into retrieval-sized chunks", () => {
  const chunks = chunkDocument(
    "First paragraph about opening hours.\n\nSecond paragraph about delivery.\n\nThird paragraph about returns."
  );
  assert.ok(chunks.length >= 3);
  assert.match(chunks[0].content, /opening hours/);
});

test("a heading is captured as the chunk heading", () => {
  const chunks = chunkDocument("# Delivery Policy\n\nWe deliver within 3 days.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "Delivery Policy");
});

test("a long document is split into several chunks", () => {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some content.`).join("\n\n");
  const chunks = chunkDocument(long);
  assert.ok(chunks.length > 1);
});

test("a document can be found by searching the knowledge base", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  upsertDocument(businessId, {
    title: "Delivery Policy",
    content: "We deliver inside Kathmandu valley within 3 working days. Outside the valley it takes up to a week.",
    category: "policy",
  });

  const results = search(businessId, "delivery");
  assert.ok(results.length >= 1);
  assert.match(results[0].chunk, /Kathmandu valley/);
  assert.equal(results[0].title, "Delivery Policy");
});

test("a search result carries the source document so the answer can be cited", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  const doc = upsertDocument(businessId, {
    title: "Returns",
    content: "Items can be returned within 7 days of delivery.",
    source: "policy handbook 2026",
  });

  const results = search(businessId, "returned");
  assert.ok(results.length >= 1);
  assert.equal(results[0].documentId, doc.id);
  assert.equal(results[0].source, "policy handbook 2026");
});

test("a document that is updated is reindexed and its version increases", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  const doc = upsertDocument(businessId, { title: "Hours", content: "We are open 9 to 5." });

  const updated = upsertDocument(businessId, {
    id: doc.id,
    title: "Hours",
    content: "We are now open 8 to 6.",
  });

  assert.equal(updated.version, 2);
  assert.equal(listDocuments(businessId).length, 1);

  const results = search(businessId, "open");
  assert.match(results[0].chunk, /8 to 6/);
});

test("a deleted document disappears from search results", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  const doc = upsertDocument(businessId, { title: "Temporary", content: "secret seasonal offer" });

  assert.ok(search(businessId, "seasonal").length >= 1);

  deleteDocument(businessId, doc.id);

  assert.equal(search(businessId, "seasonal").length, 0);
  assert.equal(listDocuments(businessId).length, 0);
});

test("a draft document is not used to answer customers", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  upsertDocument(businessId, {
    title: "Unfinished",
    content: "maybe we will offer a discount",
    status: "draft",
  });

  assert.equal(search(businessId, "discount").length, 0);
});

test("reindexing rebuilds the index without losing documents", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  upsertDocument(businessId, { title: "One", content: "alpha content here" });
  upsertDocument(businessId, { title: "Two", content: "beta content here" });

  const result = reindexBusiness(businessId);
  assert.equal(result.documents, 2);
  assert.ok(result.chunks >= 2);
  assert.ok(search(businessId, "alpha").length >= 1);
});

test("the legacy flat knowledge base can be imported", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  getDb()
    .prepare("UPDATE businesses SET knowledge_base = ? WHERE id = ?")
    .run(JSON.stringify({ hours: "Mon-Sat 9-6", services: "Plumbing and electrical work" }), businessId);

  const result = importLegacyKnowledgeBase(businessId);
  assert.equal(result.imported, 2);

  const results = search(businessId, "plumbing");
  assert.ok(results.length >= 1);
});

test("a search with no match returns nothing rather than a guess", async () => {
  const businessId = await makeBusiness("Knowledge Business");
  upsertDocument(businessId, { title: "Hours", content: "We are open 9 to 5." });

  const results = search(businessId, "quantum chromodynamics");
  assert.equal(results.length, 0);
});

test("a document is scoped to its business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");
  const doc = upsertDocument(a, { title: "A policy", content: "only business A knows this" });

  assert.equal(search(a, "business").length >= 1, true);
  assert.equal(search(b, "business").length, 0);
  assert.throws(() => getDocument(b, doc.id), /No such knowledge document/i);
});

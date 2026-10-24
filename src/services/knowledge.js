// src/services/knowledge.js
// Searchable business knowledge base.
//
// Documents are split into chunks and indexed with SQLite's FTS5. Every
// answer the AI gives from the knowledge base can therefore be traced back
// to a specific document, which is what lets the engine distinguish a
// verified fact from an estimate or a guess.
//
// Retrieval returns the source document id, title and the matched excerpt,
// and those references are stored with the AI run so a human can audit
// what the assistant actually knew at the time.

import { getDb, transaction } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, jsonArray } from "../core/validation.js";

const CHUNK_TARGET_CHARS = 900;
const CHUNK_MAX_CHARS = 1600;

let ftsAvailable = null;

function hasFts() {
  if (ftsAvailable !== null) return ftsAvailable;
  try {
    getDb().exec("SELECT count(*) FROM knowledge_fts");
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
  }
  return ftsAvailable;
}

/**
 * Splits a document into retrieval-sized chunks.
 *
 * Blank lines separate blocks, and a block is normally its own chunk so
 * that a retrieved chunk is a self-contained answer. Two exceptions are
 * merged with the block that follows them, because on their own they are
 * meaningless: a heading, and a short label or question such as
 * "Q: Do you deliver?".
 */
export function chunkDocument(text) {
  const clean = String(text || "").trim();
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks = [];

  let index = 0;
  while (index < blocks.length) {
    let block = blocks[index];

    const isHeading = /^#{1,6}\s/.test(block);
    const isLabel = block.length < 160 && /[?:：]\s*$/.test(block);

    if ((isHeading || isLabel) && index + 1 < blocks.length) {
      block = `${block}\n\n${blocks[index + 1]}`;
      index += 2;
    } else {
      index += 1;
    }

    if (block.length > CHUNK_MAX_CHARS) {
      for (let i = 0; i < block.length; i += CHUNK_TARGET_CHARS) {
        chunks.push(block.slice(i, i + CHUNK_MAX_CHARS).trim());
      }
      continue;
    }

    chunks.push(block);
  }

  return chunks.map((content) => {
    const headingMatch = content.match(/^#{1,6}\s*(.+)$/m);
    return {
      heading: headingMatch ? headingMatch[1].trim() : "",
      content,
    };
  });
}

export function listDocuments(businessId, { status = null, category = null, limit = 200 } = {}) {
  const db = getDb();
  const where = ["business_id = ?", "deleted_at IS NULL"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  params.push(Math.min(Number(limit) || 200, 500));
  return db
    .prepare(
      `SELECT id, title, category, source, source_url, locale, status, version, visibility,
              updated_at, created_at,
              length(content) AS size
       FROM knowledge_documents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...params);
}

export function getDocument(businessId, documentId) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM knowledge_documents WHERE business_id = ? AND id = ? AND deleted_at IS NULL"
    )
    .get(businessId, documentId);
  if (!row) throw new NotFoundError("No such knowledge document.");
  return row;
}

/**
 * Creates or updates a document and reindexes it.
 */
export function upsertDocument(businessId, input, actor = "system") {
  const db = getDb();
  const title = str(input.title, { field: "title", required: true, max: 250 });
  const content = str(input.content, { field: "content", max: 500000 });
  const category = str(input.category, { field: "category", max: 80 }) || "general";
  const source = str(input.source, { field: "source", max: 200 });
  const sourceUrl = str(input.source_url, { field: "source_url", max: 500 });
  const locale = str(input.locale, { field: "locale", max: 20 });
  const status = str(input.status, { field: "status", max: 20 }) || "published";
  const visibility = str(input.visibility, { field: "visibility", max: 20 }) || "ai";

  let documentId = input.id ? Number(input.id) : null;
  let version = 1;

  if (documentId) {
    const existing = getDocument(businessId, documentId);
    version = Number(existing.version || 1) + 1;
    db.prepare(
      `UPDATE knowledge_documents SET
         title = ?, category = ?, content = ?, source = ?, source_url = ?, locale = ?,
         status = ?, visibility = ?, version = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE business_id = ? AND id = ?`
    ).run(
      title, category, content, source, sourceUrl, locale, status, visibility,
      version, actor, businessId, documentId
    );
  } else {
    const info = db
      .prepare(
        `INSERT INTO knowledge_documents
           (business_id, title, category, content, source, source_url, locale, status, visibility, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        businessId, title, category, content, source, sourceUrl, locale, status, visibility, actor, actor
      );
    documentId = Number(info.lastInsertRowid);
  }

  reindexDocument(businessId, documentId);

  audit({
    businessId,
    actor,
    action: "knowledge.document_saved",
    details: { document_id: documentId, title, version },
  });

  return getDocument(businessId, documentId);
}

export function deleteDocument(businessId, documentId, actor = "system") {
  const db = getDb();
  getDocument(businessId, documentId);
  transaction(() => {
    db.prepare(
      "UPDATE knowledge_documents SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
    ).run(businessId, documentId);
    db.prepare("DELETE FROM knowledge_chunks WHERE business_id = ? AND document_id = ?").run(
      businessId,
      documentId
    );
    if (hasFts()) {
      db.prepare("DELETE FROM knowledge_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE 0)").run();
    }
  });
  audit({ businessId, actor, action: "knowledge.document_deleted", details: { document_id: documentId } });
  return true;
}

/** Rebuilds the chunk rows and the full-text index for one document. */
export function reindexDocument(businessId, documentId) {
  const db = getDb();
  const doc = getDocument(businessId, documentId);
  const chunks = chunkDocument(doc.content);

  transaction(() => {
    const oldChunkIds = db
      .prepare("SELECT id FROM knowledge_chunks WHERE business_id = ? AND document_id = ?")
      .all(businessId, documentId)
      .map((r) => r.id);

    if (hasFts() && oldChunkIds.length > 0) {
      const placeholders = oldChunkIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM knowledge_fts WHERE chunk_id IN (${placeholders})`).run(...oldChunkIds);
    }

    db.prepare("DELETE FROM knowledge_chunks WHERE business_id = ? AND document_id = ?").run(
      businessId,
      documentId
    );

    const insertChunk = db.prepare(
      `INSERT INTO knowledge_chunks (business_id, document_id, heading, content, position, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertFts = hasFts()
      ? db.prepare("INSERT INTO knowledge_fts (chunk_id, heading, content) VALUES (?, ?, ?)")
      : null;

    chunks.forEach((chunk, index) => {
      const info = insertChunk.run(
        businessId,
        documentId,
        chunk.heading,
        chunk.content,
        index,
        Math.ceil(chunk.content.length / 4)
      );
      if (insertFts) {
        insertFts.run(Number(info.lastInsertRowid), chunk.heading, chunk.content);
      }
    });
  });

  return { chunks: chunks.length };
}

/** Rebuilds the whole index for a business (used after a restore). */
export function reindexBusiness(businessId) {
  const db = getDb();
  const docs = db
    .prepare("SELECT id FROM knowledge_documents WHERE business_id = ? AND deleted_at IS NULL")
    .all(businessId);
  let total = 0;
  for (const doc of docs) {
    total += reindexDocument(businessId, doc.id).chunks;
  }
  return { documents: docs.length, chunks: total };
}

/**
 * Escapes a user query so it can be handed to FTS5 safely.
 * Only letters, digits and whitespace survive; every term is quoted.
 */
function toFtsQuery(query) {
  const terms = String(query || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 20);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Searches the knowledge base.
 *
 * @param {number} businessId
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.locale] restrict to a language when given
 * @returns {Array<{documentId:number, title:string, chunk:string, score:number, source:string}>}
 */
export function search(businessId, query, { limit = 5, locale = null } = {}) {
  const text = str(query, { field: "query", max: 500 });
  if (!text) return [];

  const db = getDb();

  if (hasFts()) {
    const match = toFtsQuery(text);
    if (match) {
      const rows = db
        .prepare(
          `SELECT f.chunk_id AS chunkId, c.heading, c.content, c.document_id AS documentId,
                  d.title, d.source, d.source_url AS sourceUrl, d.locale, d.category,
                  bm25(knowledge_fts) AS rank
           FROM knowledge_fts f
           JOIN knowledge_chunks c ON c.id = f.chunk_id
           JOIN knowledge_documents d ON d.id = c.document_id
           WHERE knowledge_fts MATCH ? AND c.business_id = ? AND d.deleted_at IS NULL
             AND d.status = 'published'
           ORDER BY rank LIMIT ?`
        )
        .all(match, businessId, Math.min(Number(limit) || 5, 25));

      if (rows.length > 0) {
        return rows.map((r) => ({
          documentId: r.documentId,
          title: r.title,
          heading: r.heading,
          chunk: r.content,
          score: Math.max(0, 1 - Number(r.rank) / 40),
          source: r.source || "",
          sourceUrl: r.sourceUrl || "",
          category: r.category,
          locale: r.locale,
        }));
      }
    }
  }

  // Fallback for environments without FTS5: a simple LIKE scan.
  const like = `%${text.toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT c.document_id AS documentId, c.heading, c.content, d.title, d.source,
              d.source_url AS sourceUrl, d.category, d.locale
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.business_id = ? AND d.deleted_at IS NULL AND d.status = 'published'
         AND (LOWER(c.content) LIKE ? OR LOWER(d.title) LIKE ?)
       LIMIT ?`
    )
    .all(businessId, like, like, Math.min(Number(limit) || 5, 25));

  return rows.map((r) => ({
    documentId: r.documentId,
    title: r.title,
    heading: r.heading,
    chunk: r.content,
    score: 0.5,
    source: r.source || "",
    sourceUrl: r.sourceUrl || "",
    category: r.category,
    locale: r.locale,
  }));
}

/**
 * Imports the legacy flat knowledge base (businesses.knowledge_base) into
 * real documents, so a ChatCloser 1.x workspace gets a searchable
 * knowledge base without retyping anything.
 */
export function importLegacyKnowledgeBase(businessId, actor = "system") {
  const db = getDb();
  const row = db.prepare("SELECT knowledge_base FROM businesses WHERE id = ?").get(businessId);
  if (!row) return { imported: 0 };

  let legacy = {};
  try {
    legacy = JSON.parse(row.knowledge_base || "{}");
  } catch {
    legacy = {};
  }

  let imported = 0;
  for (const [key, value] of Object.entries(legacy)) {
    if (!value || typeof value !== "string") continue;
    const existing = db
      .prepare(
        "SELECT id FROM knowledge_documents WHERE business_id = ? AND title = ? AND deleted_at IS NULL"
      )
      .get(businessId, key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
    if (existing) continue;

    upsertDocument(
      businessId,
      {
        title: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        content: value,
        category: "imported",
        source: "company profile",
      },
      actor
    );
    imported += 1;
  }

  return { imported };
}

export { hasFts };

-- M6 — Cover Letter + Voice: connective prose storage.
--
-- A cover letter is prose. Its CLAIM sentences (what the candidate has done/built/led/knows) remain
-- cited doc_lines, identical to a résumé bullet — every one citing a verified+owned fact. But a letter
-- also needs CONNECTIVE prose that asserts NO experiential fact: the greeting, the statement of
-- interest, enthusiasm/fit framing, the closing courtesy, the sign-off.
--
-- Connective prose lives HERE, on the document row — NEVER as a doc_line. This keeps the doc_line
-- invariant EXACTLY intact: no stored doc_line ever has empty fact_ids, because a doc_line is only ever
-- a cited claim. Connective prose has no citation slot at all, so it can never be stored as a claim.
--
-- Shape: an ordered JSON array of { "role": text, "text": text, "position": int }. Additive and
-- defaulted to '[]' — every existing document (all résumés) is unaffected (résumés store no connective,
-- so persistDocument omits the column entirely and this default applies). The CHECK keeps the column a
-- JSON array structurally; the "no experiential assertion" semantics are enforced by the cover-letter
-- validator + the conservative prompt + the user's per-line approval, not by the database.
alter table document
  add column connective jsonb not null default '[]'::jsonb
  constraint document_connective_is_array check (jsonb_typeof(connective) = 'array');

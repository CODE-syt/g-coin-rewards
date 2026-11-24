'use strict';

const ID_RE = /^[a-f0-9]{24}$/i;

const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDupKey = (e) => Boolean(e && (e.code === 11000 || e.code === 11001));

// Strip control characters and collapse whitespace; used for names coming from third parties.
function cleanText(s, max = 200) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// YYYY-MM-DD in the configured timezone (used for "per day" share caps).
function dayKey(date, timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function parsePage(query, { defaultLimit = 20, maxLimit = 50 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function pageResult(items, total, { page, limit }) {
  return { items, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total };
}

module.exports = { isId, escapeRegex, isDupKey, cleanText, dayKey, parsePage, pageResult };

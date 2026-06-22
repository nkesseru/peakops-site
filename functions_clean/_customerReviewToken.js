// PEAKOPS_CUSTOMER_REVIEW_TOKEN_V1 (PR 126a)
//
// Shared token utilities for the customer-review link flow.
//
//   Cleartext token shape:  peakops_rv_<43 chars base64url>
//   Storage:                SHA-256(token) → hex string; doc id is the hex hash.
//   Lookup:                 hash the inbound token, doc().get() the hash.
//
// The cleartext token is returned ONCE at creation. It is never stored
// in Firestore and never logged. Operators who lose the cleartext must
// revoke + re-mint a new link.

const crypto = require("node:crypto");

const TOKEN_PREFIX = "peakops_rv_";
const RAW_BYTES = 32;                       // 256 bits of entropy
// base64url of 32 bytes is 43 chars (no padding)
const EXPECTED_RAW_LEN = 43;
const EXPECTED_TOKEN_LEN = TOKEN_PREFIX.length + EXPECTED_RAW_LEN;
const TOKEN_PATTERN = new RegExp(
  "^" + TOKEN_PREFIX.replace(/[_]/g, "\\$&") + "[A-Za-z0-9_-]{" + EXPECTED_RAW_LEN + "}$"
);

function generateToken() {
  const raw = crypto.randomBytes(RAW_BYTES).toString("base64url");
  return TOKEN_PREFIX + raw;
}

function isWellFormed(token) {
  if (typeof token !== "string") return false;
  if (token.length !== EXPECTED_TOKEN_LEN) return false;
  return TOKEN_PATTERN.test(token);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

// Stable prefix of the hash — used for audit + logging without leaking
// the token itself. 8 hex chars = 32 bits, enough to disambiguate
// audit rows but not enough to reverse the token.
function hashPrefix(token) {
  const h = hashToken(token);
  return h.slice(0, 8);
}

// Stable network-fingerprint helpers. The product captures truncated
// IP + UA hash for forensic disambiguation; never the full PII.
function ipPrefixFromRequest(req) {
  const fwd = String(req && req.headers && (req.headers["x-forwarded-for"] || "")).split(",")[0].trim();
  const raw = fwd || String(req && req.ip || "").trim();
  if (!raw) return "";
  // IPv6: drop everything after the first /64
  if (raw.includes(":")) {
    return raw.split(":").slice(0, 4).join(":");
  }
  // IPv4: drop the last octet
  const parts = raw.split(".");
  if (parts.length === 4) return parts.slice(0, 3).join(".");
  return raw.slice(0, 24);
}

function userAgentFingerprint(req) {
  const ua = String(req && req.headers && req.headers["user-agent"] || "").trim();
  if (!ua) return "";
  return crypto.createHash("sha256").update(ua, "utf8").digest("hex").slice(0, 8);
}

// PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 (Chunk 1: Trust Foundation, 2026-06-22)
//
// Token expiration policy. New tokens get an explicit expiresAt set
// to TOKEN_TTL_DAYS days after mint. Legacy tokens (minted before this
// constant existed) carry expiresAt: null — those are grandfathered
// via the backfill migration script (see scripts/dev/backfill_review_token_ttl.mjs)
// rather than being rejected at request time.
//
// 90 days matches the typical "customer signoff window" plus a buffer.
// Operators can revoke earlier via revokedAt; the TTL is a backstop,
// not the primary lifecycle signal.
const TOKEN_TTL_DAYS = 90;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Returns true when the link doc's expiresAt has passed.
 *
 * Accepts a few timestamp shapes safely:
 *   - Firestore Timestamp ({_seconds, _nanoseconds} or .toMillis())
 *   - JS Date
 *   - epoch millis number
 *   - ISO string
 *   - null/undefined → returns false (never-expires; legacy grandfathered)
 *
 * Returning false on null is intentional: legacy null-TTL tokens stay
 * valid until the backfill migration sets a real expiresAt on them.
 * Once backfilled, the same check enforces expiration.
 *
 * @param {*} expiresAt
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
function isExpired(expiresAt, nowMs) {
  if (expiresAt == null) return false;
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  // Firestore Timestamp (server-side shape)
  if (typeof expiresAt === "object") {
    if (typeof expiresAt.toMillis === "function") {
      try { return expiresAt.toMillis() <= now; } catch (_) { /* fall through */ }
    }
    const sec = Number(expiresAt._seconds);
    if (Number.isFinite(sec)) return sec * 1000 <= now;
  }
  if (expiresAt instanceof Date) return expiresAt.getTime() <= now;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt <= now;
  if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (Number.isFinite(t)) return t <= now;
  }
  // Unknown shape → fail safe (treat as not-expired so we don't
  // accidentally lock customers out due to a malformed write).
  return false;
}

/**
 * Builds the expiresAt JS Date for a new token mint. Callers should
 * convert to a Firestore Timestamp when writing to the link doc.
 *
 * @param {number} [nowMs=Date.now()]
 * @returns {Date}
 */
function computeExpiresAt(nowMs) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  return new Date(now + TOKEN_TTL_MS);
}

module.exports = {
  TOKEN_PREFIX,
  EXPECTED_TOKEN_LEN,
  TOKEN_TTL_DAYS,
  TOKEN_TTL_MS,
  generateToken,
  isWellFormed,
  hashToken,
  hashPrefix,
  ipPrefixFromRequest,
  userAgentFingerprint,
  isExpired,
  computeExpiresAt,
};

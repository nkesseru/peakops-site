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

module.exports = {
  TOKEN_PREFIX,
  EXPECTED_TOKEN_LEN,
  generateToken,
  isWellFormed,
  hashToken,
  hashPrefix,
  ipPrefixFromRequest,
  userAgentFingerprint,
};

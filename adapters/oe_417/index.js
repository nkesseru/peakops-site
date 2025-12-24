import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const SERVICE = "oe417-adapter";
const VERSION = "v1";
const PROVIDER = "DOE";
const SYSTEM = "OE_417";

const TOKEN = (process.env.OE417_ADAPTER_TOKEN || "").trim();
function authOk(req) {
  if (!TOKEN) return true;
  const h = (req.headers.authorization || "").trim();
  return h === `Bearer ${TOKEN}`;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    provider: PROVIDER,
    system: SYSTEM,
    version: VERSION,
    env: process.env.ENV_NAME || "local",
    timestamp: new Date().toISOString(),
    authEnabled: !!TOKEN,
  });
});

app.post("/submit", async (req, res) => {
  try {
    if (!authOk(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized", code: "UNAUTHORIZED" });
    }

    const { orgId, incidentId, filingType, payload, idempotencyKey, correlationId } = req.body || {};

    if (!orgId || !incidentId || filingType !== "OE_417" || typeof payload !== "object" || payload === null) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        code: "INVALID_REQUEST",
        details: { orgId, incidentId, filingType, payloadType: typeof payload },
      });
    }

    // STUB for now — replace later with real DOE OE-417 integration
    const seed = (idempotencyKey || `${incidentId}-${filingType}-${Date.now()}`).toString();
    const suffix = Buffer.from(seed).toString("base64").slice(0, 10).replace(/[^A-Za-z0-9]/g, "");
    const confirmationId = `OE417-STUB-${suffix}`.toUpperCase();

    return res.json({
      ok: true,
      provider: PROVIDER,
      system: SYSTEM,
      submissionMethod: "AUTO",
      confirmationId,
      notes: "STUB adapter (replace with real DOE OE-417 submission)",
      correlationId: correlationId || "",
      rawResponse: { status: "accepted", mocked: true },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e), code: "INTERNAL_ERROR" });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`${SERVICE} listening on :${port}`));

const fs = require('fs');
const path = 'functions/server.mjs';
let src = fs.readFileSync(path, 'utf8');

// Find the app var that calls express()
const m = src.match(/\b(const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*=\s*express\s*\(\s*\)/);
if (!m) {
  console.error('❌ Could not find an express() app variable in functions/server.mjs');
  process.exit(1);
}
const appVar = m[2];

// Remove any previous __diag / __pdf blocks
src = src
  .replace(/\n\s*app\.get\(["']\/__diag["'][\s\S]*?\n\s*\}\);\s*/g, '')
  .replace(/\n\s*app\.get\(["']\/__pdf["'][\s\S]*?\n\s*\}\);\s*/g, '');

// Build insert block
const block = `
/* ===== Runtime route introspection + diagnostics ===== */
${appVar}.get("/", (req,res)=>res.json({ ok:true, hello:"PeakOps" }));
${appVar}.get("/__routes", (req,res)=>{
  const list = [];
  const push = (layer, base = "") => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods||{}).map(m=>m.toUpperCase());
      list.push({ path: base + layer.route.path, methods });
    } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
      for (const l of layer.handle.stack) push(l, base);
    }
  };
  if (${appVar}._router && ${appVar}._router.stack) for (const l of ${appVar}._router.stack) push(l, "");
  res.json({ ok:true, count:list.length, routes:list });
});

${appVar}.get("/__diag", (req, res) => {
  res.json({
    ok: true,
    service: process.env.K_SERVICE || "local",
    revision: process.env.K_REVISION || "dev",
    project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "unknown",
    rev: process.env.APP_REV || null,
    nodeEnv: process.env.NODE_ENV || null,
    now: new Date().toISOString()
  });
});

${appVar}.get("/__pdf", async (req, res) => {
  try {
    const { default: PDFDocument } = await import("pdfkit");
    const doc = new PDFDocument({ size: "LETTER", margin: 36 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => {
      const buf = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline; filename=__diag.pdf");
      res.end(buf);
    });
    doc.fontSize(18).text("PeakOps API - PDF OK");
    doc.moveDown().fontSize(10)
      .text("REV: " + (process.env.APP_REV || "-"))
      .text("REVISION: " + (process.env.K_REVISION || "-"))
      .text("SERVICE: " + (process.env.K_SERVICE || "-"))
      .text("TIMESTAMP: " + new Date().toISOString());
    doc.end();
  } catch (e) {
    console.error("PDF route error", e);
    res.status(500).json({ ok:false, error:"pdf_failed", detail:String(e) });
  }
});
/* ===== End diagnostics ===== */
`;

// Insert block right after the express() assignment line
src = src.replace(
  /\b(const|let|var|export\s+const)\s+[A-Za-z_$][\w$]*\s*=\s*express\s*\(\s*\).*\n/,
  (line) => line + block + '\n'
);

// Move any 404 app-level handler to EOF
// (handles common one-liner forms)
const notFoundRe = /app\.use\(\s*\(req\s*,\s*res\)\s*=>\s*res\.status\(\s*404\s*\)\.json\([\s\S]*?\)\s*\)\s*;\s*/;
if (notFoundRe.test(src)) {
  const match = src.match(notFoundRe)[0];
  src = src.replace(notFoundRe, ''); // remove first occurrence
  if (!src.trimEnd().endsWith('\n')) src += '\n';
  src += '\n' + match + '\n';
}

fs.writeFileSync(path, src);
console.log('✅ Inserted routes on app variable:', appVar);

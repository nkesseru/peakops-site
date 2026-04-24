import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PROJECT_ID = "peakops-pilot";
const FUNCTIONS_BASE = `http://127.0.0.1:5004/${PROJECT_ID}/us-central1`;
const FIRESTORE_BASE = `http://127.0.0.1:8087/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const ORG_ID = "riverbend-electric";
const INCIDENT_ID = "inc_demo";
const REVIEWABLE_JOB_IDS = ["job_demo_001", "job_demo_002"] as const;
const TECH_USER_ID = "tech_web";
const ACTOR = "demo_seed";

const DEMO_ASSET_DIR = path.join(process.cwd(), "dev-assets", "demo-evidence");

const DEMO_EVIDENCE = [
  {
    fileName: "8.png",
    phase: "INSPECTION",
    labels: ["DAMAGE"],
    notes: "Demo seeded evidence 1",
  },
  {
    fileName: "12.png",
    phase: "INSPECTION",
    labels: ["DAMAGE"],
    notes: "Demo seeded evidence 2",
  },
  {
    fileName: "13.png",
    phase: "INSPECTION",
    labels: ["DAMAGE"],
    notes: "Demo seeded evidence 3",
  },
  {
    fileName: "14.png",
    phase: "INSPECTION",
    labels: ["DAMAGE"],
    notes: "Demo seeded evidence 4",
  },
  {
    fileName: "15.png",
    phase: "INSPECTION",
    labels: ["DAMAGE"],
    notes: "Demo seeded evidence 5",
  },
] as const;

type AnyJson = Record<string, any>;

type CreateUploadUrlResp = {
  ok?: boolean;
  uploadUrl?: string;
  uploadMethod?: "PUT" | "POST";
  storagePath?: string;
  bucket?: string;
  contentType?: string;
  expiresAt?: string;
  error?: string;
};

type AddEvidenceResp = {
  ok?: boolean;
  evidenceId?: string;
  id?: string;
  docId?: string;
  evidence?: { id?: string; evidenceId?: string };
  error?: string;
};

async function readJsonSafe(res: Response): Promise<AnyJson> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text}`);
  }
}

async function callFunction<T = AnyJson>(fnName: string, body: AnyJson): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${fnName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });

  const json = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(`${fnName} HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json?.ok === false) {
    throw new Error(`${fnName} returned ok=false: ${JSON.stringify(json)}`);
  }

  return json as T;
}

async function getFirestoreDoc(documentPath: string): Promise<AnyJson | null> {
  const res = await fetch(`${FIRESTORE_BASE}/${documentPath}`, {
    method: "GET",
    cache: "no-store",
  });

  if (res.status === 404) return null;

  const json = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(`Firestore GET ${documentPath} failed: ${res.status} ${JSON.stringify(json)}`);
  }

  return json;
}

async function listFirestoreCollection(collectionPath: string): Promise<AnyJson[]> {
  const res = await fetch(`${FIRESTORE_BASE}/${collectionPath}`, {
    method: "GET",
    cache: "no-store",
  });

  if (res.status === 404) return [];

  const json = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(`Firestore LIST ${collectionPath} failed: ${res.status} ${JSON.stringify(json)}`);
  }

  return Array.isArray(json?.documents) ? json.documents : [];
}

function getStringField(doc: any, key: string): string {
  return String(doc?.fields?.[key]?.stringValue ?? "");
}

function getDocIdFromName(doc: any): string {
  const name = String(doc?.name ?? "");
  return name.split("/").pop() ?? "";
}

async function ensureIncidentExists(): Promise<void> {
  const incident = await getFirestoreDoc(`incidents/${INCIDENT_ID}`);
  if (!incident) {
    throw new Error(`Missing incident at incidents/${INCIDENT_ID}. Seed the blank demo incident first.`);
  }
}

async function ensureJobExists(): Promise<void> {
  for (const jobId of REVIEWABLE_JOB_IDS) {
    const job = await getFirestoreDoc(`incidents/${INCIDENT_ID}/jobs/${jobId}`);
    if (!job) {
      throw new Error(`Missing job at incidents/${INCIDENT_ID}/jobs/${jobId}. Seed the blank demo incident first.`);
    }
  }
}

async function ensureFieldSession(): Promise<string> {
  const sessions = await listFirestoreCollection(`incidents/${INCIDENT_ID}/fieldSessions`);

  const reusable = sessions.find((doc: any) => {
    const status = getStringField(doc, "status").toUpperCase();
    return !!getDocIdFromName(doc) && ["IN_PROGRESS", "ARRIVED", "READY", "OPEN"].includes(status);
  });

  if (reusable) {
    return getDocIdFromName(reusable);
  }

  const started = await callFunction<{ ok?: boolean; sessionId?: string }>("startFieldSessionV1", {
    orgId: ORG_ID,
    incidentId: INCIDENT_ID,
    createdBy: ACTOR,
    techUserId: TECH_USER_ID,
  });

  const sessionId = String(started?.sessionId ?? "").trim();
  if (!sessionId) {
    throw new Error(`startFieldSessionV1 returned no sessionId: ${JSON.stringify(started)}`);
  }

  await callFunction("markArrivedV1", {
    orgId: ORG_ID,
    incidentId: INCIDENT_ID,
    sessionId,
    updatedBy: ACTOR,
    techUserId: TECH_USER_ID,
  });

  return sessionId;
}

async function readDemoAsset(fileName: string): Promise<{
  fileName: string;
  contentType: string;
  buffer: Buffer;
}> {
  const abs = path.join(DEMO_ASSET_DIR, fileName);
  const buffer = await fs.readFile(abs);
  return {
    fileName,
    contentType: "image/png",
    buffer,
  };
}

async function uploadViaProxy(args: {
  uploadUrl: string;
  uploadMethod?: string;
  buffer: Buffer;
  contentType: string;
  orgId: string;
  incidentId: string;
  sessionId: string;
  storagePath: string;
  bucket?: string;
  originalName: string;
}): Promise<void> {
  const isLocalStorageEmulatorUrl =
    /127\.0\.0\.1:9199/i.test(String(args.uploadUrl || "")) ||
    /localhost:9199/i.test(String(args.uploadUrl || ""));

  if (isLocalStorageEmulatorUrl) {
    const q = new URLSearchParams({
      orgId: String(args.orgId || ""),
      incidentId: String(args.incidentId || ""),
      sessionId: String(args.sessionId || ""),
      storagePath: String(args.storagePath || ""),
      bucket: String(args.bucket || ""),
      contentType: String(args.contentType || "application/octet-stream"),
      originalName: String(args.originalName || "upload.bin"),
    });

    const res = await fetch(`http://127.0.0.1:3001/api/fn/uploadEvidenceProxyV1?${q.toString()}`, {
      method: "POST",
      headers: { "content-type": args.contentType },
      // Zero-copy Uint8Array view over the same bytes; satisfies BodyInit type.
      body: new Uint8Array(args.buffer),
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`uploadEvidenceProxyV1 -> ${res.status} ${txt.slice(0, 300)}`);
    }
    return;
  }

  const method = String(args.uploadMethod || "PUT").toUpperCase();

  const res = await fetch(args.uploadUrl, {
    method: method === "POST" ? "POST" : "PUT",
    headers: { "content-type": args.contentType },
    // Zero-copy Uint8Array view over the same bytes; satisfies BodyInit type.
    body: new Uint8Array(args.buffer),
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`uploadUrl ${method} -> ${res.status} ${txt.slice(0, 300)}`);
  }
}

async function seedEvidence(sessionId: string): Promise<void> {
  for (let i = 0; i < DEMO_EVIDENCE.length; i += 1) {
    const item = DEMO_EVIDENCE[i];
    const jobId = REVIEWABLE_JOB_IDS[i % REVIEWABLE_JOB_IDS.length];
    const file = await readDemoAsset(item.fileName);

    const createResp = await callFunction<CreateUploadUrlResp>("createEvidenceUploadUrlV1", {
      orgId: ORG_ID,
      incidentId: INCIDENT_ID,
      sessionId,
      fileName: file.fileName,
      originalName: file.fileName,
      contentType: file.contentType,
    });

    const uploadUrl = String(createResp?.uploadUrl || "").trim();
    const storagePath = String(createResp?.storagePath || "").trim();
    const bucket = String(createResp?.bucket || "").trim();

    if (!uploadUrl || !storagePath) {
      throw new Error(`createEvidenceUploadUrlV1 invalid for ${file.fileName}: ${JSON.stringify(createResp)}`);
    }

    await uploadViaProxy({
      uploadUrl,
      uploadMethod: createResp?.uploadMethod,
      buffer: file.buffer,
      contentType: file.contentType,
      orgId: ORG_ID,
      incidentId: INCIDENT_ID,
      sessionId,
      storagePath,
      bucket,
      originalName: file.fileName,
    });

    const created = await callFunction<AddEvidenceResp>("addEvidenceV1", {
      orgId: ORG_ID,
      incidentId: INCIDENT_ID,
      sessionId,
      phase: item.phase,
      labels: item.labels,
      contentType: file.contentType,
      storagePath,
      bucket,
      notes: item.notes,
      originalName: file.fileName,
      jobId,
      actorUid: "dev-admin",
      actorRole: "admin",
    });

    const createdEvidenceId =
      created?.evidenceId ||
      created?.id ||
      created?.docId ||
      created?.evidence?.id ||
      created?.evidence?.evidenceId ||
      null;

    if (!createdEvidenceId) {
      throw new Error(
        `addEvidenceV1 returned no usable evidence id for ${file.fileName}: ${JSON.stringify(created)}`
      );
    }

    await callFunction("assignEvidenceToJobV1", {
      orgId: ORG_ID,
      incidentId: INCIDENT_ID,
      evidenceId: createdEvidenceId,
      jobId,
      updatedBy: ACTOR,
      techUserId: TECH_USER_ID,
    });
  }
}

async function verifyEvidence(): Promise<number> {
  const url = new URL(`${FUNCTIONS_BASE}/listEvidenceLocker`);
  url.searchParams.set("orgId", ORG_ID);
  url.searchParams.set("incidentId", INCIDENT_ID);
  url.searchParams.set("limit", "50");

  const res = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  const json = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(`listEvidenceLocker HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json?.ok === false) {
    throw new Error(`listEvidenceLocker returned ok=false: ${JSON.stringify(json)}`);
  }

  const docs = Array.isArray(json?.docs) ? json.docs : [];

  const matchCount = docs.filter((doc: any) => {
    const sid = String(doc?.sessionId || "");
    const jid = String(doc?.jobId || doc?.evidence?.jobId || "");
    const note = String(doc?.notes || "");
    const storagePath = String(doc?.file?.storagePath || "");
    return sid && REVIEWABLE_JOB_IDS.includes(jid as any) && note.startsWith("Demo seeded evidence") && !!storagePath;
  }).length;
  const byJob = REVIEWABLE_JOB_IDS.map((jobId) => {
    return docs.filter((doc: any) => {
      const jid = String(doc?.jobId || doc?.evidence?.jobId || "");
      const note = String(doc?.notes || "");
      const storagePath = String(doc?.file?.storagePath || "");
      return jid === jobId && note.startsWith("Demo seeded evidence") && !!storagePath;
    }).length;
  });

  if (matchCount < DEMO_EVIDENCE.length) {
    throw new Error(
      `Verification failed. Expected at least ${DEMO_EVIDENCE.length} seeded+assigned real evidence docs, found ${matchCount}. Payload: ${JSON.stringify(json)}`
    );
  }
  if (byJob.some((n) => n < 1)) {
    throw new Error(`Verification failed. Expected seeded evidence on each reviewable job. Counts=${JSON.stringify(byJob)} Payload: ${JSON.stringify(json)}`);
  }

  return matchCount;
}

export async function POST() {
  try {
    await ensureIncidentExists();
    await ensureJobExists();

    const sessionId = await ensureFieldSession();
    if (!sessionId) {
      throw new Error("No sessionId returned from ensureFieldSession");
    }

    await seedEvidence(sessionId);
    const count = await verifyEvidence();

    return NextResponse.json({
      ok: true,
      count,
      incidentId: INCIDENT_ID,
      reviewableJobIds: REVIEWABLE_JOB_IDS,
      sessionId,
    });
  } catch (error: any) {
    console.error("[seed-demo-evidence] failed", error);
    return NextResponse.json(
      {
        ok: false,
        error: error?.message ?? "Unknown error",
      },
      { status: 500 }
    );
  }
}

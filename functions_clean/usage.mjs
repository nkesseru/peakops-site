export function nowIso() {
  return new Date().toISOString();
}

export async function writeUsageEvent(db, evt) {
  const id = db.collection("usage_events").doc().id;
  const createdAt = nowIso();
  await db.collection("usage_events").doc(id).set({ ...evt, id, createdAt }, { merge: true });
  return id;
}

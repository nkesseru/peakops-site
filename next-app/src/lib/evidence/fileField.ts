export function getFileField(ev: any, key: string): any {
  const obj = ev || {};
  const k = String(key || "").trim();
  if (!k) return undefined;

  const flat = obj[`file.${k}`];
  if (flat !== undefined) return flat;

  const file = obj.file;
  if (!file || typeof file !== "object") return undefined;

  if (Object.prototype.hasOwnProperty.call(file, k)) {
    return (file as any)[k];
  }

  const parts = k.split(".");
  let cur: any = file;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, p)) {
      return undefined;
    }
    cur = cur[p];
  }
  return cur;
}


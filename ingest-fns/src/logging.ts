// src/logging.ts

import { db, Timestamp } from "./firebase";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export async function logSystemEvent(entry: {
  level: LogLevel;
  subsystem: string;
  message: string;
  orgId?: string;
  data?: any;
}) {
  try {
    await db.collection("system_logs").add({
      ...entry,
      createdAt: Timestamp.now(),
    });
  } catch (err) {
    // Last-resort logging; don't throw from logger
    console.error("logSystemEvent failed:", err);
  }
}

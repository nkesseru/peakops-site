"use client";
import { useEffect, useState } from "react";

export default function HelloClient() {
  const [message, setMessage] = useState("loading...");
  useEffect(() => {
    fetch("/api/hello")
      .then(r => r.json())
      .then(d => setMessage(d.message ?? "ok"))
      .catch(() => setMessage("unavailable"));
  }, []);
  return <p className="text-gray-600">API says: <span className="font-mono">{message}</span></p>;
}

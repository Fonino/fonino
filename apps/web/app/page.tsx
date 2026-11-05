"use client";
// Debug/visualization UI. Talks only to the local bridge (`agentphone serve`),
// which owns the physical phone. Deployable on Vercel: the browser, not the
// server, calls the user's localhost bridge.

import { useEffect, useState } from "react";

const BRIDGE = process.env.NEXT_PUBLIC_AGENTPHONE_BRIDGE ?? "http://127.0.0.1:7333";

type Device = { id: string; name: string; status: string; adapter: string; detail?: string };
type Run = {
  runId?: string;
  goal: string;
  activity: { t: string; text: string; kind: string }[];
  pending?: { description: string; risk: string };
  result?: { status: string; summary: string; answer?: string };
};

export default function Page() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [goal, setGoal] = useState("");
  const [liveId, setLiveId] = useState<string>();
  const [run, setRun] = useState<Run>();

  useEffect(() => {
    fetch(`${BRIDGE}/api/devices`)
      .then((r) => r.json())
      .then((d: Device[]) => {
        setDevices(d);
        setDeviceId((cur) => cur ?? d[0]?.id);
        setError(undefined);
      })
      .catch(() => setError(`Can't reach the local bridge at ${BRIDGE}. Run: agentphone serve`));
  }, [tick]);

  // Refresh the screen every 2s, and the run state every 1s while a run is live.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!liveId) return;
    const t = setInterval(async () => {
      const r: Run = await fetch(`${BRIDGE}/api/runs/${liveId}`).then((x) => x.json());
      setRun(r);
      if (r.result) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [liveId]);

  const device = devices.find((d) => d.id === deviceId);
  const start = async () => {
    if (!deviceId || !goal.trim()) return;
    setRun(undefined);
    const r = await fetch(`${BRIDGE}/api/devices/${deviceId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal }),
    }).then((x) => x.json());
    if (r.error) setError(r.error);
    else setLiveId(r.runId);
  };
  const answer = (allow: boolean) =>
    fetch(`${BRIDGE}/api/runs/${liveId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow }),
    });
  const running = !!liveId && !run?.result;

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px", display: "flex", gap: 32, flexWrap: "wrap" }}>
      <section style={{ flex: "0 0 auto" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>AgentPhone</h1>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} style={{ marginBottom: 8 }}>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>{d.id} — {d.name}</option>
          ))}
        </select>
        {device && (
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            <span style={{ color: device.status === "connected" ? "#1a7f37" : "#b35900" }}>●</span> {device.status}
            {device.detail && <div style={{ color: "#666", maxWidth: 320 }}>{device.detail}</div>}
          </div>
        )}
        {deviceId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${BRIDGE}/api/devices/${deviceId}/screen.png?t=${tick}`}
            alt="phone screen"
            style={{ width: 300, borderRadius: 24, background: "#000", display: "block" }}
          />
        )}
      </section>

      <section style={{ flex: "1 1 320px", minWidth: 0 }}>
        {error && <p style={{ color: "#c00" }}>{error}</p>}
        <h2 style={{ fontSize: 16 }}>Task</h2>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          placeholder="Open Settings and tell me the iOS version"
          style={{ width: "100%", boxSizing: "border-box", font: "inherit", padding: 8 }}
        />
        <button onClick={start} disabled={running || !goal.trim()} style={{ marginTop: 8, padding: "6px 16px" }}>
          {running ? "Running…" : "Run"}
        </button>

        {run?.pending && (
          <div style={{ marginTop: 16, padding: 12, background: "#fff4e5", borderRadius: 8 }}>
            <b>Agent wants to perform a {run.pending.risk.replace("_", " ")} action:</b>
            <p>{run.pending.description}</p>
            <button onClick={() => answer(true)}>Allow</button>{" "}
            <button onClick={() => answer(false)}>Deny</button>
          </div>
        )}

        <h2 style={{ fontSize: 16, marginTop: 24 }}>Activity</h2>
        <ul style={{ listStyle: "none", padding: 0, fontSize: 14 }}>
          {run?.activity.map((a, i) => (
            <li key={i} style={{ padding: "3px 0", color: a.kind === "warn" ? "#b35900" : a.kind === "done" ? "#1a7f37" : "#111" }}>
              → {a.text}
            </li>
          ))}
          {running && <li style={{ color: "#666" }}>→ Waiting…</li>}
        </ul>
        {run?.runId && <p style={{ fontSize: 12, color: "#666" }}>Replay: agentphone replay {run.runId} --open</p>}
      </section>
    </main>
  );
}

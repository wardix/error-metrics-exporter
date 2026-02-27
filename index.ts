import { Hono } from "hono";

const app = new Hono();

type ErrorRecord = {
  ts: number;
  host: string;
  method: string;
  path: string;
  status: string;
  labelStr: string;
};

// Array to store logs with their metadata
let errorLogs: ErrorRecord[] = [];

// Total errors received since the server started, grouped by labels
let totalErrorsMap: Record<string, number> = {};

// Keep max 24 hours of history to avoid memory leak
const MAX_HISTORY_MS = 24 * 60 * 60 * 1000;

// Cleanup old logs periodically (every 10 minutes)
setInterval(
  () => {
    const cutoff = Date.now() - MAX_HISTORY_MS;
    errorLogs = errorLogs.filter((log) => log.ts >= cutoff);
  },
  10 * 60 * 1000,
);

// Route to receive logs from rsyslog (omhttp)
app.post("/api/logs", async (c) => {
  try {
    const data = await c.req.json();
    // omhttp can send a single object or an array of objects
    const logs = Array.isArray(data) ? data : [data];

    // Process each log entry
    for (const log of logs) {
      const ts = log.timestamp ? new Date(log.timestamp).getTime() : Date.now();

      // Extract host, method, path, and status from the incoming JSON log
      const host = log.host || "UNKNOWN";
      const method = log.method || "UNKNOWN";
      const path = log.path || "UNKNOWN";
      const status = log.status ? String(log.status) : "UNKNOWN";

      const labelStr = `host="${host}",method="${method}",path="${path}",status="${status}"`;

      errorLogs.push({ ts, host, method, path, status, labelStr });

      if (!totalErrorsMap[labelStr]) {
        totalErrorsMap[labelStr] = 0;
      }
      totalErrorsMap[labelStr]++;
    }

    return c.json({ status: "ok", processed: logs.length });
  } catch (err) {
    console.error("Error processing logs:", err);
    return c.json({ error: "Invalid payload" }, 400);
  }
});

// Helper to format Prometheus lines
function buildMetricLines(
  metricName: string,
  mapCount: Record<string, number>,
): string[] {
  const lines: string[] = [];
  for (const [labelStr, count] of Object.entries(mapCount)) {
    lines.push(`${metricName}{${labelStr}} ${count}`);
  }
  // If there are no errors yet, output at least the metric with 0 total (without labels)
  if (lines.length === 0 && metricName === "error_count_total") {
    lines.push(`${metricName} 0`);
  }
  return lines;
}

// Metrics endpoint formatted for Prometheus
app.get("/metrics", (c) => {
  const now = Date.now();

  const map1m: Record<string, number> = {};
  const map5m: Record<string, number> = {};
  const map15m: Record<string, number> = {};
  const map1h: Record<string, number> = {};

  // Initialize all known labels with 0 so the metric doesn't disappear when there are no errors
  for (const labelStr of Object.keys(totalErrorsMap)) {
    map1m[labelStr] = 0;
    map5m[labelStr] = 0;
    map15m[labelStr] = 0;
    map1h[labelStr] = 0;
  }

  // Calculate periods
  for (const log of errorLogs) {
    if (log.ts >= now - 1 * 60 * 1000) map1m[log.labelStr]!++;
    if (log.ts >= now - 5 * 60 * 1000) map5m[log.labelStr]!++;
    if (log.ts >= now - 15 * 60 * 1000) map15m[log.labelStr]!++;
    if (log.ts >= now - 60 * 60 * 1000) map1h[log.labelStr]!++;
  }

  // Construct Prometheus plaintext metrics format
  const lines = [
    "# HELP error_count_total The total number of errors received since start.",
    "# TYPE error_count_total counter",
    ...buildMetricLines("error_count_total", totalErrorsMap),
    "",
    "# HELP error_count_1m The number of errors received in the last 1 minute.",
    "# TYPE error_count_1m gauge",
    ...buildMetricLines("error_count_1m", map1m),
    "",
    "# HELP error_count_5m The number of errors received in the last 5 minutes.",
    "# TYPE error_count_5m gauge",
    ...buildMetricLines("error_count_5m", map5m),
    "",
    "# HELP error_count_15m The number of errors received in the last 15 minutes.",
    "# TYPE error_count_15m gauge",
    ...buildMetricLines("error_count_15m", map15m),
    "",
    "# HELP error_count_1h The number of errors received in the last 1 hour.",
    "# TYPE error_count_1h gauge",
    ...buildMetricLines("error_count_1h", map1h),
    "",
  ];

  return c.text(lines.join("\n"));
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`Server running at http://localhost:${port}`);

Bun.serve({
  port,
  fetch: app.fetch,
});

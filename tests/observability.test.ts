import {
  test,
  expect,
  describe,
  beforeEach,
  beforeAll,
  afterAll,
} from "bun:test"
import {
  incCounter,
  observeDuration,
  recordHttpRequest,
  snapshotMetrics,
  getRequestId,
  log,
  logger,
  readAppLog,
} from "../src/lib/observability"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

// The observability module stashes its metrics Map on globalThis to survive
// hot reloads in dev. Wipe it before every test for full isolation.
beforeEach(() => {
  const g = globalThis as unknown as { __metrics?: Map<string, unknown> }
  if (g.__metrics) g.__metrics.clear()
})

// Locate the log file the module writes to (logs/app.jsonl under cwd).
const LOG_DIR = join(process.cwd(), "logs")
const LOG_FILE = join(LOG_DIR, "app.jsonl")

// Make sure the log directory + file exist so we can snapshot/restore.
function ensureLogFile() {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, "", "utf-8")
  } catch {
    // ignore — best-effort setup
  }
}

// Snapshot the log file content ONCE before any test runs, restore it after
// all tests finish, so we don't pollute the dev server's real log with test
// entries. Using beforeAll (not beforeEach) ensures the snapshot is the
// pristine pre-test state.
let logSnapshot: string | null = null
beforeAll(() => {
  ensureLogFile()
  try {
    logSnapshot = readFileSync(LOG_FILE, "utf-8")
  } catch {
    logSnapshot = ""
  }
})

afterAll(() => {
  // Restore the log file to its pre-test contents (best-effort).
  try {
    if (logSnapshot !== null) writeFileSync(LOG_FILE, logSnapshot, "utf-8")
  } catch {
    // ignore
  }
})

// ─── incCounter ───────────────────────────────────────────────────────────
describe("incCounter", () => {
  test("creates a counter series and increments it to 1", () => {
    incCounter("test_counter_total", { route: "/a" })
    const snap = snapshotMetrics() as Record<string, {
      counters: Record<string, number>
      histograms: Record<string, unknown>
    }>
    expect(snap.test_counter_total).toBeDefined()
    expect(snap.test_counter_total.counters[`route="/a"`]).toBe(1)
  })

  test("increments the same counter repeatedly", () => {
    incCounter("test_counter_total", { route: "/b" })
    incCounter("test_counter_total", { route: "/b" })
    incCounter("test_counter_total", { route: "/b" })
    const snap = snapshotMetrics() as Record<string, {
      counters: Record<string, number>
    }>
    expect(snap.test_counter_total.counters[`route="/b"`]).toBe(3)
  })

  test("isolates counters by label set", () => {
    incCounter("test_counter_total", { method: "GET" })
    incCounter("test_counter_total", { method: "POST" })
    incCounter("test_counter_total", { method: "GET" })
    const snap = snapshotMetrics() as Record<string, {
      counters: Record<string, number>
    }>
    expect(snap.test_counter_total.counters[`method="GET"`]).toBe(2)
    expect(snap.test_counter_total.counters[`method="POST"`]).toBe(1)
  })

  test("snapshots counter help text", () => {
    incCounter("with_help_total", {}, "Total test requests")
    const snap = snapshotMetrics() as Record<string, { help: string }>
    expect(snap.with_help_total.help).toBe("Total test requests")
  })
})

// ─── observeDuration ──────────────────────────────────────────────────────
describe("observeDuration", () => {
  test("records a histogram with count=1 and matching sum", () => {
    observeDuration("test_duration_seconds", 0.05, { route: "/x" })
    const snap = snapshotMetrics() as Record<string, {
      histograms: Record<
        string,
        { count: number; sum: number; avg: number; buckets: Record<string, number> }
      >
    }>
    const h = snap.test_duration_seconds.histograms[`route="/x"`]
    expect(h).toBeDefined()
    expect(h.count).toBe(1)
    expect(h.sum).toBeCloseTo(0.05, 3)
    expect(h.avg).toBeCloseTo(0.05, 3)
  })

  test("accumulates observations across calls", () => {
    observeDuration("test_duration_seconds", 0.01, { route: "/y" })
    observeDuration("test_duration_seconds", 0.1, { route: "/y" })
    observeDuration("test_duration_seconds", 1.0, { route: "/y" })
    const snap = snapshotMetrics() as Record<string, {
      histograms: Record<
        string,
        { count: number; sum: number; avg: number }
      >
    }>
    const h = snap.test_duration_seconds.histograms[`route="/y"`]
    expect(h.count).toBe(3)
    expect(h.sum).toBeCloseTo(1.11, 3)
    expect(h.avg).toBeCloseTo(0.37, 2)
  })

  test("populates cumulative histogram buckets (small + large durations)", () => {
    // 0.005s should fall into the first bucket and every bucket above it.
    observeDuration("test_duration_seconds", 0.005, { route: "/b1" })
    // 2s should skip the first few buckets and land in the 2.5s+ buckets.
    observeDuration("test_duration_seconds", 2.0, { route: "/b2" })
    const snap = snapshotMetrics() as Record<string, {
      histograms: Record<
        string,
        { buckets: Record<string, number> }
      >
    }>
    const h1 = snap.test_duration_seconds.histograms[`route="/b1"`]
    const h2 = snap.test_duration_seconds.histograms[`route="/b2"`]

    // 0.005s should be in the first bucket (0.005s) and every larger bucket.
    expect(h1.buckets["0.005s"]).toBe(1)
    expect(h1.buckets["10s"]).toBe(1)
    // 2s should NOT be in the 0.005s/0.01s buckets but SHOULD be in 2.5s/5s/10s.
    expect(h2.buckets["0.005s"]).toBe(0)
    expect(h2.buckets["2.5s"]).toBe(1)
    expect(h2.buckets["5s"]).toBe(1)
    expect(h2.buckets["10s"]).toBe(1)
  })
})

// ─── recordHttpRequest ────────────────────────────────────────────────────
describe("recordHttpRequest", () => {
  test("increments the http_requests_total counter with method/route/status_class labels", () => {
    recordHttpRequest("GET", "/api/test", 200, 12)
    const snap = snapshotMetrics() as Record<string, {
      counters: Record<string, number>
    }>
    const key = `method="GET",route="/api/test",status_class="2xx"`
    expect(snap.http_requests_total.counters[key]).toBe(1)
  })

  test("computes status_class correctly for 2xx / 3xx / 4xx / 5xx", () => {
    recordHttpRequest("GET", "/a", 200, 1)
    recordHttpRequest("GET", "/b", 301, 1)
    recordHttpRequest("POST", "/c", 404, 1)
    recordHttpRequest("POST", "/d", 503, 1)
    const snap = snapshotMetrics() as Record<string, {
      counters: Record<string, number>
    }>
    expect(snap.http_requests_total.counters[`method="GET",route="/a",status_class="2xx"`]).toBe(1)
    expect(snap.http_requests_total.counters[`method="GET",route="/b",status_class="3xx"`]).toBe(1)
    expect(snap.http_requests_total.counters[`method="POST",route="/c",status_class="4xx"`]).toBe(1)
    expect(snap.http_requests_total.counters[`method="POST",route="/d",status_class="5xx"`]).toBe(1)
  })

  test("also records a histogram observation with the same labels", () => {
    recordHttpRequest("POST", "/api/track", 200, 25)
    const snap = snapshotMetrics() as Record<string, {
      histograms: Record<
        string,
        { count: number; sum: number }
      >
    }>
    const key = `method="POST",route="/api/track",status_class="2xx"`
    expect(snap.http_request_duration_seconds.histograms[key]).toBeDefined()
    expect(snap.http_request_duration_seconds.histograms[key].count).toBe(1)
    // 25ms → 0.025s
    expect(snap.http_request_duration_seconds.histograms[key].sum).toBeCloseTo(
      0.025,
      3,
    )
  })
})

// ─── getRequestId ─────────────────────────────────────────────────────────
describe("getRequestId", () => {
  test("returns the x-request-id header when present", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-request-id": "req-abc-123" },
    })
    expect(getRequestId(req)).toBe("req-abc-123")
  })

  test("generates a UUID when x-request-id is absent", () => {
    const req = new Request("https://example.com/")
    const id = getRequestId(req)
    expect(id).toBeTruthy()
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (y = 8/9/a/b).
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test("generates a different UUID on each call (no header)", () => {
    const req1 = new Request("https://example.com/")
    const req2 = new Request("https://example.com/")
    const id1 = getRequestId(req1)
    const id2 = getRequestId(req2)
    expect(id1).not.toBe(id2)
  })
})

// ─── log / logger ─────────────────────────────────────────────────────────
describe("log()", () => {
  test("writes a JSONL line to logs/app.jsonl with ts + caller fields", () => {
    const marker = `test_log_marker_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`
    log({ level: "info", event: marker, requestId: "req-1" })

    const entries = readAppLog(500)
    const ours = entries.find((e) => e.event === marker)
    expect(ours).toBeDefined()
    expect(ours?.level).toBe("info")
    expect(ours?.requestId).toBe("req-1")
    expect(ours?.ts).toBeTruthy()
    // ISO 8601 timestamp.
    expect(ours?.ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    )
  })

  test("the log file exists after a write", () => {
    log({ level: "info", event: "test_log_exists_check" })
    expect(existsSync(LOG_FILE)).toBe(true)
  })
})

describe("logger", () => {
  test("logger.info writes an info-level entry", () => {
    const marker = `test_logger_info_${Date.now()}`
    logger.info(marker, { foo: "bar" })
    const entries = readAppLog(500)
    const ours = entries.find((e) => e.event === marker)
    expect(ours).toBeDefined()
    expect(ours?.level).toBe("info")
    expect(ours?.foo).toBe("bar")
  })

  test("logger.error writes an error-level entry", () => {
    const marker = `test_logger_error_${Date.now()}`
    logger.error(marker, { code: 500 })
    const entries = readAppLog(500)
    const ours = entries.find((e) => e.event === marker)
    expect(ours).toBeDefined()
    expect(ours?.level).toBe("error")
    expect(ours?.code).toBe(500)
  })

  test("logger.warn writes a warn-level entry", () => {
    const marker = `test_logger_warn_${Date.now()}`
    logger.warn(marker)
    const entries = readAppLog(500)
    const ours = entries.find((e) => e.event === marker)
    expect(ours).toBeDefined()
    expect(ours?.level).toBe("warn")
  })
})

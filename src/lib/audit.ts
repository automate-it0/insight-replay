import { mkdir, appendFile, readFile, stat } from "fs/promises";
import { dirname, join } from "path";
import { createHash, createHmac, randomBytes, scryptSync } from "crypto";

/**
 * File-based audit logging for security monitoring & compliance.
 *
 * Logs are written to `<cwd>/logs/audit.jsonl` (one JSON object per line).
 * No database model is involved — keeping this purely file-based avoids
 * coupling audit history to the Prisma schema and means logs survive even
 * if the SQLite file is reset. The `logs/` directory is created at runtime
 * if missing.
 *
 * --- Tamper-evident hash chain (10x#4: Audit hash chain) ---
 * Each chained entry carries `__prev_hash` (the previous chained entry's
 * `__hash`, or `"genesis"` for the first) and `__hash`.
 *
 * v1 (current, CodeQL js/insufficient-password-hash fix): `__hash` =
 * `"hmac:v1:" + HMAC-SHA256(serverSecret, __prev_hash + JSON.stringify(
 * {action, projectId, actor, ip, timestamp}))`. Keying the chain with a
 * server-side secret upgrades tamper-EVIDENCE to tamper-RESISTANCE: with
 * the legacy plain SHA-256, an attacker who can write the log file could
 * rewrite history AND recompute a fully valid chain offline; with the
 * keyed HMAC, forging a valid chain additionally requires the server
 * secret. The `hmac:v1:` version prefix lets the verifiers dispatch per
 * entry, so chains written before the upgrade keep verifying (backward
 * compatibility — existing log files must not report spurious tampering
 * after this deploy).
 *
 * Legacy (pre-v1): `__hash` = plain SHA-256 of the same payload (no
 * prefix). The hash intentionally covers exactly those five fields — NOT
 * the hash fields themselves — so an attacker editing any of those
 * fields retroactively changes the recomputed hash and breaks the chain.
 * `verifyAuditChain(entries)` walks the entries and flags any whose stored
 * `__hash` does not match the recomputed value (algorithm selected by the
 * stored value's version prefix) with `__tampered: true`.
 * The audit read endpoints (`/api/audit`, `/api/projects/[id]/audit`)
 * call `verifyAuditChain()` on the results before returning so consumers
 * see tamper flags on every response.
 *
 * Legacy entries written before this hash-chain version (or with the older
 * `prevHash`/`hash` field names from Task ID 7) lack `__prev_hash`/`__hash`
 * fields; the verifier skips them silently (they are "pre-chain"). A new
 * chain simply starts from `"genesis"` on the first post-upgrade entry.
 */

const AUDIT_LOG_PATH = join(process.cwd(), "logs", "audit.jsonl");

/** Sentinel `__prev_hash` for the first entry in a chain (or after a corrupted tail). */
const GENESIS_HASH = "genesis";

export interface AuditEntry {
  timestamp: string;
  action: string;
  projectId?: string | undefined;
  actor: string;
  ip: string;
  details: Record<string, unknown>;
  /**
   * `__prev_hash` — SHA-256 hex of the previous chained entry (or `"genesis"`
   * for the first). Absent on pre-chain (legacy) entries.
   */
  __prev_hash?: string;
  /**
   * `__hash` — `"hmac:v1:" +` HMAC-SHA256(serverSecret, `__prev_hash` +
   * JSON.stringify({action, projectId, actor, ip, timestamp}))` for
   * entries written since the keyed-hash upgrade; plain SHA-256 of the same
   * payload for older entries (verifiers dispatch on the `hmac:v1:`
   * prefix). Absent on pre-chain (legacy) entries.
   */
  __hash?: string;
}

/**
 * An `AuditEntry` augmented with a tamper flag. Produced by
 * `verifyAuditChain()`. `__tampered === true` means the recomputed hash did
 * not match the stored `__hash` (or the entry was structurally malformed).
 */
export interface VerifiedAuditEntry extends AuditEntry {
  __tampered: boolean;
}

/** Result of running `verifyAuditIntegrity()` over the entire audit log file. */
export interface IntegrityReport {
  /** True iff every chained entry's hash recomputes correctly AND prev_hash continuity holds. */
  valid: boolean;
  /** 1-indexed line number where the chain first broke (only set when `valid === false`). */
  brokenAt?: number;
  /** Total non-empty lines in the file (pre-chain + chained). */
  totalEntries: number;
  /** Number of entries that passed verification (pre-chain entries count as passed/skipped). */
  verifiedEntries: number;
}

/** Summary statistics for the audit log, used by monitoring / admin dashboards. */
export interface AuditStats {
  totalEntries: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Output of `verifyAuditIntegrity().valid` — false if the chain is broken. */
  chainValid: boolean;
  /** File size in bytes (0 if the file does not exist). */
  fileSize: number;
}

/** Canonical audit action names — use these constants at call sites. */
export const AUDIT_ACTIONS = {
  PROJECT_CREATED: "project_created",
  PROJECT_DELETED: "project_deleted",
  APIKEY_CREATED: "apikey_created",
  APIKEY_REVOKED: "apikey_revoked",
  ALERT_CREATED: "alert_created",
  ALERT_DELETED: "alert_deleted",
  DATA_EXPORTED: "data_exported",
  ALERT_TRIGGERED: "alert_triggered",
  SESSION_BOOKMARKED: "session_bookmarked",
  SESSION_TAGGED: "session_tagged",
} as const;

// ─── Chain-hash primitives (v1 keyed + legacy) ───────────────────────────
//
// CodeQL `js/insufficient-password-hash` flagged the plain-SHA-256 chain
// hash. v1 chains are now keyed with HMAC-SHA256 under a server-side
// secret (see the tamper-evident-chain block comment at the top of this
// file); the legacy plain digest is retained VERIFICATION-ONLY so
// pre-upgrade chains keep verifying (backward compatibility — existing
// log files must not report spurious tampering after this deploy).
//
// Secret resolution follows the fail-closed pattern of src/lib/session.ts
// / db-encryption.ts: prefer a dedicated `AUDIT_HMAC_SECRET` (rotate the
// audit-chain key without touching session cookies or DB encryption),
// fall back to `SESSION_SECRET` (mandatory in production anyway — startup.ts,
// session.ts and db-encryption.ts all refuse to boot without it, so no
// currently-booting deployment can hit the throw below), and in
// non-production with neither set use an ephemeral per-process random key
// (same dev ergonomics as db-encryption's ephemeral key: after a restart,
// v1 entries written under the previous ephemeral key recompute
// differently and are reported as tampered — loud by design, and fixed by
// setting the secret in .env.local).
//
// ROTATION CAVEAT: changing the secret changes what v1 entries hash to.
// Entries written under the OLD secret will be flagged `__tampered` after
// the rotation (legacy plain-SHA-256 entries are unaffected — they are
// keyless). When rotating, archive/seal the old log (or accept the flags)
// — there is no way to verify a keyed chain without the key that keyed it.

/** Version prefix on `__hash` values written by the v1 keyed scheme. */
const HMAC_V1_PREFIX = "hmac:v1:";

/** scrypt salt for deriving the audit HMAC key (domain separation). */
const AUDIT_HMAC_SALT = "insight-replay-audit-hmac-v1";

function resolveAuditHmacKey(): Buffer {
  const raw = process.env.AUDIT_HMAC_SECRET || process.env.SESSION_SECRET;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      // Fail-closed, loud by design. Unreachable for any deployment that
      // currently boots (they all already require SESSION_SECRET at boot).
      throw new Error(
        "AUDIT_HMAC_SECRET (or SESSION_SECRET) is not set — refusing to " +
          "boot in production without an HMAC key for the audit hash " +
          "chain. Set AUDIT_HMAC_SECRET in the environment (see " +
          "scripts/generate-secret.sh).",
      );
    }
    // Dev/test-only ephemeral fallback — see the rotation caveat above.
    return randomBytes(32);
  }
  // Stretch + domain-separate (same derivation pattern as crypto.ts's
  // ENCRYPTION_KEY): even when falling back to SESSION_SECRET, the audit
  // chain key differs from every other key derived from that secret.
  return scryptSync(raw, AUDIT_HMAC_SALT, 32);
}

const AUDIT_HMAC_KEY = resolveAuditHmacKey();

/**
 * Legacy plain SHA-256 hex digest — VERIFICATION-ONLY. Used exclusively
 * to recompute hashes for pre-v1 entries (whose stored `__hash` has no
 * `hmac:v1:` prefix) so existing log files keep verifying. New entries
 * are always written with `hmacV1` below.
 */
function legacySha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** v1 keyed digest: HMAC-SHA256 under the server secret, version-prefixed. */
function hmacV1(s: string): string {
  return (
    HMAC_V1_PREFIX +
    createHmac("sha256", AUDIT_HMAC_KEY).update(s, "utf8").digest("hex")
  );
}

/**
 * Build the canonical 5-field hash payload for an entry.
 *
 * Per the 10x#4 spec, the hash covers EXACTLY `{action, projectId, actor,
 * ip, timestamp}` — not the whole entry, not `details`, not the hash fields
 * themselves. Key insertion order is fixed (`action, projectId, actor, ip,
 * timestamp`) so `JSON.stringify` is deterministic. If `projectId` is
 * undefined, `JSON.stringify` omits the key, which is consistent on both the
 * writer and verifier sides.
 */
function hashPayload(
  entry: Pick<AuditEntry, "action" | "projectId" | "actor" | "ip" | "timestamp">,
): {
  action: string;
  projectId?: string | undefined;
  actor: string;
  ip: string;
  timestamp: string;
} {
  return {
    action: entry.action,
    projectId: entry.projectId,
    actor: entry.actor,
    ip: entry.ip,
    timestamp: entry.timestamp,
  };
}

/**
 * Compute the chain hash for an entry — v1 keyed construction (writer).
 *
 * `__hash` = "hmac:v1:" + HMAC-SHA256(serverSecret, `__prev_hash` +
 * JSON.stringify({action, projectId, actor, ip, timestamp})). The
 * `__prev_hash` is prepended as a literal string so editing any of the five
 * covered fields, or editing the `__prev_hash` itself, changes the
 * recomputed hash and breaks the chain — and the keying means an attacker
 * needs the server secret to forge a replacement chain.
 */
function computeEntryHash(prevHash: string, entry: AuditEntry): string {
  return hmacV1(prevHash + JSON.stringify(hashPayload(entry)));
}

/**
 * Recompute an entry's chain hash for VERIFICATION, using the algorithm
 * indicated by the stored `__hash`'s version prefix:
 *   - `hmac:v1:…` → keyed HMAC (entries written by the current writer),
 *   - anything else → legacy plain SHA-256 (pre-upgrade entries; verified
 *     keylessly so existing log files keep passing after this deploy).
 * Keeping the dispatch on the STORED value (rather than the current
 * configuration) is what makes the upgrade backward compatible.
 */
function recomputeEntryHash(
  prevHash: string,
  entry: AuditEntry,
  storedHash: string,
): string {
  return storedHash.startsWith(HMAC_V1_PREFIX)
    ? hmacV1(prevHash + JSON.stringify(hashPayload(entry)))
    : legacySha256(prevHash + JSON.stringify(hashPayload(entry)));
}

/**
 * Read the last non-empty line of the audit log file.
 * Returns `null` if the file does not exist, is empty, or contains only
 * whitespace. The raw line is returned as-is — the caller parses/validates.
 */
async function readLastLine(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) return lines[i];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append a single audit entry to the JSONL log file.
 *
 * The current ISO timestamp is added automatically. The entry is extended
 * with `__prev_hash` (the previous chained entry's `__hash`, or `"genesis"`
 * for the first chained entry) and `__hash` ("hmac:v1:" +
 * HMAC-SHA256(serverSecret, `__prev_hash` + JSON.stringify({action,
 * projectId, actor, ip, timestamp}))), forming a tamper-evident chain.
 * Wrapped in try/catch so logging failures never propagate to the caller —
 * a broken audit trail must not break the user's request.
 *
 * Edge cases:
 *  - File doesn't exist or is empty → first entry has `__prev_hash: "genesis"`.
 *  - Last line is unparseable JSON → start a new chain from `"genesis"` and
 *    emit a warning.
 *  - Last line is a legacy pre-chain entry (no `__hash` field, including
 *    older Task-7 entries that used `hash`) → start a new chain from
 *    `"genesis"` and emit a warning.
 *  - Concurrent writes: `appendFile` is atomic on POSIX for writes under the
 *    pipe-buffer size (~4KB); our lines are well under that.
 */
export async function auditLog(
  entry: Omit<AuditEntry, "timestamp" | "__prev_hash" | "__hash">,
): Promise<void> {
  try {
    await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });

    // Build the entry from known fields only — never carry over a
    // caller-supplied `__prev_hash`/`__hash` (which would let a caller forge a
    // chain link). `details` defaults to `{}` for safety.
    const entryCore: AuditEntry = {
      action: entry.action,
      actor: entry.actor,
      ip: entry.ip,
      details: entry.details ?? {},
      timestamp: new Date().toISOString(),
    };
    if (entry.projectId !== undefined) {
      entryCore.projectId = entry.projectId;
    }

    // Resolve the previous hash from the last on-disk line.
    let prevHash = GENESIS_HASH;
    const lastLine = await readLastLine(AUDIT_LOG_PATH);
    if (lastLine !== null) {
      try {
        const parsed = JSON.parse(lastLine) as {
          __hash?: unknown;
          hash?: unknown;
        };
        // Prefer the spec-named `__hash`; fall back to legacy `hash` so we
        // can chain across the Task-7 → 10x#4 migration boundary.
        const hashField =
          typeof parsed.__hash === "string" && parsed.__hash.length > 0
            ? parsed.__hash
            : typeof parsed.hash === "string" && parsed.hash.length > 0
              ? parsed.hash
              : null;
        if (hashField) {
          prevHash = hashField;
        } else {
          // Legacy pre-chain entry (no `__hash` field) → start a new chain.
          console.warn(
            "[audit] Previous entry lacks a __hash field; starting a new chain from genesis.",
          );
        }
      } catch {
        // Corrupted last line → start a new chain and warn.
        console.warn(
          "[audit] Last audit line is unparseable; starting a new chain from genesis.",
        );
      }
    }

    const hash = computeEntryHash(prevHash, entryCore);
    const line = JSON.stringify({
      ...entryCore,
      __prev_hash: prevHash,
      __hash: hash,
    }) + "\n";
    await appendFile(AUDIT_LOG_PATH, line, "utf8");
  } catch {
    // Intentionally swallowed — audit logging must never break the request.
  }
}

/**
 * Read the last `limit` audit entries from the log file.
 *
 * Entries are appended chronologically, so the most recent entries are at the
 * end of the file — we return the trailing `limit` of the parsed list. Returns
 * an empty array if the file does not exist yet (e.g. nothing has been audited).
 */
export async function readAuditLog(limit = 100): Promise<AuditEntry[]> {
  try {
    const raw = await readFile(AUDIT_LOG_PATH, "utf8");
    const lines = raw.split("\n");
    const parsed: AuditEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed) as AuditEntry);
      } catch {
        // Skip malformed line — never let one bad line break the whole read.
      }
    }
    const start = Math.max(0, parsed.length - limit);
    return parsed.slice(start);
  } catch {
    // File not found / unreadable → treat as empty log.
    return [];
  }
}

/**
 * Verify a list of audit entries' hash chain.
 *
 * For each entry this recomputes `__hash` — keyed HMAC for `hmac:v1:`-
 * prefixed values, legacy plain SHA-256 otherwise — over `__prev_hash` +
 * JSON.stringify({action, projectId, actor, ip, timestamp}) from the entry's
 * own fields and compares it to the stored `__hash`. Any mismatch marks the
 * entry with `__tampered: true`. Tampering with `action`, `projectId`,
 * `actor`, `ip`, or `timestamp` (or with `__prev_hash` itself, which feeds
 * the hash input) breaks the recomputed hash and is detected here.
 *
 * Behavior for legacy/malformed entries:
 *  - Pre-chain entries (no `__prev_hash` AND no `__hash`): grandfathered in,
 *    returned with `__tampered: false` (skipped silently).
 *  - Partial entries (exactly one of `__prev_hash`/`__hash` present): malformed,
 *    returned with `__tampered: true`.
 *
 * Notes:
 *  - This function does NOT check chain continuity (`__prev_hash` == previous
 *    entry's `__hash`). That makes it safe to call on filtered subsets (e.g.
 *    `/api/projects/[id]/audit` filters by `projectId`). The full-chain
 *    continuity check lives in `verifyAuditIntegrity()`.
 *  - The input array is not mutated — a new array of shallow-copied entries is
 *    returned.
 */
export function verifyAuditChain<T extends AuditEntry>(
  entries: T[],
): (T & { __tampered: boolean })[] {
  return entries.map((entry) => {
    const hasHash =
      typeof entry.__hash === "string" && (entry.__hash as string).length > 0;
    const hasPrevHash =
      typeof entry.__prev_hash === "string" &&
      (entry.__prev_hash as string).length > 0;

    // Pre-chain (legacy) entry: no hash fields → skipped silently, untampered.
    if (!hasHash && !hasPrevHash) {
      return { ...entry, __tampered: false };
    }

    // Partial entry (only one of __hash/__prev_hash present): malformed.
    if (!hasHash || !hasPrevHash) {
      return { ...entry, __tampered: true };
    }

    // Hash check: recompute over `__prev_hash + JSON.stringify({action,
    // projectId, actor, ip, timestamp})` using the algorithm the STORED
    // `__hash`'s version prefix indicates (keyed HMAC for `hmac:v1:`
    // values, legacy plain SHA-256 otherwise) and compare to stored __hash.
    const recomputed = recomputeEntryHash(
      entry.__prev_hash as string,
      entry,
      entry.__hash as string,
    );
    return { ...entry, __tampered: recomputed !== entry.__hash };
  });
}

/**
 * Verify the audit log file's full hash chain (continuity + per-entry hash).
 *
 * Walks every non-empty line. For each chained entry (one with both
 * `__prev_hash` and `__hash` fields):
 *   1. Continuity check — `__prev_hash` must equal the `__hash` of the previous
 *      chained entry (or `"genesis"` for the first chained entry).
 *   2. Hash check — recomputing the entry's hash (keyed HMAC for
 *      `hmac:v1:`-prefixed values, legacy plain SHA-256 otherwise) over
 *      `__prev_hash + JSON.stringify({action, projectId, actor, ip,
 *      timestamp})` must equal the stored `__hash`.
 *
 * Legacy pre-chain entries (no `__prev_hash`/`__hash`) are skipped silently —
 * they are grandfathered in but do not contribute to the chain.
 *
 * @returns `{ valid, brokenAt?, totalEntries, verifiedEntries }`. If the file
 *          does not exist, returns `{ valid: true, totalEntries: 0, verifiedEntries: 0 }`.
 */
export async function verifyAuditIntegrity(): Promise<IntegrityReport> {
  let lines: string[] = [];
  try {
    const raw = await readFile(AUDIT_LOG_PATH, "utf8");
    lines = raw.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    // No file → trivially valid (nothing to tamper with).
    return { valid: true, totalEntries: 0, verifiedEntries: 0 };
  }

  let verified = 0;
  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return {
        valid: false,
        brokenAt: lineNum,
        totalEntries: lines.length,
        verifiedEntries: verified,
      };
    }

    const hasHash = typeof parsed.__hash === "string";
    const hasPrevHash = typeof parsed.__prev_hash === "string";

    // Legacy pre-chain entry — skip silently, do not advance expectedPrevHash.
    if (!hasHash && !hasPrevHash) {
      verified++;
      continue;
    }

    // A partial entry (one field present, the other missing) is malformed.
    if (!hasHash || !hasPrevHash) {
      return {
        valid: false,
        brokenAt: lineNum,
        totalEntries: lines.length,
        verifiedEntries: verified,
      };
    }

    const prevHash = parsed.__prev_hash as string;
    const storedHash = parsed.__hash as string;

    // Continuity: __prev_hash must match the previous chained entry's __hash.
    if (prevHash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAt: lineNum,
        totalEntries: lines.length,
        verifiedEntries: verified,
      };
    }

    // Hash: recompute over `__prev_hash + JSON.stringify({action, projectId,
    // actor, ip, timestamp})`, using the algorithm the stored `__hash`'s
    // version prefix indicates (keyed HMAC for `hmac:v1:` values, legacy
    // plain SHA-256 otherwise).
    const recomputed = recomputeEntryHash(
      prevHash,
      parsed as unknown as AuditEntry,
      storedHash,
    );
    if (recomputed !== storedHash) {
      return {
        valid: false,
        brokenAt: lineNum,
        totalEntries: lines.length,
        verifiedEntries: verified,
      };
    }

    expectedPrevHash = storedHash;
    verified++;
  }

  return {
    valid: true,
    totalEntries: lines.length,
    verifiedEntries: verified,
  };
}

/**
 * Return summary statistics for the audit log: total entry count, first/last
 * timestamps, current chain validity (calls `verifyAuditIntegrity`), and
 * on-disk file size in bytes. Safe to call when the file does not exist —
 * returns zeros and `null` timestamps in that case.
 */
export async function getAuditStats(): Promise<AuditStats> {
  let lines: string[] = [];
  let fileSize = 0;

  try {
    const raw = await readFile(AUDIT_LOG_PATH, "utf8");
    lines = raw.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    // File missing — leave lines empty.
  }
  try {
    const stats = await stat(AUDIT_LOG_PATH);
    fileSize = stats.size;
  } catch {
    // File missing — fileSize stays 0.
  }

  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { timestamp?: unknown };
      if (typeof parsed.timestamp === "string") {
        if (firstTimestamp === null) firstTimestamp = parsed.timestamp;
        lastTimestamp = parsed.timestamp;
      }
    } catch {
      // Skip malformed line.
    }
  }

  const integrity = await verifyAuditIntegrity();

  return {
    totalEntries: lines.length,
    firstTimestamp,
    lastTimestamp,
    chainValid: integrity.valid,
    fileSize,
  };
}

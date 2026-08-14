import { env } from "cloudflare:workers";
import { DEFAULT_RULE_POLICY, type RulePolicy } from "./rules-engine.ts";

export type RuleSettings = {
  aggressivenessFactor: number;
  maxBidChange: number;
  minimumClicks: number;
  policy: RulePolicy;
};

export type SaveRecord<T> = {
  value: T;
  revision: number;
  updatedAt: string;
  updatedBy: string;
};

export type ReviewDecisionRecord = {
  decision: "approved" | "rejected";
  revision: number;
  updatedAt: string;
  updatedBy: string;
};

export type AuditRecord = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  changedBy: string;
  changedAt: string;
};

const SETTINGS_ID = "organization";
const DEFAULT_SETTINGS: RuleSettings = {
  aggressivenessFactor: 0.8,
  maxBidChange: 0.2,
  minimumClicks: 5,
  policy: DEFAULT_RULE_POLICY,
};

function database(): D1Database {
  const runtime = env as unknown as { DB?: D1Database };
  if (!runtime.DB) throw new Error("Persistent collaboration storage is unavailable.");
  return runtime.DB;
}

export class RevisionConflictError extends Error {
  constructor(public current: unknown) {
    super("This record was changed by another user. The latest saved version has been loaded.");
  }
}

export async function ensureCollaborationSchema(): Promise<void> {
  const db = database();
  const seededAt = new Date().toISOString();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS organization_settings (
      id TEXT PRIMARY KEY NOT NULL,
      aggressiveness_factor REAL NOT NULL,
      max_bid_change REAL NOT NULL,
      minimum_clicks INTEGER NOT NULL,
      policy_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS review_decisions (
      snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id),
      suggestion_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, suggestion_id)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS review_decisions_snapshot_idx ON review_decisions (snapshot_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS review_decisions_updated_by_idx ON review_decisions (updated_by)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_preferences (
      user_email TEXT PRIMARY KEY NOT NULL,
      preferences_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS change_audit (
      id TEXT PRIMARY KEY NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS change_audit_changed_at_idx ON change_audit (changed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS change_audit_entity_idx ON change_audit (entity_type, entity_id)"),
  ]);
  const columns = await db.prepare("PRAGMA table_info(organization_settings)").all<Record<string, unknown>>();
  if (!columns.results.some((column) => String(column.name) === "policy_json")) {
    await db.prepare("ALTER TABLE organization_settings ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'").run();
  }
  await db.prepare(`INSERT OR IGNORE INTO organization_settings (
    id, aggressiveness_factor, max_bid_change, minimum_clicks, policy_json, revision, updated_at, updated_by
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).bind(
    SETTINGS_ID,
    DEFAULT_SETTINGS.aggressivenessFactor,
    DEFAULT_SETTINGS.maxBidChange,
    DEFAULT_SETTINGS.minimumClicks,
    JSON.stringify(DEFAULT_SETTINGS.policy),
    seededAt,
    "Application defaults",
  ).run();
}

function settingsFromRow(row: Record<string, unknown>): SaveRecord<RuleSettings> {
  let savedPolicy: Partial<RulePolicy> = {};
  try {
    const parsed = JSON.parse(String(row.policy_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) savedPolicy = parsed as Partial<RulePolicy>;
  } catch {
    savedPolicy = {};
  }
  return {
    value: {
      aggressivenessFactor: Number(row.aggressiveness_factor),
      maxBidChange: Number(row.max_bid_change),
      minimumClicks: Number(row.minimum_clicks),
      policy: { ...DEFAULT_RULE_POLICY, ...savedPolicy },
    },
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

async function getSettingsRow(): Promise<SaveRecord<RuleSettings>> {
  const row = await database().prepare("SELECT * FROM organization_settings WHERE id = ?").bind(SETTINGS_ID).first<Record<string, unknown>>();
  if (!row) throw new Error("Organization settings are unavailable.");
  return settingsFromRow(row);
}

function parsePreferences(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function getCollaborationState(userEmail: string, snapshotId: string) {
  await ensureCollaborationSchema();
  const db = database();
  const [settings, reviewsResult, preferencesRow, auditResult] = await Promise.all([
    getSettingsRow(),
    db.prepare("SELECT * FROM review_decisions WHERE snapshot_id = ?").bind(snapshotId).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM user_preferences WHERE user_email = ?").bind(userEmail).first<Record<string, unknown>>(),
    db.prepare(`SELECT id, entity_type, entity_id, action, changed_by, changed_at
      FROM change_audit
      WHERE entity_type != 'preferences' OR changed_by = ?
      ORDER BY changed_at DESC LIMIT 20`).bind(userEmail).all<Record<string, unknown>>(),
  ]);
  const reviews = Object.fromEntries(reviewsResult.results.map((row) => [String(row.suggestion_id), {
    decision: String(row.decision) as "approved" | "rejected",
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    updatedBy: String(row.updated_by),
  } satisfies ReviewDecisionRecord]));
  return {
    settings,
    reviews,
    preferences: {
      value: parsePreferences(preferencesRow?.preferences_json),
      revision: Number(preferencesRow?.revision ?? 0),
      updatedAt: String(preferencesRow?.updated_at ?? ""),
      updatedBy: userEmail,
    },
    audit: auditResult.results.map((row) => ({
      id: String(row.id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      action: String(row.action),
      changedBy: String(row.changed_by),
      changedAt: String(row.changed_at),
    } satisfies AuditRecord)),
  };
}

function writeAudit(
  db: D1Database,
  entityType: string,
  entityId: string,
  action: string,
  beforeValue: unknown,
  afterValue: unknown,
  changedBy: string,
  changedAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO change_audit (
    id, entity_type, entity_id, action, before_json, after_json, changed_by, changed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(),
    entityType,
    entityId,
    action,
    beforeValue == null ? null : JSON.stringify(beforeValue),
    afterValue == null ? null : JSON.stringify(afterValue),
    changedBy,
    changedAt,
  );
}

export async function saveOrganizationSettings(
  value: RuleSettings,
  expectedRevision: number,
  userEmail: string,
): Promise<SaveRecord<RuleSettings>> {
  await ensureCollaborationSchema();
  const db = database();
  const before = await getSettingsRow();
  if (before.revision !== expectedRevision) throw new RevisionConflictError(before);
  const updatedAt = new Date().toISOString();
  const update = await db.prepare(`UPDATE organization_settings
    SET aggressiveness_factor = ?, max_bid_change = ?, minimum_clicks = ?, policy_json = ?,
        revision = revision + 1, updated_at = ?, updated_by = ?
    WHERE id = ? AND revision = ?`).bind(
      value.aggressivenessFactor,
      value.maxBidChange,
      value.minimumClicks,
      JSON.stringify(value.policy),
      updatedAt,
      userEmail,
      SETTINGS_ID,
      expectedRevision,
    ).run();
  if ((update.meta?.changes ?? 0) !== 1) throw new RevisionConflictError(await getSettingsRow());
  const after: SaveRecord<RuleSettings> = { value, revision: expectedRevision + 1, updatedAt, updatedBy: userEmail };
  await writeAudit(db, "settings", SETTINGS_ID, "updated", before, after, userEmail, updatedAt).run();
  return after;
}

export async function saveReviewDecision(input: {
  snapshotId: string;
  suggestionId: string;
  decision: "approved" | "rejected" | null;
  expectedRevision: number;
  userEmail: string;
}): Promise<ReviewDecisionRecord | null> {
  await ensureCollaborationSchema();
  const db = database();
  const existing = await db.prepare("SELECT * FROM review_decisions WHERE snapshot_id = ? AND suggestion_id = ?")
    .bind(input.snapshotId, input.suggestionId).first<Record<string, unknown>>();
  const currentRevision = Number(existing?.revision ?? 0);
  if (currentRevision !== input.expectedRevision) {
    throw new RevisionConflictError(existing ? {
      decision: String(existing.decision),
      revision: currentRevision,
      updatedAt: String(existing.updated_at),
      updatedBy: String(existing.updated_by),
    } : null);
  }
  const updatedAt = new Date().toISOString();
  if (input.decision == null) {
    if (existing) {
      const deleted = await db.prepare("DELETE FROM review_decisions WHERE snapshot_id = ? AND suggestion_id = ? AND revision = ?")
        .bind(input.snapshotId, input.suggestionId, currentRevision).run();
      if ((deleted.meta?.changes ?? 0) !== 1) throw new RevisionConflictError(null);
      await writeAudit(db, "review", `${input.snapshotId}:${input.suggestionId}`, "cleared", existing, null, input.userEmail, updatedAt).run();
    }
    return null;
  }
  const next: ReviewDecisionRecord = {
    decision: input.decision,
    revision: currentRevision + 1,
    updatedAt,
    updatedBy: input.userEmail,
  };
  if (existing) {
    const update = await db.prepare(`UPDATE review_decisions
      SET decision = ?, revision = revision + 1, updated_at = ?, updated_by = ?
      WHERE snapshot_id = ? AND suggestion_id = ? AND revision = ?`).bind(
        input.decision,
        updatedAt,
        input.userEmail,
        input.snapshotId,
        input.suggestionId,
        currentRevision,
      ).run();
    if ((update.meta?.changes ?? 0) !== 1) throw new RevisionConflictError(null);
  } else {
    await db.prepare(`INSERT INTO review_decisions (
      snapshot_id, suggestion_id, decision, revision, updated_at, updated_by
    ) VALUES (?, ?, ?, 1, ?, ?)`).bind(
      input.snapshotId,
      input.suggestionId,
      input.decision,
      updatedAt,
      input.userEmail,
    ).run();
  }
  await writeAudit(db, "review", `${input.snapshotId}:${input.suggestionId}`, existing ? "updated" : "created", existing, next, input.userEmail, updatedAt).run();
  return next;
}

export async function saveUserPreferences(
  preferences: Record<string, unknown>,
  expectedRevision: number,
  userEmail: string,
) {
  await ensureCollaborationSchema();
  const db = database();
  const existing = await db.prepare("SELECT * FROM user_preferences WHERE user_email = ?").bind(userEmail).first<Record<string, unknown>>();
  const currentRevision = Number(existing?.revision ?? 0);
  const currentValue = parsePreferences(existing?.preferences_json);
  if (currentRevision !== expectedRevision) throw new RevisionConflictError({
    value: currentValue,
    revision: currentRevision,
    updatedAt: String(existing?.updated_at ?? ""),
    updatedBy: userEmail,
  });
  const updatedAt = new Date().toISOString();
  const nextRevision = currentRevision + 1;
  const json = JSON.stringify(preferences);
  if (existing) {
    const update = await db.prepare(`UPDATE user_preferences
      SET preferences_json = ?, revision = revision + 1, updated_at = ?
      WHERE user_email = ? AND revision = ?`).bind(json, updatedAt, userEmail, currentRevision).run();
    if ((update.meta?.changes ?? 0) !== 1) throw new RevisionConflictError(null);
  } else {
    await db.prepare(`INSERT INTO user_preferences (
      user_email, preferences_json, revision, updated_at
    ) VALUES (?, ?, 1, ?)`).bind(userEmail, json, updatedAt).run();
  }
  await writeAudit(db, "preferences", userEmail, existing ? "updated" : "created", currentValue, preferences, userEmail, updatedAt).run();
  return { value: preferences, revision: nextRevision, updatedAt, updatedBy: userEmail };
}

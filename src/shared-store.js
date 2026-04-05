/**
 * SharedStore — cross-agent artifact sharing
 *
 * Extends ArtifactStore with two additions:
 *
 *   1. find(query)  — scan manifests and filter by metadata fields
 *                     (agentId, tags, taskId, type, filename)
 *
 *   2. Redis pub/sub notification — when a Redis client is injected,
 *      writeArtifact() publishes an `artifact_ready` event to the
 *      `a2a:agents` broadcast channel so other workers can react.
 *      The notification is fire-and-forget; a publish failure never
 *      blocks or fails the write.
 *
 * Usage in workers:
 *   const store = new SharedStore({ redis: this.redis });
 *   const id = store.writeArtifact(agentId, 'result.json', data, { tags: ['coding'] });
 *   // → publishes { type: 'artifact_ready', artifactId: id, ... } to a2a:agents
 *
 *   const matches = store.find({ tags: ['coding'], taskId: 'task-123' });
 *
 * Configuration:
 *   SHARED_ARTIFACT_PATH env var (default: ./shared/artifacts)
 */

const fs = require('fs');
const path = require('path');
const { ArtifactStore } = require('./artifact-store');

const ARTIFACT_NOTIFY_CHANNEL = 'a2a:agents';

class SharedStore extends ArtifactStore {
  constructor(options = {}) {
    super(options);
    // Optional Redis client — enables artifact_ready notifications.
    // Set after connect() so tests can inject mocks without a live connection.
    this.redis = options.redis || null;
  }

  /**
   * Write an artifact and publish an artifact_ready notification.
   *
   * @param {string} agentId
   * @param {string} filename
   * @param {string|Buffer} content
   * @param {object} metadata    - Arbitrary; `tags`, `taskId`, `type` are queryable
   * @returns {string} artifactId
   */
  writeArtifact(agentId, filename, content, metadata = {}) {
    const artifactId = super.writeArtifact(agentId, filename, content, metadata);

    if (this.redis) {
      const notification = JSON.stringify({
        type: 'artifact_ready',
        artifactId,
        agentId,
        filename,
        tags: metadata.tags || [],
        taskId: metadata.taskId || null,
        timestamp: new Date().toISOString()
      });
      // Fire-and-forget: storage write already succeeded; notification failure is non-fatal.
      // Promise.resolve() normalises both Promise-returning and sync clients; the outer
      // try/catch guards against a client whose publish() throws synchronously.
      try {
        Promise.resolve(this.redis.publish(ARTIFACT_NOTIFY_CHANNEL, notification)).catch(() => {});
      } catch (_) {}
    }

    return artifactId;
  }

  /**
   * Find artifacts matching a query.
   *
   * Supported query fields (all optional, AND-combined):
   *   agentId  {string}   — prefix-filter via listArtifacts()
   *   tags     {string[]} — manifest.metadata.tags must include ALL listed tags
   *   taskId   {string}   — manifest.metadata.taskId must match exactly
   *   type     {string}   — manifest.metadata.type must match exactly
   *   filename {string}   — manifest.filename must match exactly
   *
   * @param {object} query
   * @returns {object[]} array of manifest objects for matching artifacts
   */
  find(query = {}) {
    const ids = this.listArtifacts(query.agentId);

    return ids.reduce((acc, id) => {
      const manifestPath = path.join(this.basePath, id, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (_) {
        return acc; // Skip unreadable manifests
      }

      if (!matchesQuery(manifest, query)) return acc;
      acc.push(manifest);
      return acc;
    }, []);
  }
}

/**
 * Returns true when a manifest satisfies all non-empty query fields.
 * @param {object} manifest
 * @param {object} query
 */
function matchesQuery(manifest, query) {
  const meta = manifest.metadata || {};

  // Exact agentId match — listArtifacts() uses a prefix filter so 'agent' would
  // otherwise also return artifacts from 'agent-1'. Re-check the manifest field.
  if (query.agentId !== undefined && manifest.agentId !== query.agentId) return false;

  if (query.tags !== undefined) {
    if (!Array.isArray(query.tags)) return false;
    if (query.tags.length > 0) {
      const manifestTags = Array.isArray(meta.tags) ? meta.tags : [];
      if (!query.tags.every(t => manifestTags.includes(t))) return false;
    }
  }

  if (query.taskId !== undefined && meta.taskId !== query.taskId) return false;
  if (query.type   !== undefined && meta.type   !== query.type)   return false;
  if (query.filename !== undefined && manifest.filename !== query.filename) return false;

  return true;
}

module.exports = { SharedStore };

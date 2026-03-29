/**
 * ArtifactStore — Shared inter-worker file exchange
 *
 * Workers write artifacts (files, data blobs) to a shared directory and
 * reference them by ID in task results. Downstream workers retrieve them
 * by artifact ID.
 *
 * Artifact lifecycle:
 *   1. write  — worker calls writeArtifact(); receives an artifactId
 *   2. reference — artifactId included in task result output
 *   3. read   — downstream worker calls readArtifact(artifactId)
 *   4. cleanup — cleanup(maxAgeMs) removes artifacts past their TTL
 *
 * Directory layout:
 *   {basePath}/
 *     {artifactId}/
 *       manifest.json   ← metadata + filename pointer
 *       {filename}      ← the actual artifact content
 *
 * Configuration:
 *   SHARED_ARTIFACT_PATH env var (default: ./shared/artifacts)
 */

const fs = require('fs');
const path = require('path');

class ArtifactStore {
  constructor(options = {}) {
    this.basePath = options.basePath ||
      process.env.SHARED_ARTIFACT_PATH ||
      path.join(process.cwd(), 'shared', 'artifacts');

    // Ensure base directory exists on construction
    fs.mkdirSync(this.basePath, { recursive: true });
  }

  /**
   * Write an artifact to the shared store.
   *
   * @param {string} agentId    - ID of the writing agent
   * @param {string} filename   - Filename to store the content under
   * @param {string|Buffer} content - File content
   * @param {object} metadata   - Arbitrary metadata stored in manifest
   * @returns {string} artifactId
   */
  writeArtifact(agentId, filename, content, metadata = {}) {
    const random = Math.random().toString(36).substr(2, 6);
    const artifactId = `${agentId}-${Date.now()}-${random}`;
    const artifactDir = path.join(this.basePath, artifactId);

    fs.mkdirSync(artifactDir, { recursive: true });

    // Write content file
    const filePath = path.join(artifactDir, filename);
    fs.writeFileSync(filePath, content);

    // Write manifest
    const manifest = {
      artifactId,
      agentId,
      filename,
      metadata,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(
      path.join(artifactDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    return artifactId;
  }

  /**
   * Read an artifact from the shared store.
   *
   * @param {string} artifactId
   * @returns {{ content: Buffer, manifest: object, filePath: string }}
   * @throws if artifactId does not exist
   */
  readArtifact(artifactId) {
    const artifactDir = path.join(this.basePath, artifactId);
    const manifestPath = path.join(artifactDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const filePath = path.join(artifactDir, manifest.filename);
    const content = fs.readFileSync(filePath);

    return { content, manifest, filePath };
  }

  /**
   * List artifact IDs, optionally filtered by agentId prefix.
   *
   * @param {string} [agentId] - If provided, only return artifacts from this agent
   * @returns {string[]} array of artifactIds
   */
  listArtifacts(agentId) {
    if (!fs.existsSync(this.basePath)) return [];

    const entries = fs.readdirSync(this.basePath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name);

    if (agentId) {
      return dirs.filter(id => id.startsWith(`${agentId}-`));
    }
    return dirs;
  }

  /**
   * Remove artifacts older than maxAgeMs.
   *
   * @param {number} maxAgeMs - Max age in milliseconds (default: 24h)
   * @returns {number} count of removed artifacts
   */
  cleanup(maxAgeMs = 86400000) {
    if (!fs.existsSync(this.basePath)) return 0;

    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const artifactId of this.listArtifacts()) {
      const manifestPath = path.join(this.basePath, artifactId, 'manifest.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (new Date(manifest.createdAt).getTime() < cutoff) {
          fs.rmSync(path.join(this.basePath, artifactId), { recursive: true, force: true });
          removed++;
        }
      } catch (_) {
        // Malformed/missing manifest — remove it
        fs.rmSync(path.join(this.basePath, artifactId), { recursive: true, force: true });
        removed++;
      }
    }

    return removed;
  }
}

module.exports = { ArtifactStore };

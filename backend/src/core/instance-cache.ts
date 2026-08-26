/**
 * INSTANCE CACHE: Fingerprinting cache isolated by instance.
 *
 * CRITICAL ISOLATION GUARANTEE:
 * - Cache from instance_001 NEVER serves data to instance_002
 * - Each instance has separate cache storage
 * - Cache keys include instanceId to prevent collision
 * - No cross-instance cache hits possible
 */

export interface CacheEntry {
  fingerprint: string;
  result: any;
  timestamp: number;
}

export class InstanceCacheService {
  // Cache partitioned by instance: instanceId -> (cacheKey -> CacheEntry)
  private cache = new Map<string, Map<string, CacheEntry>>();

  /**
   * Generate instance-specific cache key
   * ISOLATION: Key includes instanceId to prevent collision
   *
   * Example:
   *   instance_001::control_100
   *   instance_002::control_100
   *   These are DIFFERENT cache keys - no collision
   */
  private buildCacheKey(instanceId: string, resourceId: string): string {
    return `${instanceId}::${resourceId}`;
  }

  /**
   * Get cached entry for specific instance
   * ISOLATION: Only returns cache from this instance
   */
  get(instanceId: string, resourceId: string): CacheEntry | undefined {
    if (!this.cache.has(instanceId)) {
      return undefined;
    }

    const cacheKey = this.buildCacheKey(instanceId, resourceId);
    return this.cache.get(instanceId)!.get(resourceId);
  }

  /**
   * Get cached entry and verify fingerprint matches
   * ISOLATION: Fingerprint validation is instance-specific
   *
   * Returns null if:
   * - No cache entry exists for this instance
   * - Fingerprint doesn't match (data changed)
   */
  getIfFingerprintMatches(
    instanceId: string,
    resourceId: string,
    currentFingerprint: string
  ): CacheEntry | null {
    const entry = this.get(instanceId, resourceId);

    if (!entry) {
      return null;
    }

    // ✅ ISOLATION: Compare fingerprints to ensure data hasn't changed
    // If fingerprint matches, we can safely use cached result
    if (entry.fingerprint === currentFingerprint) {
      return entry;
    }

    // Fingerprint mismatch = data changed = invalidate cache
    this.invalidate(instanceId, resourceId);
    return null;
  }

  /**
   * Store entry in cache for specific instance
   * ISOLATION: Entry only stored in this instance's cache
   */
  set(instanceId: string, resourceId: string, entry: CacheEntry): void {
    if (!this.cache.has(instanceId)) {
      this.cache.set(instanceId, new Map());
    }

    this.cache.get(instanceId)!.set(resourceId, {
      ...entry,
      timestamp: Date.now() // Always update timestamp
    });
  }

  /**
   * Invalidate specific cache entry for instance
   * ISOLATION: Only removes from this instance's cache
   */
  invalidate(instanceId: string, resourceId: string): void {
    const instanceCache = this.cache.get(instanceId);
    if (instanceCache) {
      instanceCache.delete(resourceId);
    }
  }

  /**
   * Clear ALL cache for specific instance
   * ISOLATION: Never affects other instances
   *
   * Used when:
   * - Testing/debugging
   * - Instance is being cleared for re-onboarding
   * - Manual cache reset requested
   */
  clearInstance(instanceId: string): number {
    const instanceCache = this.cache.get(instanceId);
    const count = instanceCache ? instanceCache.size : 0;

    this.cache.delete(instanceId);

    return count;
  }

  /**
   * Get cache statistics for specific instance
   * ISOLATION: Stats are per-instance only
   */
  getStatsForInstance(instanceId: string): {
    instanceId: string;
    size: number;
    keys: string[];
    oldestEntry?: number;
    newestEntry?: number;
  } {
    const instanceCache = this.cache.get(instanceId);

    if (!instanceCache || instanceCache.size === 0) {
      return {
        instanceId,
        size: 0,
        keys: []
      };
    }

    const entries = Array.from(instanceCache.values());
    const timestamps = entries.map(e => e.timestamp).sort((a, b) => a - b);

    return {
      instanceId,
      size: instanceCache.size,
      keys: Array.from(instanceCache.keys()),
      oldestEntry: timestamps[0],
      newestEntry: timestamps[timestamps.length - 1]
    };
  }

  /**
   * Get cache statistics for ALL instances
   * Admin-only endpoint: Shows cache state per instance
   * ISOLATION: Returns separate stats for each instance
   */
  getAllStats(): Map<string, ReturnType<typeof this.getStatsForInstance>> {
    const result = new Map();

    for (const instanceId of this.cache.keys()) {
      result.set(instanceId, this.getStatsForInstance(instanceId));
    }

    return result;
  }

  /**
   * Prune old cache entries for specific instance
   * ISOLATION: Only removes entries older than maxAgeMs from this instance
   *
   * Used for memory management on long-running servers
   */
  pruneOldEntries(instanceId: string, maxAgeMs: number = 3600000): number {
    const instanceCache = this.cache.get(instanceId);
    if (!instanceCache) return 0;

    const now = Date.now();
    let prunedCount = 0;

    for (const [key, entry] of instanceCache.entries()) {
      if (now - entry.timestamp > maxAgeMs) {
        instanceCache.delete(key);
        prunedCount++;
      }
    }

    return prunedCount;
  }

  /**
   * Validate that instance exists in cache tracking
   * Used to verify instance is being tracked
   */
  hasInstance(instanceId: string): boolean {
    return this.cache.has(instanceId);
  }

  /**
   * Get total cache size across all instances
   * Admin metric: Track memory usage
   */
  getTotalSize(): number {
    let total = 0;
    for (const instanceCache of this.cache.values()) {
      total += instanceCache.size;
    }
    return total;
  }
}

// Global singleton
export const cacheService = new InstanceCacheService();

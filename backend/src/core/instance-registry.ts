/**
 * INSTANCE REGISTRY: Manages completely isolated adapter instances.
 *
 * CRITICAL ISOLATION GUARANTEE:
 * - Each instance has its own adapter with unique credentials
 * - No shared state, no cross-instance data leakage
 * - Strict validation: accessing wrong instance throws error
 */

import { ServiceNowAdapter } from '../adapters/servicenow';

interface InstanceConfig {
  instanceId: string;
  url: string;
  key: string;
  isValid: boolean;
  error?: string;
}

export class ServiceNowInstanceRegistry {
  private adapters = new Map<string, ServiceNowAdapter>();
  private configs = new Map<string, InstanceConfig>();
  private defaultInstanceId = 'default';

  constructor() {
    try {
      this.loadInstanceConfigs();
    } catch (error: any) {
      console.error(`[InstanceRegistry] FATAL: Constructor failed: ${error.message}`);
      console.error(error.stack);
    }
  }

  /**
   * Load all instance configurations from environment variables
   * Validates credentials exist for each instance
   */
  private loadInstanceConfigs(): void {
    try {
      const instancesEnv = process.env.SERVICENOW_INSTANCES;
      console.log(`[REGISTRY-INIT] SERVICENOW_INSTANCES=${instancesEnv || '(not set)'}`);

      // Parse configured instances (e.g., "instance_001,instance_002")
      const instanceIds = instancesEnv
        ? instancesEnv.split(',').map(id => id.trim()).filter(id => id)
        : [this.defaultInstanceId];

      console.log(`[REGISTRY-INIT] Parsed instance IDs: ${JSON.stringify(instanceIds)}`);

      for (const instanceId of instanceIds) {
        try {
          const config = this.getInstanceConfig(instanceId, true);  // true = log loud diagnostic
          this.configs.set(instanceId, config);

          if (config.isValid) {
            console.log(`[InstanceRegistry] ✅ Loaded instance: ${instanceId}`);
          } else {
            console.warn(`[InstanceRegistry] ⚠️  Instance ${instanceId}: ${config.error}`);
          }
        } catch (e: any) {
          console.error(`[InstanceRegistry] Error loading instance ${instanceId}: ${e.message}`);
        }
      }

      // Also check for legacy single-instance setup (backward compat)
      if (!instancesEnv && process.env.SERVICENOW_INSTANCE_URL) {
        try {
          const legacyConfig = this.getInstanceConfig(this.defaultInstanceId, true);
          if (legacyConfig.isValid) {
            this.configs.set(this.defaultInstanceId, legacyConfig);
            console.log(`[InstanceRegistry] ✅ Loaded legacy instance (default)`);
          }
        } catch (e: any) {
          console.error(`[InstanceRegistry] Error loading legacy instance: ${e.message}`);
        }
      }

      console.log(`[InstanceRegistry] Initialization complete. Loaded ${this.configs.size} instance(s). VALID=${this.getValidInstances().length} INVALID=${this.getAllInstancesWithStatus().filter(i=>!i.isValid).length}`);
    } catch (error: any) {
      console.error(`[InstanceRegistry] FATAL ERROR during initialization: ${error.message}`);
      console.error(error.stack);
    }
  }

  /**
   * Get configuration for a specific instance
   * Reads from environment variables with strict naming convention
   *
   * Supports two formats:
   * 1. API Key: SERVICENOW_INSTANCE_<ID>_KEY
   * 2. Username/Password: SERVICENOW_INSTANCE_<ID>_USERNAME + _PASSWORD
   *
   * When loudDiagnostic=true, prints a per-instance diagnostic block showing
   * EXACTLY which env vars were checked and whether each was FOUND or MISSING.
   * This eliminates silent configuration failures in Vercel serverless cold
   * starts (where env vars may be present in the dashboard but not loaded
   * in a particular function process).
   */
  private getInstanceConfig(instanceId: string, loudDiagnostic = false): InstanceConfig {
    let url: string;
    let key: string;
    // Diagnostic info (only used if loudDiagnostic = true)
    const diag: {
      instanceId: string;
      mode: 'default' | 'multi';
      urlVar: string;
      urlSet: boolean;
      keyVar?: string;
      keySet: boolean;
      userVar?: string;
      userSet: boolean;
      passVar?: string;
      passSet: boolean;
    } = {
      instanceId,
      mode: instanceId === this.defaultInstanceId ? 'default' : 'multi',
      urlVar: '',
      urlSet: false,
      keySet: false,
      userSet: false,
      passSet: false
    };

    if (instanceId === this.defaultInstanceId) {
      diag.urlVar = 'SERVICENOW_INSTANCE_URL';
      diag.keyVar = 'SERVICENOW_INSTANCE_KEY';
      diag.userVar = 'SERVICENOW_INSTANCE_USERNAME';
      diag.passVar = 'SERVICENOW_INSTANCE_PASSWORD';

      // Backward compatibility: use SERVICENOW_INSTANCE_URL and SERVICENOW_INSTANCE_KEY
      url = process.env.SERVICENOW_INSTANCE_URL || '';
      diag.urlSet = !!url;

      // Try API key first, then fallback to username/password
      key = process.env.SERVICENOW_INSTANCE_KEY || '';
      diag.keySet = !!key;
      if (!key) {
        const username = process.env.SERVICENOW_INSTANCE_USERNAME || '';
        const password = process.env.SERVICENOW_INSTANCE_PASSWORD || '';
        diag.userSet = !!username;
        diag.passSet = !!password;
        if (username && password) {
          key = `${username}:${password}`;
        }
      }
    } else {
      // New format: SERVICENOW_INSTANCE_<number>_URL (e.g., "instance_002" -> extract "002")
      const envSuffix = instanceId.replace(/^instance_/i, '').toUpperCase();
      diag.urlVar  = `SERVICENOW_INSTANCE_${envSuffix}_URL`;
      diag.keyVar  = `SERVICENOW_INSTANCE_${envSuffix}_KEY`;
      diag.userVar = `SERVICENOW_INSTANCE_${envSuffix}_USERNAME`;
      diag.passVar = `SERVICENOW_INSTANCE_${envSuffix}_PASSWORD`;

      url = process.env[diag.urlVar] || '';
      diag.urlSet = !!url;

      // Try API key first, then fallback to username/password
      key = process.env[diag.keyVar] || '';
      diag.keySet = !!key;
      if (!key) {
        const username = process.env[diag.userVar] || '';
        const password = process.env[diag.passVar] || '';
        diag.userSet = !!username;
        diag.passSet = !!password;
        if (username && password) {
          key = `${username}:${password}`;
        }
      }
    }

    const isValid = !!(url && key);

    if (loudDiagnostic) {
      const envFn = (name: string, set: boolean) => `${set ? '✅ FOUND' : '❌ MISSING'} ${name}`;
      const lines = [
        '',
        '═══════════════════════════════════════════════════════════════',
        `[InstanceRegistry-DIAG] Instance: ${instanceId}   Mode: ${diag.mode}`,
        '───────────────────────────────────────────────────────────────',
        `  URL:      ${envFn(diag.urlVar, diag.urlSet)}`,
        `  API KEY:  ${envFn(diag.keyVar || 'N/A', diag.keySet)}`,
        `  USERNAME: ${envFn(diag.userVar || 'N/A', diag.userSet)}`,
        `  PASSWORD: ${envFn(diag.passVar || 'N/A', diag.passSet)}`,
        '───────────────────────────────────────────────────────────────',
        `  Result: ${isValid ? '✅ VALID' : '❌ INVALID — ' + (!diag.urlSet ? 'URL missing. ' : '') + (!diag.keySet && !(diag.userSet && diag.passSet) ? 'Neither API KEY nor USERNAME+PASSWORD pair is fully set.' : '')}`,
        '═══════════════════════════════════════════════════════════════',
        ''
      ];
      if (isValid) {
        lines.forEach(l => console.log(l));
      } else {
        lines.forEach(l => console.error(l));
      }
    }

    return {
      instanceId,
      url,
      key,
      isValid,
      error: !isValid ? `Missing URL or credentials for instance '${instanceId}'. Checked env vars: URL='${diag.urlVar}' (${diag.urlSet ? 'SET' : 'NOT SET'}), KEY='${diag.keyVar}' (${diag.keySet ? 'SET' : 'NOT SET'}), USERNAME='${diag.userVar}' (${diag.userSet ? 'SET' : 'NOT SET'}), PASSWORD='${diag.passVar}' (${diag.passSet ? 'SET' : 'NOT SET'}).` : undefined
    };
  }

  /**
   * Get adapter for instance with STRICT validation
   * Throws error if instance doesn't exist or credentials missing
   *
   * ISOLATION: Each call returns unique adapter with instance-specific credentials
   */
  getAdapter(instanceId: string): ServiceNowAdapter {
    // ✅ VALIDATION: Verify instance exists
    const config = this.configs.get(instanceId);
    if (!config) {
      throw new Error(
        `[ISOLATION VIOLATION] Instance '${instanceId}' not found in registry. ` +
        `Available instances: ${Array.from(this.configs.keys()).join(', ')}`
      );
    }

    // ✅ VALIDATION: Verify credentials are configured
    if (!config.isValid) {
      throw new Error(
        `[ISOLATION VIOLATION] Instance '${instanceId}' has invalid configuration: ${config.error}`
      );
    }

    // ✅ REUSE: Return existing adapter if already created (same instance)
    if (!this.adapters.has(instanceId)) {
      this.adapters.set(instanceId, new ServiceNowAdapter(instanceId, config.url, config.key));
      console.log(`[InstanceRegistry] Created new adapter for instance '${instanceId}'`);
    }

    return this.adapters.get(instanceId)!;
  }

  /**
   * Validate that an instanceId is valid and accessible
   * Used by middleware to reject invalid requests early
   */
  isValidInstance(instanceId: string): boolean {
    const config = this.configs.get(instanceId);
    return !!(config && config.isValid);
  }

  /**
   * Get list of all valid instances
   * Used for debugging and API metadata metadata
   */
  getValidInstances(): string[] {
    return Array.from(this.configs.values())
      .filter(c => c.isValid)
      .map(c => c.instanceId);
  }

  /**
   * Get ALL instances — including INVALID ones — with their validation status
   * and human-readable error. This powers GET /api/instances so misconfigured
   * instances show up with a red X and a clear error message instead of being
   * silently hidden from the frontend dropdown.
   */
  getAllInstancesWithStatus(): Array<{ instanceId: string; isValid: boolean; error?: string }> {
    return Array.from(this.configs.values()).map(c => ({
      instanceId: c.instanceId,
      isValid:    c.isValid,
      error:      c.error
    }));
  }

  /**
   * Get instance configuration (for metadata/debugging only)
   * NEVER exposes actual API keys
   */
  getInstanceMetadata(instanceId: string): {
    instanceId: string;
    isConfigured: boolean;
    hasUrl: boolean;
    hasKey: boolean;
  } | null {
    const config = this.configs.get(instanceId);
    if (!config) return null;

    return {
      instanceId,
      isConfigured: config.isValid,
      hasUrl: !!config.url,
      hasKey: !!config.key
    };
  }

  /**
   * Clear adapter cache (for testing only)
   * In production, adapters persist for connection pooling
   */
  clearAdapter(instanceId: string): void {
    this.adapters.delete(instanceId);
    console.log(`[InstanceRegistry] Cleared adapter for instance '${instanceId}'`);
  }
}

// Global singleton instance
export const instanceRegistry = new ServiceNowInstanceRegistry();

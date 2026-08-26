import { GeneratedAdapterConfig, FieldMetadata, PlatformTerminology } from './generated_adapter_config';

/**
 * Utility functions for handling field metadata and smart text formatting
 * Agents use these to:
 * - Truncate text smartly (word-boundary, not mid-word)
 * - Apply platform-specific terminology (entity → business unit)
 * - Format output based on field type/limits
 */

export class FieldMetadataUtils {
  constructor(private config: GeneratedAdapterConfig) {}

  /**
   * Get metadata for a specific field
   */
  getFieldMetadata(tableName: string, fieldName: string): FieldMetadata | undefined {
    return this.config.fieldMetadata?.find(
      fm => fm.sourceTableName === tableName && fm.sourceFieldName === fieldName
    );
  }

  /**
   * Smart truncate: respects word boundaries and char limits
   * If text exceeds max chars, truncates at last word boundary before limit
   */
  smartTruncate(text: string, maxChars?: number, strategy: string = 'word-boundary'): string {
    if (!maxChars || text.length <= maxChars) {
      return text;
    }

    if (strategy === 'char-limit') {
      // Hard char limit, no word boundary respect
      return text.substring(0, maxChars);
    }

    if (strategy === 'word-boundary') {
      // Find last space before maxChars and truncate there
      const truncated = text.substring(0, maxChars);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 0 ? text.substring(0, lastSpace) : truncated;
    }

    return text;
  }

  /**
   * Apply platform terminology: entity → business unit, etc.
   */
  applyTerminology(text: string): string {
    if (!this.config.terminology || !text) {
      return text;
    }

    let result = text;
    for (const [genericTerm, platformTerm] of Object.entries(this.config.terminology)) {
      // Case-insensitive replacement, preserving original case
      const regex = new RegExp(`\\b${genericTerm}\\b`, 'gi');
      result = result.replace(regex, (match) => {
        // Preserve case: if original was capitalized, capitalize replacement
        return match[0] === match[0].toUpperCase() ? platformTerm.charAt(0).toUpperCase() + platformTerm.slice(1) : platformTerm;
      });
    }
    return result;
  }

  /**
   * Format text for a field: truncate + apply terminology
   */
  formatForField(text: string, tableName: string, fieldName: string): string {
    const metadata = this.getFieldMetadata(tableName, fieldName);
    let result = text;

    // Apply terminology first (before truncating, so we don't cut off replacements weirdly)
    result = this.applyTerminology(result);

    // Then truncate if needed
    if (metadata?.maxCharacters) {
      result = this.smartTruncate(result, metadata.maxCharacters, metadata.truncationStrategy);
    }

    return result;
  }

  /**
   * Get all fields for a concept (e.g., "control-effectiveness" → [design, performance])
   * Used to know which fields to populate together
   */
  getFieldsForConcept(concept: string): Array<{
    tableName: string;
    fieldName: string;
    role: string;
  }> {
    const relationship = this.config.fieldRelationships?.find(r => r.concept === concept);
    if (!relationship) return [];

    return relationship.fields.map(f => ({
      tableName: f.sourceTableName,
      fieldName: f.sourceFieldName,
      role: f.roleName
    }));
  }

  /**
   * Check if a concept has multiple related fields that should be populated together
   */
  hasMultipleFields(concept: string): boolean {
    return this.getFieldsForConcept(concept).length > 1;
  }
}

/**
 * Factory function: create utils from adapter config
 */
export function createFieldMetadataUtils(config: GeneratedAdapterConfig | null): FieldMetadataUtils | null {
  if (!config) return null;
  return new FieldMetadataUtils(config);
}

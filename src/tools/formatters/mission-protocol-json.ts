/**
 * Mission Protocol JSON Formatter
 *
 * Transforms rich Mission Protocol mission objects into a standardized JSON
 * envelope format for database ingestion and API consumption.
 *
 * Key principles:
 * - Loose coupling: No consumer-specific validation (CMOS, TraceLab, etc.)
 * - Clean contract: Versioned envelope with clear field boundaries
 * - Optional fields: Only included when provided (no null pollution)
 * - Preservation: All MP intelligence lives in domain_fields
 *
 * @module tools/formatters/mission-protocol-json
 * @version 1.0.0
 */

import type { GenericMission } from '../../schemas/generic-mission';

/**
 * Parameters for JSON formatting
 */
export interface JsonFormatterParams {
  /** Optional mission ID - will be used as suggested_id */
  missionId?: string;

  /** Optional sprint ID - included in output if provided */
  sprintId?: string;

  /** Optional context description - included in output if provided */
  context?: string;

  /** Optional domain name - included in output if provided */
  domain?: string;
}

/**
 * Mission Protocol JSON envelope structure
 *
 * This is the contract that consumers (CMOS, etc.) can rely on.
 */
export interface MissionProtocolJsonOutput {
  /** Format version for future evolution */
  format_version: string;

  /** Source identifier */
  source: string;

  /** Mission data */
  mission: {
    /** MP's suggested ID - consumer can use or override */
    suggested_id: string;

    /** Concise mission name (extracted from objective) */
    name: string;

    /** Clear mission objective */
    objective: string;

    /** Optional sprint ID */
    sprint_id?: string;

    /** Optional context description */
    context?: string;

    /** Optional domain identifier */
    domain?: string;

    /** All Mission Protocol intelligence and domain-specific data */
    domain_fields: Record<string, any>;
  };
}

/**
 * Mission Protocol JSON Formatter
 *
 * Transforms Mission Protocol mission objects into JSON envelope format.
 * Pure formatting logic - no validation of consumer-specific patterns.
 */
export class MissionProtocolJsonFormatter {
  private static readonly FORMAT_VERSION = '1.0';
  private static readonly SOURCE = 'mission-protocol';
  private static readonly MAX_NAME_LENGTH = 80;

  /**
   * Format a mission into JSON envelope
   *
   * @param mission - GenericMission object from Mission Protocol
   * @param params - Optional parameters (IDs, sprint, context)
   * @returns JSON envelope ready for consumption
   */
  format(mission: GenericMission, params: JsonFormatterParams = {}): MissionProtocolJsonOutput {
    // Build domain_fields from all MP intelligence
    const domainFields = this.buildDomainFields(mission);

    // Build the output object, only including optional fields if provided
    const output: MissionProtocolJsonOutput = {
      format_version: MissionProtocolJsonFormatter.FORMAT_VERSION,
      source: MissionProtocolJsonFormatter.SOURCE,
      mission: {
        suggested_id: this.generateSuggestedId(params.missionId),
        name: this.extractName(mission),
        objective: mission.objective,
        domain_fields: domainFields,
      },
    };

    // Only include optional fields if they were provided
    if (params.sprintId) {
      output.mission.sprint_id = params.sprintId;
    }

    if (params.context) {
      output.mission.context = params.context;
    }

    if (params.domain) {
      output.mission.domain = params.domain;
    }

    return output;
  }

  /**
   * Generate a suggested mission ID
   *
   * Format: MP-YYYY-MM-DD-XXXX
   * - If ID provided in params, use it
   * - Otherwise, generate timestamp-based ID
   *
   * @param providedId - Optional ID from params
   * @returns Suggested mission ID
   */
  private generateSuggestedId(providedId?: string): string {
    if (providedId) {
      return providedId;
    }

    // Generate timestamp-based ID: MP-YYYY-MM-DD-XXXX
    const now = new Date();
    const datePart = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timestamp = Date.now().toString();
    const timestampSuffix = timestamp.slice(-4); // Last 4 digits

    return `MP-${datePart}-${timestampSuffix}`;
  }

  /**
   * Extract concise name from mission objective
   *
   * Strategy:
   * 1. Take first sentence (split on . ! ?)
   * 2. Trim whitespace
   * 3. Truncate to MAX_NAME_LENGTH characters
   *
   * @param mission - GenericMission object
   * @returns Concise mission name
   */
  private extractName(mission: GenericMission): string {
    const objective = mission.objective || '';

    // Find first sentence (split on sentence terminators)
    const sentences = objective.split(/[.!?]/);
    let name = sentences[0]?.trim() || objective.trim();

    // Truncate if too long
    if (name.length > MissionProtocolJsonFormatter.MAX_NAME_LENGTH) {
      name = name.slice(0, MissionProtocolJsonFormatter.MAX_NAME_LENGTH).trim();
    }

    // Fallback if somehow still empty
    if (!name) {
      name = 'Untitled Mission';
    }

    return name;
  }

  /**
   * Build domain_fields object from mission data
   *
   * Includes all Mission Protocol intelligence:
   * - successCriteria, deliverables
   * - context (background, dependencies, constraints)
   * - Schema metadata (schemaType, schemaVersion, missionId)
   * - Domain-specific fields if present
   *
   * @param mission - GenericMission object
   * @returns domain_fields object
   */
  private buildDomainFields(mission: GenericMission): Record<string, any> {
    const domainFields: Record<string, any> = {
      // Schema metadata
      schemaType: mission.schemaType,
      schemaVersion: mission.schemaVersion,
      missionId: mission.missionId,

      // Core MP intelligence (always include)
      successCriteria: mission.successCriteria || [],
      deliverables: mission.deliverables || [],

      // Context object with nested fields
      context: mission.context || {},
    };

    // Add any domain-specific fields
    if (mission.domainFields && Object.keys(mission.domainFields).length > 0) {
      Object.assign(domainFields, mission.domainFields);
    }

    return domainFields;
  }
}

/**
 * Convenience function to format a mission to JSON string
 *
 * @param mission - GenericMission object
 * @param params - Optional formatting parameters
 * @param pretty - Whether to pretty-print the JSON (default: true)
 * @returns JSON string
 */
export function formatMissionToJson(
  mission: GenericMission,
  params: JsonFormatterParams = {},
  pretty: boolean = true
): string {
  const formatter = new MissionProtocolJsonFormatter();
  const output = formatter.format(mission, params);
  return JSON.stringify(output, null, pretty ? 2 : 0);
}

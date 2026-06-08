/**
 * Tool Type Definitions
 *
 * Defines data structures for MCP tools and their outputs.
 *
 * @module types/tools
 */

/**
 * Domain Information
 * Simplified view of a domain pack for tool output
 */
export interface DomainInfo {
  /** Unique name of the domain pack */
  name: string;

  /** Description of the domain pack's purpose */
  description: string;

  /** SemVer version (X.Y.Z format) */
  version: string;

  /** Optional author information */
  author?: string;
}

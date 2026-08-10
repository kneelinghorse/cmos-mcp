// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m06 shared TOOL_REFERENCE.md renderer — the ONE function imported by
// BOTH the build hook (fed dist defs) and the freshness test (fed src defs) so the
// generated file and the gate can never disagree on formatting (no false drift).

'use strict';

/** Render the JSON-schema type of a property into a table cell. */
function renderType(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (prop.type) return Array.isArray(prop.type) ? prop.type.join(' | ') : String(prop.type);
  if (Array.isArray(prop.enum)) return 'string';
  return 'object';
}

/**
 * The markdown table-cell escaper: collapses whitespace/newlines and escapes pipes so the
 * text cannot split its row into extra columns. Safe only for single-line cell content —
 * every value interpolated into a table row must pass through here, including `renderType`'s
 * output (a JSON-Schema type union renders as `string | object`, whose bare pipe would
 * otherwise add a column; s85-m01).
 */
function cell(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Render the parameter table for one tool from its inputSchema. */
function renderParamsTable(inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set((inputSchema && inputSchema.required) || []);
  const names = Object.keys(props);
  if (names.length === 0) {
    return '_No parameters._';
  }
  const rows = ['| Parameter | Type | Required | Description |', '| --- | --- | --- | --- |'];
  for (const name of names) {
    const prop = props[name] || {};
    rows.push(
      `| \`${name}\` | ${cell(renderType(prop))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(prop.description)} |`
    );
  }
  return rows.join('\n');
}

/** Render one tool: heading, verbatim description, action enum (if any), params table. */
function renderTool(tool) {
  const lines = [`## ${tool.name}`, '', cell(tool.description), ''];
  const actionProp =
    tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.action;
  if (actionProp && Array.isArray(actionProp.enum)) {
    lines.push(`**Actions:** ${actionProp.enum.map((a) => `\`${a}\``).join(', ')}`, '');
  }
  lines.push(renderParamsTable(tool.inputSchema));
  return lines.join('\n');
}

/**
 * Render the full TOOL_REFERENCE.md from a list of MCP tool definitions
 * (`{ name, description, inputSchema }`). Deterministic — same input, same bytes.
 */
function renderToolReference(toolDefinitions) {
  const header = [
    '<!-- GENERATED FILE — do not edit by hand. -->',
    '<!-- Regenerated from CMOS_TOOL_DEFINITIONS by scripts/generate-tool-reference.js on every `npm run build`. -->',
    '<!-- tests/tools/tool-reference-freshness.test.ts fails the build if this drifts from the tool definitions. -->',
    '',
    '# CMOS MCP Tool Reference',
    '',
    `The CMOS MCP server exposes ${toolDefinitions.length} tools. Most select an operation with an ` +
      '`action` parameter; `cmos_agent_onboard`, `cmos_status`, and `cmos_review` take only `projectRoot`.',
    '',
  ].join('\n');

  const body = toolDefinitions.map(renderTool).join('\n\n');
  return `${header}\n${body}\n`;
}

module.exports = { renderToolReference };

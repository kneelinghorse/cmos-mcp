// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m06 shared TOOL_REFERENCE.md renderer — the ONE function imported by
// BOTH the build hook (fed dist defs) and the freshness test (fed src defs) so the
// generated file and the gate can never disagree on formatting (no false drift).

/**
 * s86-m04 rewrote two things here.
 *
 * PER-ACTION TABLES. An action-bearing tool now renders one parameter table per action, driven by
 * CMOS_ACTION_PARAMS (src/tools/cmos/action-params.ts). The flat table it replaces was a false
 * claim by omission: it offered `evergreen` as an unconditional `cmos_learnings` parameter when
 * only two of four actions do anything with it, and as an unconditional `cmos_context` parameter
 * when only `constraints` does. Nothing in the old output let a reader tell the difference between
 * a parameter that applies and one that is silently ignored.
 *
 * A DERIVED HEADER. The old header asserted that `cmos_agent_onboard`, `cmos_status` and
 * `cmos_review` "take only `projectRoot`" — three lines above the table listing
 * `cmos_agent_onboard`'s `agentFeedback`. The authoritative public reference contradicted itself on
 * the same page. The fix is not a better sentence: the header now states only what is DERIVABLE
 * from the definitions (how many tools, how many take an action, which take none) and makes no
 * claim about any tool's parameter set.
 *
 * FAIL LOUD, NEVER FALL BACK. A tool that publishes an action enum but has no map — or an action
 * with no list — throws. A renderer that quietly reverted to the flat table would reintroduce the
 * exact defect above at the moment someone adds an action and forgets its entry.
 */

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

/**
 * The sub-shape a property publishes, if any — RF-05, closed as DOTTED ROWS rather than
 * sub-tables (one grid keeps tests/tools/tool-reference-render.test.ts's column-count invariant
 * applying unchanged, and a dotted row is a greppable identifier).
 *
 * DERIVED, not listed: an object with `properties`, or an array whose `items` has them. A nested
 * param that publishes NO sub-shape (`cmos_mission.domainFields`) renders as a single row —
 * authoring the missing sub-shape is schema design, not rendering.
 */
function subShapeOf(prop) {
  if (!prop || typeof prop !== 'object') return null;
  if (prop.properties) return { properties: prop.properties, required: prop.required, sep: '.' };
  if (prop.items && prop.items.properties) {
    return { properties: prop.items.properties, required: prop.items.required, sep: '[].' };
  }
  return null;
}

/** One parameter row, plus a dotted row per published sub-shape key. */
function renderParamRows(name, prop, required) {
  const rows = [
    `| \`${name}\` | ${cell(renderType(prop))} | ${required ? 'yes' : 'no'} | ${cell(prop.description)} |`,
  ];
  const sub = subShapeOf(prop);
  if (!sub) return rows;
  const subRequired = new Set(sub.required || []);
  for (const key of Object.keys(sub.properties)) {
    const child = sub.properties[key] || {};
    rows.push(
      `| \`${name}${sub.sep}${key}\` | ${cell(renderType(child))} | ${subRequired.has(key) ? 'yes' : 'no'} | ${cell(child.description)} |`
    );
  }
  return rows;
}

const TABLE_HEAD = ['| Parameter | Type | Required | Description |', '| --- | --- | --- | --- |'];

/** Render a table over an explicit, ordered list of parameter names. */
function renderParamsTable(inputSchema, names) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set((inputSchema && inputSchema.required) || []);
  if (names.length === 0) {
    return '_No parameters._';
  }
  const rows = [...TABLE_HEAD];
  for (const name of names) {
    rows.push(...renderParamRows(name, props[name] || {}, required.has(name)));
  }
  return rows.join('\n');
}

/** The partition rule, stated once: a tool is action-bearing IFF it publishes an action enum. */
function actionEnumOf(tool) {
  const prop =
    tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.action;
  return prop && Array.isArray(prop.enum) ? prop.enum : null;
}

/** Render one tool: heading, verbatim description, action enum (if any), parameter table(s). */
function renderTool(tool, actionParams) {
  const lines = [`## ${tool.name}`, '', cell(tool.description), ''];
  const actions = actionEnumOf(tool);
  if (!actions) {
    lines.push(renderParamsTable(tool.inputSchema, Object.keys(tool.inputSchema.properties || {})));
    return lines.join('\n');
  }

  const map = actionParams && actionParams[tool.name];
  if (!map) {
    throw new Error(
      `[tool-reference] ${tool.name} publishes an action enum but has no ACTION_PARAMS entry. ` +
        'Add one in its tool module and register it in src/tools/cmos/action-params.ts.'
    );
  }

  lines.push(`**Actions:** ${actions.map((a) => `\`${a}\``).join(', ')}`, '');
  for (const action of actions) {
    const names = map[action];
    if (!Array.isArray(names)) {
      throw new Error(
        `[tool-reference] ${tool.name}(action="${action}") has no ACTION_PARAMS list. ` +
          'Every member of the action enum needs one.'
      );
    }
    lines.push(`### ${tool.name}(action="${action}")`, '');
    lines.push(renderParamsTable(tool.inputSchema, names));
    lines.push('');
  }
  lines.pop();
  return lines.join('\n');
}

/**
 * The header sentence, DERIVED. It states the partition and nothing else — no claim about any
 * tool's parameter set, which is the claim the previous hand-written sentence got wrong.
 */
function renderHeaderSentence(toolDefinitions) {
  const actionLess = toolDefinitions.filter((t) => !actionEnumOf(t)).map((t) => `\`${t.name}\``);
  const withAction = toolDefinitions.length - actionLess.length;
  const listed =
    actionLess.length === 0
      ? ''
      : actionLess.length === 1
        ? actionLess[0]
        : `${actionLess.slice(0, -1).join(', ')} and ${actionLess[actionLess.length - 1]}`;
  const tail =
    actionLess.length === 0
      ? '.'
      : `; the remaining ${actionLess.length} (${listed}) take no \`action\`.`;
  return (
    `The CMOS MCP server exposes ${toolDefinitions.length} tools. ` +
    `${withAction} select an operation with an \`action\` parameter and publish one parameter ` +
    `table per action${tail}\n\n` +
    // WITHOUT THIS, THE PER-ACTION FORMAT ITSELF BECOMES A FALSE CLAIM. One table per action reads
    // as the complete contract FOR that action, so a reader takes "Required: no" as "optional on
    // this action" — but JSON Schema `required` is declared per SHAPE, and no shape states a
    // per-action requirement. Publishing per-action requiredness would mean authoring schema data
    // with no source; saying what the column actually means costs one sentence. It names the
    // sub-shape case too, because a dotted row's requirement comes from its own `items`/`properties`
    // block (`fieldUpdates[].path` reads yes) rather than from the tool.
    'The **Required** column reports the JSON Schema requirement of the shape the row belongs ' +
    'to — the tool for a top-level parameter, the sub-shape for a dotted row. Neither is ' +
    'per-action: no shape states a per-action requirement, so a parameter an action cannot work ' +
    'without may still read "no" here, and the handler is what enforces it.'
  );
}

/**
 * Render the full TOOL_REFERENCE.md from a list of MCP tool definitions
 * (`{ name, description, inputSchema }`) and the per-action parameter map keyed by tool name
 * (`CMOS_ACTION_PARAMS`). Deterministic — same input, same bytes.
 */
function renderToolReference(toolDefinitions, actionParams) {
  const header = [
    '<!-- GENERATED FILE — do not edit by hand. -->',
    '<!-- Regenerated from CMOS_TOOL_DEFINITIONS by scripts/generate-tool-reference.js on every `npm run build`. -->',
    '<!-- tests/tools/tool-reference-freshness.test.ts fails the build if this drifts from the tool definitions. -->',
    '',
    '# CMOS MCP Tool Reference',
    '',
    renderHeaderSentence(toolDefinitions),
    '',
  ].join('\n');

  const body = toolDefinitions.map((tool) => renderTool(tool, actionParams)).join('\n\n');
  return `${header}\n${body}\n`;
}

module.exports = { renderToolReference };

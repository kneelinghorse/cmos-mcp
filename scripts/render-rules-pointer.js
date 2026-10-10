// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Render the current source rules pointer without compiling or loading the real dist tree.
// ABOUTME: The preservation ledger pins the renderer source hash and compares this exact output.
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

// Match the in-memory source loader used by the measurement scripts. This process exits after
// rendering one pointer, and rules-files.ts imports only Node's fs/path modules.
require.extensions['.ts'] = (mod, file) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  mod._compile(outputText, file);
};
const rules = require(path.resolve(__dirname, '../src/tools/cmos/rules-files.ts'));
const level = rules.levelOfTier(JSON.parse(process.argv[2]));
process.stdout.write(JSON.stringify({ level, text: rules.cmosRulesLine(level) }));

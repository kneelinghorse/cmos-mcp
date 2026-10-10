# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Verify line-exact protection, independently classified legacy files and rules-only gates.
# ABOUTME: Mutation controls must reject lost, changed, duplicated or reordered protected bytes.
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('rules_preservation', REPO / 'scripts/rules-preservation.py')
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class RulesPreservationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cmos-rules-gate-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project'
        self.root.mkdir()
        self.originals = {
            'agents.md': b'# App\r\n\r\nKEEP  exact spaces.\r\nOld procedure.\r\nKEEP order.\r\n',
            'cmos/agents.md': b'# Legacy\nProject thesis remains.\nOld call. Keep this exact remainder.\nSee root agents.md\n',
            'cmos/templates/agents.md': b'Template stays byte-for-byte.\n',
        }
        for name, content in self.originals.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (self.root / 'cmos/db').mkdir()
        with sqlite3.connect(self.root / 'cmos/db/cmos.sqlite') as db:
            db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT)')
            db.execute("INSERT INTO metadata VALUES ('project_type','general')")
        self.spec = {
            'target': 'fixture', 'root': str(self.root), 'expectedTier': 'general',
            'files': [{
                'path': name, 'sha256': hashlib.sha256(content).hexdigest(),
                'pointerBeforeLine': 3 if name == 'agents.md' else None,
                'classifications': [],
            } for name, content in self.originals.items()],
        }
        self.spec['files'][0]['classifications'] = [
            {'start': 4, 'end': 4, 'class': 'REPLACE', 'reason': 'Old CMOS procedure.'},
        ]
        self.spec['files'][1]['classifications'] = [
            {'start': 3, 'end': 3, 'class': 'MIXED', 'reason': 'Retain project-specific remainder.',
             'remove': 'Old call. ', 'insert': ''},
            {'start': 4, 'end': 4, 'class': 'IMPORT', 'action': 'keep', 'reason': 'Root guidance.'},
        ]

    def candidate(self):
        ledger = gate.make_ledger(self.spec)
        content = {f['path']: gate.expected_bytes(f, ledger['pointer']) for f in ledger['files']}
        return ledger, content

    def test_keeps_legacy_project_content_and_every_original_line_is_classified(self):
        ledger, content = self.candidate()
        self.assertEqual(sum(len(f['lines']) for f in ledger['files']), 10)
        self.assertEqual(content['cmos/agents.md'], b'# Legacy\nProject thesis remains.\nKeep this exact remainder.\nSee root agents.md\n')
        self.assertEqual(content['cmos/templates/agents.md'], self.originals['cmos/templates/agents.md'])
        self.assertIn(b'**Ledger**', content['agents.md'])
        self.assertIn(b'KEEP  exact spaces.\r\n', content['agents.md'])
        self.assertEqual(gate.candidate_issues(ledger, content), [])

    def test_each_protected_byte_and_its_order_is_required(self):
        ledger, original = self.candidate()
        mutations = {
            'loss': original['agents.md'].replace(b'KEEP  exact spaces.\r\n', b''),
            'whitespace': original['agents.md'].replace(b'KEEP  exact', b'KEEP exact'),
            'newline': original['agents.md'].replace(b'KEEP  exact spaces.\r\n', b'KEEP  exact spaces.\n'),
            'duplicate': original['agents.md'] + b'KEEP order.\r\n',
            'order': original['agents.md'].replace(b'KEEP  exact spaces.', b'KEEP order.').replace(b'KEEP order.\r\nKEEP order.', b'KEEP order.\r\nKEEP  exact spaces.'),
            'retired': original['agents.md'] + b'Old procedure.\r\n',
        }
        for why, changed in mutations.items():
            with self.subTest(mutation=why):
                content = {**original, 'agents.md': changed}
                self.assertTrue(gate.candidate_issues(ledger, content))
        for old in [b'Project thesis remains.\n', b'Keep this exact remainder.\n']:
            self.assertTrue(gate.candidate_issues(ledger, {**original, 'cmos/agents.md': original['cmos/agents.md'].replace(old, b'')}))

    def test_backup_hash_and_reviewed_ledger_rows_are_independent_checks(self):
        ledger, content = self.candidate()
        ledger['files'][1]['lines'][1]['original'] = gate.encode(b'Invented thesis.\n')
        self.assertTrue(gate.candidate_issues(ledger, content))

    def test_original_bytes_must_still_match_before_staging(self):
        (self.root / 'agents.md').write_bytes(self.originals['agents.md'] + b'Outside write.\n')
        with self.assertRaisesRegex(ValueError, 'changed original'):
            gate.make_ledger(self.spec)

    def test_rules_git_changes_block_but_unrelated_changes_do_not(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture'], check=True)
        (self.root / 'unrelated.txt').write_text('Operator work.\n')
        self.assertEqual(gate.make_ledger(self.spec)['git']['rulesStatus'], '')
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--chmod=+x', 'agents.md'], check=True)
        with self.assertRaisesRegex(ValueError, 'rules files have uncommitted changes'):
            gate.make_ledger(self.spec)

    def test_inventory_overlap_and_paths_fail_closed(self):
        for mutate in ['missing', 'overlap', 'escape']:
            spec = copy.deepcopy(self.spec)
            if mutate == 'missing':
                spec['files'].pop()
            elif mutate == 'overlap':
                spec['files'][0]['classifications'] *= 2
            else:
                spec['files'][0]['path'] = '../outside/agents.md'
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                gate.make_ledger(spec)

    def test_stage_reuses_identical_evidence_and_checks_both_candidate_and_live_hash(self):
        out = Path(self.temp.name) / 'evidence'
        ledger = gate.stage(self.spec, out)
        first = (out / 'ledger.json').read_bytes()
        gate.stage(self.spec, out)
        self.assertEqual(first, (out / 'ledger.json').read_bytes())
        for name, original in self.originals.items():
            self.assertEqual((out / 'backup' / (name + '.bytes')).read_bytes(), original)
        self.assertEqual(gate.check(out / 'ledger.json', preflight=True)['issues'], [])
        target = out / 'candidate/cmos/agents.md.bytes'
        target.write_bytes(target.read_bytes().replace(b'Project thesis remains.\n', b''))
        self.assertTrue(gate.check(out / 'ledger.json')['issues'])
        target.write_bytes(gate.expected_bytes(ledger['files'][1], ledger['pointer']))
        (self.root / 'agents.md').write_bytes(self.originals['agents.md'] + b'Outside writer.\n')
        self.assertTrue(gate.check(out / 'ledger.json', preflight=True)['issues'])

    def test_cli_check_rejects_unclassified_candidate_rules(self):
        out = Path(self.temp.name) / 'evidence'
        gate.stage(self.spec, out)
        for name in ['nested/CLAUDE.md', 'nested/unclassified.bytes']:
            with self.subTest(extra=name):
                extra = out / 'candidate' / name
                extra.parent.mkdir(exist_ok=True)
                extra.write_text('Unreviewed instructions.\n')
                self.assertIn('candidate file inventory differs from ledger', gate.check(out / 'ledger.json')['issues'])
                cli = subprocess.run([sys.executable, '-B', str(REPO / 'scripts/rules-preservation.py'),
                                      'check', '--ledger', str(out / 'ledger.json')], capture_output=True, text=True)
                self.assertEqual(cli.returncode, 1)
                self.assertIn('candidate file inventory differs from ledger', json.loads(cli.stdout)['issues'])
                extra.unlink()

    def test_staging_never_creates_active_rules_filenames(self):
        out = Path(self.temp.name) / 'evidence'
        ledger = gate.stage(self.spec, out)
        self.assertEqual(gate.inventory(out), [])
        for file in ledger['files']:
            self.assertEqual((out / 'backup' / (file['path'] + '.bytes')).read_bytes(), self.originals[file['path']])
            self.assertEqual((out / 'candidate' / (file['path'] + '.bytes')).read_bytes(), gate.expected_bytes(file, ledger['pointer']))

    def test_live_candidate_root_uses_actual_rules_names_and_inventory(self):
        out = Path(self.temp.name) / 'evidence'
        ledger = gate.stage(self.spec, out)
        for file in ledger['files']:
            (self.root / file['path']).write_bytes(gate.expected_bytes(file, ledger['pointer']))
        self.assertEqual(gate.check(out / 'ledger.json', candidate_root=self.root)['issues'], [])
        (self.root / 'CLAUDE.md').write_text('Unexpected live rule.\n')
        self.assertIn('candidate file inventory differs from ledger', gate.check(out / 'ledger.json', candidate_root=self.root)['issues'])


if __name__ == '__main__':
    unittest.main()

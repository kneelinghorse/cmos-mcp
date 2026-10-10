#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Stage independently classified rules refreshes with original-byte and git-clean gates.
# ABOUTME: Validate exact candidate bytes, protected line order and real-source CMOS level pointers.
import argparse
import base64
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
RENDERER = REPO / 'src/tools/cmos/rules-files.ts'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(data):
    return base64.b64encode(data).decode('ascii')


def decode(text):
    return base64.b64decode(text, validate=True)


def relative_file(root, name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError(f'unsafe relative path: {name}')
    target = root / path
    if not target.resolve().is_relative_to(root.resolve()) or target.is_symlink():
        raise ValueError(f'rules path leaves its root or is a symlink: {name}')
    return target


def inventory(root):
    found = []
    for directory, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '.venv', '__pycache__')
                   and not Path(directory, d).is_symlink()]
        for name in files:
            rel = (Path(directory) / name).relative_to(root).as_posix()
            if (name.lower() in ('agents.md', 'claude.md', '.cursorrules', 'charter.md')
                    or re.search(r'(^|/)\.claude/rules/.*\.md$|(^|/)\.cursor/rules/.*\.(md|mdc)$|(^|/)\.github/(copilot-instructions\.md|instructions/.*\.instructions\.md)$', rel, re.I)):
                relative_file(root, rel)
                found.append(rel)
    return sorted(found)


def artifact_inventory(root):
    # Staged witnesses use inert names. Every file counts, including unknown extensions.
    found = []
    for directory, dirs, files in os.walk(root):
        if any(Path(directory, name).is_symlink() for name in dirs):
            raise ValueError('staged evidence contains a symlinked directory')
        for name in files:
            rel = (Path(directory) / name).relative_to(root).as_posix()
            relative_file(root, rel)
            found.append(rel)
    return sorted(found)


def git_state(root, names):
    probe = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'],
                           capture_output=True, text=True)
    if probe.returncode:
        # A corrupt git checkout must not be mistaken for a deliberately non-git project.
        if any((parent / '.git').exists() for parent in [root, *root.parents]):
            raise ValueError(f'git discovery failed: {probe.stderr.strip()}')
        return {'repository': False, 'branch': None, 'head': None, 'rulesStatus': None}
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    status = git('status', '--porcelain=v1', '--untracked-files=all', '--', *names)
    if status:
        raise ValueError(f'rules files have uncommitted changes: {status}')
    return {'repository': True, 'branch': git('branch', '--show-current'),
            'head': git('rev-parse', 'HEAD'), 'rulesStatus': status}


def live_tier(root):
    database = relative_file(root, 'cmos/db/cmos.sqlite')
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT value FROM metadata WHERE key='project_type'").fetchone()
    return row[0] if row else None


def render_pointer(tier):
    rendered = json.loads(subprocess.check_output(
        ['node', str(REPO / 'scripts/render-rules-pointer.js'), json.dumps(tier)],
        cwd=REPO, text=True))
    return {**rendered, 'source': str(RENDERER.relative_to(REPO)), 'sourceSha256': sha(RENDERER.read_bytes())}


def classify(content, item):
    lines = content.splitlines(keepends=True)
    rows = [{'line': number, 'class': 'KEEP', 'reason': 'Project content or structure; retain exact bytes.',
             'original': encode(line), 'retained': encode(line), 'text': line.decode().rstrip('\r\n')} for number, line in enumerate(lines, 1)]
    changed = set()
    for rule in item.get('classifications', []):
        start, end = rule['start'], rule['end']
        kind = rule['class']
        if start < 1 or end > len(rows) or end < start or kind not in ('KEEP', 'REPLACE', 'MIXED', 'IMPORT') or not rule.get('reason'):
            raise ValueError(f'invalid line classification in {item["path"]}: {rule}')
        if kind == 'MIXED' and start != end:
            raise ValueError('MIXED must identify one exact original line')
        for number in range(start, end + 1):
            if number in changed:
                raise ValueError(f'overlapping classifications: {item["path"]}:{number}')
            changed.add(number)
            row = rows[number - 1]
            original = decode(row['original'])
            row.update({'class': kind, 'reason': rule['reason']})
            if kind == 'REPLACE' or (kind == 'IMPORT' and rule.get('action') == 'retire'):
                row['retained'] = ''
            elif kind == 'MIXED':
                remove, insert = rule['remove'].encode(), rule['insert'].encode()
                if not remove or original.count(remove) != 1:
                    raise ValueError(f'MIXED fragment must occur once: {item["path"]}:{number}')
                before, after = original.split(remove)
                row.update({'retained': encode(before + insert + after), 'remove': encode(remove),
                            'insert': encode(insert), 'protected': [encode(before), encode(after)]})
            elif kind == 'IMPORT' and rule.get('action') != 'keep':
                raise ValueError('IMPORT requires keep or retire')
            if kind == 'IMPORT':
                row['action'] = rule['action']
    return rows


def expected_bytes(file, pointer):
    before = file.get('pointerBeforeLine')
    lines = file['lines']
    if before is not None and (not isinstance(before, int) or before < 1 or before > len(lines) + 1):
        raise ValueError(f'invalid pointer insertion: {file["path"]}')
    newline = decode(file['newline'])
    insertion = pointer['text'].encode() + newline + (newline if before != 1 else b'')
    parts = []
    for row in lines:
        if row['line'] == before:
            parts.append(insertion)
        parts.append(decode(row['retained']))
    if before == len(lines) + 1:
        parts.append(insertion)
    return b''.join(parts)


def make_ledger(spec):
    root = Path(spec['root']).resolve()
    names = [item['path'] for item in spec['files']]
    for name in names:
        relative_file(root, name)
    if len(names) != len(set(names)) or sorted(names) != inventory(root):
        raise ValueError('classification file inventory differs from rules files on disk')
    git = git_state(root, names)
    tier = live_tier(root)
    if tier != spec['expectedTier']:
        raise ValueError(f'project tier changed: expected {spec["expectedTier"]!r}, found {tier!r}')
    pointer = render_pointer(tier)
    files = []
    for item in spec['files']:
        source = relative_file(root, item['path'])
        content = source.read_bytes()
        if sha(content) != item['sha256']:
            raise ValueError(f'changed original: {source}')
        rows = classify(content, item)
        newline = b'\r\n' if b'\r\n' in content else b'\n'
        files.append({'path': item['path'], 'sha256': sha(content), 'mode': source.stat().st_mode & 0o777,
                      'pointerBeforeLine': item.get('pointerBeforeLine'), 'newline': encode(newline),
                      'lines': rows})
    return {'version': 1, 'target': spec['target'], 'root': str(root), 'expectedTier': tier,
            'git': git, 'pointer': pointer, 'files': files}


def candidate_issues(ledger, candidates):
    issues = []
    if set(candidates) != {file['path'] for file in ledger['files']}:
        issues.append('candidate file inventory differs from ledger')
    for file in ledger['files']:
        originals = b''.join(decode(row['original']) for row in file['lines'])
        if sha(originals) != file['sha256']:
            issues.append(f'original ledger bytes do not match hash: {file["path"]}')
        for number, row in enumerate(file['lines'], 1):
            original, retained = decode(row['original']), decode(row['retained'])
            if row.get('text') != original.decode().rstrip('\r\n'):
                issues.append(f'ledger display text changed: {file["path"]}:{number}')
            if row['line'] != number:
                issues.append(f'ledger line order changed: {file["path"]}:{number}')
            if row['class'] == 'KEEP' or (row['class'] == 'IMPORT' and row.get('action') == 'keep'):
                if original != retained:
                    issues.append(f'protected ledger bytes changed: {file["path"]}:{number}')
            elif row['class'] == 'MIXED':
                remove, insert = decode(row['remove']), decode(row['insert'])
                if (not remove or original.count(remove) != 1 or original.replace(remove, insert) != retained
                        or [encode(part) for part in original.split(remove)] != row['protected']):
                    issues.append(f'mixed protected remainder changed: {file["path"]}:{number}')
            elif row['class'] == 'REPLACE' or (row['class'] == 'IMPORT' and row.get('action') == 'retire'):
                if retained:
                    issues.append(f'retired procedure reintroduced: {file["path"]}:{number}')
            else:
                issues.append(f'unrecognized classification: {file["path"]}:{number}')
        if candidates.get(file['path']) != expected_bytes(file, ledger['pointer']):
            issues.append(f'candidate differs from exact classified projection: {file["path"]}')
    return issues


def stage(spec, out):
    ledger = make_ledger(spec)
    root, out = Path(ledger['root']), out.resolve()
    if out.is_relative_to(root) or root.is_relative_to(out):
        raise ValueError('evidence directory must be separate from the target tree')
    expected = {file['path']: expected_bytes(file, ledger['pointer']) for file in ledger['files']}
    issues = candidate_issues(ledger, expected)
    if issues:
        raise ValueError('; '.join(issues))
    payload = (json.dumps(ledger, indent=2, ensure_ascii=False) + '\n').encode()
    artifacts = {'ledger.json': payload}
    diffs = []
    for file in ledger['files']:
        name = file['path']
        original = b''.join(decode(row['original']) for row in file['lines'])
        artifacts[f'backup/{name}.bytes'] = original
        artifacts[f'candidate/{name}.bytes'] = expected[name]
        diffs.extend(difflib.unified_diff(original.decode().splitlines(keepends=True), expected[name].decode().splitlines(keepends=True), fromfile=f'original/{name}', tofile=f'candidate/{name}'))
    artifacts['candidate.diff'] = ''.join(diffs).encode()
    # Check every artifact before writing any; repeat staging can reuse, never silently overwrite.
    for name, content in artifacts.items():
        dest = relative_file(out, name)
        if dest.exists() and dest.read_bytes() != content:
            raise ValueError(f'evidence already exists with different bytes: {dest}')
    for name, content in artifacts.items():
        dest = relative_file(out, name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            with dest.open('xb') as handle:
                handle.write(content)
    return ledger


def check(ledger_path, preflight=False, candidate_root=None):
    ledger = json.loads(ledger_path.read_text())
    candidates = candidate_root or ledger_path.parent / 'candidate'
    suffix = '' if candidate_root is not None else '.bytes'
    content = {file['path']: relative_file(candidates, file['path'] + suffix).read_bytes() for file in ledger['files']}
    issues = candidate_issues(ledger, content)
    candidate_names = inventory(candidates) if candidate_root is not None else artifact_inventory(candidates)
    if sorted(name + suffix for name in content) != candidate_names:
        issues.append('candidate file inventory differs from ledger')
    for file in ledger['files']:
        backup = relative_file(ledger_path.parent / 'backup', file['path'] + '.bytes').read_bytes()
        if sha(backup) != file['sha256']:
            issues.append(f'backup hash changed: {file["path"]}')
    if render_pointer(ledger['expectedTier']) != ledger['pointer']:
        issues.append('source renderer changed since classification')
    if preflight:
        root = Path(ledger['root'])
        try:
            names = [file['path'] for file in ledger['files']]
            if sorted(names) != inventory(root):
                issues.append('live rules inventory changed')
            current = git_state(root, names)
            if current != ledger['git']:
                issues.append('target git branch/head changed since classification')
            if live_tier(root) != ledger['expectedTier']:
                issues.append('target level changed since classification')
            for file in ledger['files']:
                if sha(relative_file(root, file['path']).read_bytes()) != file['sha256']:
                    issues.append(f'changed original: {file["path"]}')
        except (ValueError, sqlite3.Error) as error:
            issues.append(str(error))
    counts = {kind: sum(row['class'] == kind for file in ledger['files'] for row in file['lines'])
              for kind in ('KEEP', 'REPLACE', 'MIXED', 'IMPORT')}
    return {'target': ledger['target'], 'root': ledger['root'], 'level': ledger['pointer']['level'],
            'git': ledger['git'], 'lineCounts': counts,
            'countingRule': 'One row per original physical line, including its original newline bytes.',
            'issues': issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['inventory', 'stage', 'check', 'preflight', 'self-test'])
    parser.add_argument('--root', type=Path)
    parser.add_argument('--spec', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--ledger', type=Path)
    parser.add_argument('--candidate-root', type=Path)
    args = parser.parse_args()
    if args.mode == 'self-test':
        return subprocess.call([sys.executable, '-B', str(REPO / 'tests/scripts/rules_preservation_test.py')])
    if args.mode == 'inventory':
        if not args.root:
            parser.error('--root required')
        print(json.dumps(inventory(args.root.resolve()), indent=2))
        return 0
    if args.mode == 'stage':
        if not args.spec or not args.out:
            parser.error('--spec and --out required')
        stage(json.loads(args.spec.read_text()), args.out)
        receipt = check(args.out / 'ledger.json', preflight=True)
    else:
        if not args.ledger:
            parser.error('--ledger required')
        receipt = check(args.ledger, preflight=args.mode == 'preflight', candidate_root=args.candidate_root)
    print(json.dumps(receipt, indent=2, ensure_ascii=False))
    return 1 if receipt['issues'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, sqlite3.Error, subprocess.CalledProcessError) as error:
        print(f'Rules preservation refused: {error}', file=sys.stderr)
        sys.exit(1)

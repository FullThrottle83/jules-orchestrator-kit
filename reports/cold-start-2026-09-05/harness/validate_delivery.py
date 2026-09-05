#!/usr/bin/env python3
"""Validate this report's packaging, not the product's correctness. No tests run."""
import ast
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile

REPORT = Path(__file__).resolve().parent.parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    for path in [REPORT / 'replay.py', *(REPORT / 'harness').glob('*.py')]:
        ast.parse(path.read_text(), filename=str(path))
    with tempfile.TemporaryDirectory(prefix='cold-start-bundle-verify-') as repository:
        subprocess.run(['git', 'init', '--bare', '--quiet', repository], check=True)
        for bundle in (REPORT / 'baselines').glob('*.bundle'):
            subprocess.run(['git', 'bundle', 'verify', str(bundle)], cwd=repository,
                           check=True, stdout=subprocess.DEVNULL)
    for path in REPORT.glob('*.md'):
        for target in re.findall(r'\[[^\]]+\]\(([^)]+)\)', path.read_text()):
            if target.startswith(('https:', 'http:', 'mailto:', '#')):
                continue
            assert (path.parent / target.split('#', 1)[0]).exists(), (path.name, target)
    index = json.loads((REPORT / 'evidence-index.json').read_text())
    files = {row['path']: row for row in index['files']}
    with tarfile.open(REPORT / 'evidence.tar.gz', 'r:gz') as archive:
        members = {member.name: member for member in archive if member.isfile()}
        assert set(members) == {'evidence/' + name for name in files}
        for name, row in files.items():
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts
            data = archive.extractfile(members['evidence/' + name]).read()
            assert len(data) == row['bytes'] and digest(data) == row['sha256'], name
        report_text = (REPORT / 'REPORT.md').read_text()
        excerpts = json.loads((REPORT / 'excerpts.json').read_text())
        for quote in excerpts:
            name = quote['file']
            data = archive.extractfile(members['evidence/' + name]).read()
            assert digest(data) == quote['file_sha256'], name
            assert (REPORT / 'evidence' / name).read_bytes() == data, name
            lines = data.decode().splitlines()
            text = '\n'.join(lines[quote['start_line'] - 1:quote['end_line']]).strip('\n')
            assert digest(text.encode()) == quote['excerpt_sha256'], name
            assert text in report_text, name
        assert archive.extractfile(members['evidence/final-process-check.log']).read().strip() == b'0'
    subprocess.run(['sha256sum', '-c', '--quiet', 'SHA256SUMS'], cwd=REPORT, check=True)
    print(f'Validated {len(files)} archived files, {len(excerpts)} excerpts, all bundles, Python syntax, local Markdown links, and delivery checksums.')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Reproduce this report with the agentctl currently installed on PATH.

prepare restores public upstreams and exact, bundled scaffold commits. It never
changes the kit checkout, installs agentctl, pushes, or calls a paid provider.
Use COLD_START_ROOT to choose another scratch root (default matches recordings).
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('COLD_START_ROOT', '/home/user/cold-start-trial')).expanduser().resolve()
sys.path.insert(0, str(HERE / 'harness'))
from runlib import run
from matrix import execute, REPOS, env_for
from phase5 import one as boundary
from phase8 import one as silence


def restore_upstream_refs(repository, bundle):
    # A bundle with a detached HEAD clones without local branch refs. Preserve
    # the original public base refs as well, or bootstrap cases test a missing
    # base rather than the policy boundary described in the report.
    heads = subprocess.check_output(['git', 'bundle', 'list-heads', str(bundle)], text=True)
    for line in heads.splitlines():
        oid, ref = line.split()
        if not ref.startswith('refs/heads/'):
            continue
        current = subprocess.run(['git', 'rev-parse', '--verify', ref], cwd=repository, text=True, capture_output=True)
        if current.returncode:
            subprocess.run(['git', 'update-ref', ref, oid, '0' * 40], cwd=repository, check=True)
        elif current.stdout.strip() != oid:
            raise SystemExit(f'Refusing to overwrite divergent base ref {ref} in {repository}; use a fresh scratch root.')


def prepare():
    manifest = json.loads((HERE / 'baselines/manifest.json').read_text())
    for name in ['evidence', 'work', 'upstream', 'harness']:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    for f in (HERE / 'harness').glob('*.py'):
        target = ROOT / 'harness' / f.name
        if f.resolve() != target.resolve():
            shutil.copy2(f, target)
    for name, item in manifest.items():
        upstream = ROOT / 'upstream' / name
        baseline = ROOT / 'work' / (name + '-baseline')
        bundle = HERE / 'baselines' / (name + '.bundle')
        if not upstream.exists():
            subprocess.run(['git', 'clone', '--no-checkout', str(bundle), str(upstream)], check=True)
            subprocess.run(['git', 'checkout', '--detach', item['upstream_sha']], cwd=upstream, check=True)
            subprocess.run(['git', 'remote', 'set-url', 'origin', item['url']], cwd=upstream, check=True)
        else:
            present = subprocess.run(['git', 'cat-file', '-e', item['upstream_sha'] + '^{commit}'], cwd=upstream)
            if present.returncode:
                subprocess.run(['git', 'fetch', str(bundle), 'HEAD'], cwd=upstream, check=True)
        restore_upstream_refs(upstream, bundle)
        if not baseline.exists():
            subprocess.run(['git', 'clone', '--no-hardlinks', str(upstream), str(baseline)], check=True)
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=baseline, text=True).strip()
        if head != item['baseline_sha']:
            if subprocess.check_output(['git', 'status', '--porcelain'], cwd=baseline):
                raise SystemExit(f'Refusing to overwrite dirty baseline: {baseline}')
            subprocess.run(['git', 'fetch', str(HERE / 'baselines' / (name + '.bundle')), 'HEAD'], cwd=baseline, check=True)
            subprocess.run(['git', 'checkout', '--detach', item['baseline_sha']], cwd=baseline, check=True)
        restore_upstream_refs(baseline, bundle)
        subprocess.run(['git', 'config', 'user.name', 'Cold Start Trial'], cwd=baseline, check=True)
        subprocess.run(['git', 'config', 'user.email', 'cold-start@example.invalid'], cwd=baseline, check=True)
        if name == 'p-limit' and not (baseline / 'node_modules/.bin/ava').exists():
            shutil.copy2(HERE / 'baselines/p-limit-package-lock.json', baseline / 'package-lock.json')
            subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=baseline, check=True)
        if name == 'itsdangerous':
            subprocess.run(['uv', 'sync', '--locked'], cwd=baseline, check=True)
    print(f'Prepared exact baselines and harness in {ROOT}.')


def clean_probe(repo, mode, attempt):
    p = ROOT / 'work' / f'replay-{mode}-{attempt}'
    pre = f'replay-{mode}-{attempt}'
    sha = REPOS[repo]['sha']
    qp = shlex.quote(str(p))
    source = shlex.quote(str(ROOT / 'upstream' / repo))
    code, _ = run(pre + '-prepare', f'rm -rf {qp}; git clone --no-hardlinks {source} {qp} && cd {qp} && git checkout --detach {sha} && git config user.name "Cold Start Trial" && git config user.email "cold-start@example.invalid"')
    if code:
        raise RuntimeError('Fresh clone failed')
    if repo == 'itsdangerous':
        run(pre + '-deps', 'uv sync --locked', p)
    env = env_for(repo, p)
    if mode == 'scaffold':
        code, _ = run(pre + '-before', 'uv run --locked pre-commit run --all-files', p, env=env)
        if code:
            raise RuntimeError('Pristine host lint failed; this is not a valid scaffold comparison')
    run(pre + '-init', 'agentctl init --yes', p, env=env)
    if mode == 'cargo-count':
        run(pre + '-minimal', 'agentctl profile --set minimal', p, env=env)
    run(pre + '-commit', 'git add .agent AGENTS.md SPEC.md CONSTRAINTS.md .gitignore && git commit -m "chore: add agent config"', p, env=env)
    if mode == 'scaffold':
        run(pre + '-result', 'uv run --locked pre-commit run --all-files', p, env=env)
    else:
        run(pre + '-result', 'agentctl check --base HEAD', p, env=env)
    return pre


MATRIX_CASES = {
    'F01': [(3, 'p-limit', c) for c in ['delete-assertion', 'rewrite-expectation', 'vacuous-assertion']],
    'F02': [(3, r, 'new-untested-file') for r in REPOS],
    'F03': [(3, 'itsdangerous', 'rewrite-expectation')],
    'F04': [(3, r, 'uncollect-test') for r in ['itsdangerous', 'is', 'mini_markdown']],
    'F05': [(3, 'is', 'vacuous-assertion')],
    'F16': [(4, 'itsdangerous', 'lockfile')],
}
BOUNDARY_CASES = {'F06': ['bootstrap-policy'], 'F07': ['staged-policy'], 'F08': ['committed-base-policy'], 'F17': ['advertised-strict-locks'], 'F18': ['allow-protected', 'min-tests-zero', 'optional-failing-stage'], 'F19': ['required-false'], 'F20': ['dry-run', 'evidence-disabled']}
SILENCE_CASES = {'F04': ['go-build-tag', 'rust-cfg-disable', 'python-xfail', 'python-early-return'], 'F09': ['no-op-node', 'no-op-shell', 'go-empty-selection', 'pytest-collect-only', 'wrapper-edit'], 'F10': ['staged-snapshot', 'committed-snapshot'], 'F11': ['python-installed-copy'], 'F12': ['max-untracked']}


def meta_exit(prefix, label):
    return json.loads((ROOT / 'evidence' / (prefix + '-' + label + '.meta.json')).read_text())['exit_code']


def text(prefix, label):
    return (ROOT / 'evidence' / (prefix + '-' + label + '.log')).read_text()


def replay(finding, attempts, expect_fixed):
    assertions = []
    for attempt in attempts:
        for phase, repo, case in MATRIX_CASES.get(finding, []):
            row = execute(repo, case, attempt, phase)
            if row.get('fixture_error'):
                raise RuntimeError(row['fixture_error'])
            good = row.get('host_exit') == 0 and row.get('gate_exit') == (0 if finding == 'F16' else 6)
            if finding == 'F02':
                good = row.get('host_exit') == 0 and row.get('gate_exit') in (3, 4, 6)
            assertions.append(good)
        for case in BOUNDARY_CASES.get(finding, []):
            boundary(case, attempt)
            pre = f'phase5-is-{case}-{attempt}'
            out = text(pre, 'gate') if finding != 'F18' or case != 'allow-protected' else text(pre, 'env-override')
            if finding in ['F06', 'F07', 'F08']:
                assertions.append(meta_exit(pre, 'gate') in (3, 4, 6))
            elif finding == 'F17':
                advertised = '--strict-locks' in subprocess.check_output(['agentctl', 'check', '--help'], text=True)
                assertions.append(not advertised or meta_exit(pre, 'gate') == 0)
            elif finding == 'F18':
                assertions.append('OVERRIDES ACTIVE' in out)
            elif finding == 'F19':
                assertions.append(not ('nothing is executed' in out and 'Command: go test ./...' in out))
            elif finding == 'F20':
                before = {x for x in text(pre, 'before').splitlines() if '/evidence/' in x}
                after = {x for x in text(pre, 'after').splitlines() if '/evidence/' in x}
                assertions.append(before == after)
        for case in SILENCE_CASES.get(finding, []):
            silence(case, attempt)
            repo = 'p-limit' if case == 'max-untracked' else 'mini_markdown' if case == 'rust-cfg-disable' else 'itsdangerous' if case.startswith('python-') or case == 'pytest-collect-only' else 'is'
            pre = f'phase8-{repo}-{case}-{attempt}'
            if finding == 'F12':
                assertions.append(meta_exit(pre, 'coverage') == 1 and json.loads(text(pre, 'coverage')).get('ok') is False)
            else:
                assertions.append(meta_exit(pre, 'gate') in (3, 4, 6))
        if finding in ['F13', 'F14', 'F15']:
            mode = {'F13': 'scaffold', 'F14': 'cargo-lint', 'F15': 'cargo-count'}[finding]
            pre = clean_probe('itsdangerous' if finding == 'F13' else 'mini_markdown', mode, attempt)
            if finding == 'F14':
                # This isolates the invented lint failure from the separate Cargo count bug.
                assertions.append('Stage: lint (exit 101)' not in text(pre, 'result'))
            else:
                assertions.append(meta_exit(pre, 'result') == 0)
        if finding in ['F21', 'F22']:
            p = ROOT / 'work' / f'replay-{finding}-{attempt}'
            pre = f'replay-{finding}-{attempt}'
            qp = shlex.quote(str(p))
            run(pre + '-prepare', f'rm -rf {qp}; mkdir -p {qp}')
            if finding == 'F21':
                run(pre + '-result', 'agentctl pr harvest --help', p)
                assertions.append('--allow-no-checks' in text(pre, 'result'))
            else:
                code, _ = run(pre + '-result', 'grep -niE "uninstall|removing the kit|undo.*init" "$(npm root -g)/jules-orchestrator-kit/README.md"', p)
                assertions.append(code == 0)
    if not assertions:
        raise SystemExit('Unknown finding or no checks executed')
    if expect_fixed:
        print(f'{finding}: {sum(assertions)}/{len(assertions)} proposed fix checks passed')
        return 0 if all(assertions) else 1
    print(f'{finding}: replay complete; inspect the raw evidence in {ROOT / "evidence"}.')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('finding', help='prepare, or F01 through F22')
    parser.add_argument('--round', type=int, choices=[1, 2])
    parser.add_argument('--expect-fixed', action='store_true')
    args = parser.parse_args()
    if args.finding == 'prepare':
        prepare()
    else:
        raise SystemExit(replay(args.finding.upper(), [args.round] if args.round else [1, 2], args.expect_fixed))

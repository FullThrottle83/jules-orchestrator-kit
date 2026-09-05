#!/usr/bin/env python3
import os,sys,json,pathlib,subprocess,argparse,re
from runlib import ROOT,EVIDENCE,run
from matrix import prepare,env_for,REPOS
from fixtures import apply,break_production,replace
from phase5 import config,commit

CASES=['no-op-true-string','no-op-true','no-op-node','no-op-shell','go-empty-selection','no-commands','pytest-collect-only','wrapper-edit','staged-snapshot','committed-snapshot','python-installed-copy','max-untracked','go-build-tag','rust-cfg-disable','python-xfail','python-early-return','node-only']

def one(case,attempt):
 repo='is'
 if case.startswith('python-') or case=='pytest-collect-only':repo='itsdangerous'
 if case in ['max-untracked','node-only']:repo='p-limit'
 if case=='rust-cfg-disable':repo='mini_markdown'
 p,pre,base=prepare(repo,case,attempt,8);env=env_for(repo,p);res=[]
 def record(label,c,timeout=90):
  code,out=run(pre+'-'+label,c,p,env=env,timeout=timeout);res.append({'step':label,'exit':code,'approved':'Overall Result: APPROVED' in out});return code,out
 if case in ['no-op-true-string','no-op-true','no-op-node','no-op-shell','go-empty-selection','no-commands','pytest-collect-only']:
  commands={'no-op-true-string':"'true'",'no-op-true':'true','no-op-node':'node -e "process.exit(0)"','no-op-shell':'sh -c :','go-empty-selection':'go test -run "^$" ./...','no-commands':"''",'pytest-collect-only':'PYTHONPATH=src python3 -m pytest --collect-only'}
  config(p,profile='minimal',test=commands[case],lint="''",build="''")
  commit(p,'trusted-oracle',pre)
  break_production(repo,p);record('host-broken',REPOS[repo]['test'])
  if case!='no-commands':record('configured-command',commands[case])
  record('gate','agentctl check --base HEAD')
 elif case=='wrapper-edit':
  (p/'scripts').mkdir(exist_ok=True);(p/'scripts/verify.sh').write_text('#!/bin/sh\nset -eu\ngo test ./...\n')
  config(p,profile='minimal',test='sh scripts/verify.sh')
  record('trusted-wrapper','git add .agent/config.yml scripts/verify.sh && git commit -m "trial: configure an honest test wrapper"; sh scripts/verify.sh')
  break_production(repo,p);record('host-broken',REPOS[repo]['test'])
  (p/'scripts/verify.sh').write_text('#!/bin/sh\nexit 0\n')
  record('wrapper-no-tests','sh scripts/verify.sh');record('gate','agentctl check --base HEAD')
 elif case in ['staged-snapshot','committed-snapshot']:
  break_production(repo,p);record('host-broken',REPOS[repo]['test']);record('stage','git add is.go')
  if case=='committed-snapshot':record('commit-broken','git commit -m "agent: broken production change"')
  record('working-copy-fix',f'git show {base}:is.go > is.go; git status --short; go test ./...')
  flags='--mode staged --base HEAD' if case=='staged-snapshot' else f'--mode committed --base {base}'
  record('gate','agentctl check '+flags)
  record('materialize-audited-snapshot','git checkout-index -f -- is.go; go test ./...')
  record('control-gate','agentctl check '+flags)
 elif case=='python-installed-copy':
  config(p,test='python3 -m pytest')
  commit(p,'trusted-oracle',pre)
  record('install-pristine-copy','uv pip install --python .venv/bin/python --no-deps --reinstall .')
  record('pristine-import','python3 -c "import itsdangerous; print(itsdangerous.__file__)"; PYTHONPATH=src python3 -m pytest')
  break_production(repo,p)
  record('working-tree-tests','PYTHONPATH=src python3 -m pytest')
  record('import-proof','python3 -c "import itsdangerous.encoding as e; print(e.__file__); print(e.bytes_to_int(bytes([192])))"; PYTHONPATH=src python3 -c "import itsdangerous.encoding as e; print(e.__file__); print(e.bytes_to_int(bytes([192])))"')
  record('configured-command','python3 -m pytest')
  record('gate','agentctl check --base HEAD')
 elif case=='max-untracked':
  config(p,profile='max');commit(p,'max-profile',pre);apply(repo,'new-untested-file',p)
  record('ground-truth','node --input-type=module -e "import add from \'./untested-add.js\'; console.log(\'add(2, 3) =\', add(2, 3)); if (add(2, 3) !== 5) process.exit(1)"')
  record('host',REPOS[repo]['test'])
  record('coverage','agentctl coverage --base HEAD --cmd "npm test" --json')
  record('mutation','agentctl mutate --cmd "npm test" --json')
  record('gate','agentctl check --base HEAD',timeout=120)
  record('evidence','agentctl evidence show')
 elif case=='go-build-tag':
  f=p/'is-1.7_test.go';replace(f,'//go:build go1.7','//go:build go1.7 && cold_start_never');replace(f,'// +build go1.7','// +build go1.7,cold_start_never')
  record('host','go test -count=1 -v ./...');record('gate','agentctl check --base HEAD')
 elif case=='rust-cfg-disable':
  f=p/'tests/iter_tests/all.rs';replace(f,'#[test]\nfn peek_does_not_advance(){','#[test]\n#[cfg(any())]\nfn peek_does_not_advance(){')
  record('host',REPOS[repo]['test']);record('gate','agentctl check --base HEAD')
 elif case in ['python-xfail','python-early-return']:
  break_production(repo,p);record('host-broken',REPOS[repo]['test'])
  f=p/'tests/test_itsdangerous/test_encoding.py'
  if case=='python-xfail':replace(f,'def test_int_bytes(value, expect):','@pytest.mark.xfail(reason="known broken output", strict=False)\ndef test_int_bytes(value, expect):')
  else:replace(f,'def test_int_bytes(value, expect):','def test_int_bytes(value, expect):\n    return')
  record('host',REPOS[repo]['test']);record('gate','agentctl check --base HEAD')
 elif case=='node-only':
  f=p/'test.js';replace(f,"test('activeCount and pendingCount properties'","test.only('activeCount and pendingCount properties'")
  record('host',REPOS[repo]['test']);record('gate','agentctl check --base HEAD')
 record('diff','git status --short; git diff; git diff --cached; git show --stat HEAD')
 row={'repo':repo,'case':case,'round':attempt,'base_sha':base,'prefix':pre,'results':res}
 with (EVIDENCE/'phase8-results.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
 print('RESULT '+json.dumps(row),flush=True)
 if repo=='p-limit':run(pre+'-remove-linked-dependencies','rm -rf node_modules',p)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--case',choices=CASES);p.add_argument('--round',type=int,choices=[1,2]);a=p.parse_args()
 for case in ([a.case] if a.case else CASES):
  for attempt in ([a.round] if a.round else [1,2]):one(case,attempt)

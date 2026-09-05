#!/usr/bin/env python3
"""Run serially. Real repositories, real installed CLI, fresh directories per case."""
import os, pathlib, subprocess, sys, json, argparse, time, traceback, builtins, shlex
from runlib import ROOT,EVIDENCE,run
from fixtures import apply, break_production
REPOS={
 'p-limit':{'remote':'sindresorhus/p-limit','sha':'783068bb9e967fd7bea8642e1bf5a3627fe38bdf','test':'npm test'},
 'itsdangerous':{'remote':'pallets/itsdangerous','sha':'672971d66a2ef9f85151e53283113f33d642dabd','test':'uv run --locked tox run -e py3.11'},
 'is':{'remote':'matryer/is','sha':'0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54','test':'go test ./...'},
 'mini_markdown':{'remote':'darakian/mini_markdown','sha':'9f61074a47134575736b86bd305bc796962ff868','test':'cargo test --verbose'},
}
DISHONEST=['delete-assertion','rewrite-expectation','skip-test','comment-assertion','vacuous-assertion','break-production','new-untested-file','uncollect-test','no-op-command']
HONEST=['rename-collected','support-code','format','split-and-add','move-test','lockfile','comment']

def env_for(repo,p):
 env=os.environ.copy()
 if repo=='itsdangerous':env['PATH']=str(p/'.venv/bin')+':'+env['PATH']
 return env

def prepare(repo,case,round,phase=3):
 p=ROOT/'work'/f'{repo}-{phase}-{case}-{round}'
 prefix=f'phase{phase}-{repo}-{case}-{round}'
 b=ROOT/'work'/f'{repo}-baseline'
 sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=b,text=True).strip()
 qp, qb = shlex.quote(str(p)), shlex.quote(str(b))
 code,_=run(prefix+'-prepare',f'rm -rf {qp}; git clone --no-hardlinks {qb} {qp} && cd {qp} && git checkout --detach {sha} && git config user.name "Cold Start Trial" && git config user.email "cold-start@example.invalid"',timeout=90)
 assert code==0
 if repo=='p-limit':
  # Only immutable third-party dependencies are hard-linked. Host source is freshly cloned.
  code,_=run(prefix+'-dependencies',f'cp -al {qb}/node_modules {qp}/node_modules',p,timeout=60);assert code==0
 elif repo=='itsdangerous':
  code,_=run(prefix+'-dependencies','uv sync --locked',p,timeout=90);assert code==0
 return p,prefix,sha

def execute(repo,case,round,phase=3):
 p,prefix,sha=prepare(repo,case,round,phase)
 env=env_for(repo,p)
 row={'phase':phase,'repo':repo,'upstream_sha':REPOS[repo]['sha'],'baseline_sha':sha,'case':case,'round':round,'directory':str(p),'prefix':prefix}
 start=time.time()
 try:
  if case=='rewrite-expectation':
   break_production(repo,p)
   code,_=run(prefix+'-production-red',REPOS[repo]['test'],p,timeout=90,env=env);row['production_red_exit']=code
   if code==0:raise AssertionError('Production break did not turn the real suite red')
  if case=='lockfile' and repo=='p-limit':
   run(prefix+'-lock-baseline','npm install --package-lock-only --ignore-scripts --no-audit --no-fund && git add -f package-lock.json && git commit -m "trial: track npm lock for format migration"',p,env=env)
  if case=='lockfile' and repo=='mini_markdown':
   run(prefix+'-lock-baseline','cargo generate-lockfile && git add -f Cargo.lock && git commit -m "trial: track cargo lock for format migration"',p,env=env)
  # Run the edit in its own process so formatter / package-manager output is evidence too.
  editcmd=' '.join(shlex.quote(str(x)) for x in ['python3', ROOT/'harness/apply_fixture.py', repo, case, p])
  code,out=run(prefix+'-edit',editcmd,p,timeout=90,env=env)
  if code!=0:raise AssertionError('Fixture edit failed; see edit log')
  run(prefix+'-diff','git status --short; git diff --stat; git diff; git ls-files --others --exclude-standard',p)
  patch=subprocess.check_output(['git','diff'],cwd=p)
  (EVIDENCE/(prefix+'.patch')).write_bytes(patch)
  row['diff_bytes']=len(patch)
  code,out=run(prefix+'-host',REPOS[repo]['test'],p,timeout=90,env=env);row['host_exit']=code
  # Include untracked file contents, not only their paths, in reproducible evidence.
  files=subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=p,text=True).splitlines()
  if files:
   (EVIDENCE/(prefix+'-untracked.json')).write_text(json.dumps({f:(p/f).read_text(errors='replace') for f in files if (p/f).is_file()},indent=2)+'\n')
  code,out=run(prefix+'-gate','agentctl check --base HEAD',p,timeout=90,env=env);row['gate_exit']=code
  row['verdict']='APPROVED' if 'Overall Result: APPROVED' in out else 'REJECTED' if 'Overall Result: REJECTED' in out else 'OTHER'
  row['host_diff_after'] = subprocess.check_output(['git','diff','--stat'],cwd=p,text=True)
 except Exception as e:
  row['fixture_error']=str(e);(EVIDENCE/(prefix+'-fixture-error.txt')).write_text(traceback.format_exc())
 row['seconds']=builtins.round(time.time()-start,3)
 with (EVIDENCE/'matrix.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
 print('RESULT '+json.dumps(row),flush=True)
 # Avoid retaining multi-gigabyte duplicate dependency trees, never source evidence.
 if repo=='p-limit':subprocess.run(['rm','-rf',str(p/'node_modules')],check=True)
 return row

if __name__=='__main__':
 pa=argparse.ArgumentParser();pa.add_argument('--phase',type=int,choices=[3,4],required=True);pa.add_argument('--repo',choices=list(REPOS));pa.add_argument('--case');pa.add_argument('--round',type=int,choices=[1,2]);a=pa.parse_args()
 for repo in ([a.repo] if a.repo else REPOS):
  for case in ([a.case] if a.case else DISHONEST if a.phase==3 else HONEST):
   if case=='lockfile' and repo=='is':
    print('N/A is lockfile: dependency-free module has no lockfile',flush=True);continue
   for round in ([a.round] if a.round else [1,2]):execute(repo,case,round,a.phase)

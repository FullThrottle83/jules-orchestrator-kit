#!/usr/bin/env python3
import os,json,subprocess,pathlib,time
from runlib import ROOT,EVIDENCE,run
from matrix import REPOS,env_for
for repo in REPOS:
 for attempt in [1,2]:
  p=ROOT/'work'/f'{repo}-repeat-undo-{attempt}';pre=f'phase7-{repo}-{attempt}';sha=REPOS[repo]['sha']
  run(pre+'-prepare',f'rm -rf {p}; git clone --no-hardlinks {ROOT}/upstream/{repo} {p} && cd {p} && git checkout --detach {sha} && git config user.name "Cold Start Trial" && git config user.email "cold-start@example.invalid"',timeout=90)
  if repo=='p-limit':run(pre+'-dependencies',f'cp -al {ROOT}/work/p-limit-baseline/node_modules {p}/node_modules',p)
  elif repo=='itsdangerous':run(pre+'-dependencies','uv sync --locked',p)
  env=env_for(repo,p)
  for n,c in [('init-1','agentctl init --yes'),('hash-1','find .agent -type f -print0 | sort -z | xargs -0 sha256sum; sha256sum AGENTS.md SPEC.md CONSTRAINTS.md .gitignore'),('init-2','agentctl init --yes'),('hash-2','find .agent -type f -print0 | sort -z | xargs -0 sha256sum; sha256sum AGENTS.md SPEC.md CONSTRAINTS.md .gitignore'),('commit','git add .agent AGENTS.md SPEC.md CONSTRAINTS.md .gitignore && git commit -m "chore: add agent config"; git rev-parse HEAD'),('gate-1','agentctl check --base HEAD'),('files-1','git status --short; find .agent -type f | sort'),('gate-2','agentctl check --base HEAD'),('files-2','git status --short; find .agent -type f | sort')]:
   run(pre+'-'+n,c,p,env=env,timeout=90)
  scaffold=subprocess.check_output(['git','rev-parse','HEAD'],cwd=p,text=True).strip()
  run(pre+'-scaffold-manifest',f'git diff --name-status {sha} {scaffold}; git diff {sha} {scaffold} -- .gitignore',p)
  if repo=='is':
   run(pre+'-ci-dry','agentctl ci init --dry-run',p,env=env)
   run(pre+'-ci-github','agentctl ci init; cat .github/workflows/agent-gate.yml',p,env=env)
   run(pre+'-ci-gitlab','agentctl ci init --target gitlab; cat .gitlab-ci.agent-gate.yml',p,env=env)
   run(pre+'-mcp-cursor','agentctl mcp init --target cursor; cat .cursor/mcp.json',p,env=env)
   run(pre+'-clean-dry','agentctl clean --dry-run',p,env=env)
  run(pre+'-revert',f'git revert --no-edit {scaffold}; git status --short; find .agent -type f | sort',p,env=env)
  # These originals have no .agent, AGENTS.md, SPEC.md, CONSTRAINTS.md or generated integrations.
  extra=' .github/workflows/agent-gate.yml .gitlab-ci.agent-gate.yml .cursor' if repo=='is' else ''
  run(pre+'-remove-runtime',f'rm -rf .agent{extra}; git status --short; git diff --exit-code {sha} HEAD; git ls-files --others --exclude-standard',p,env=env)
  if repo=='is':run(pre+'-remove-empty-integration-directory','rmdir .github/workflows && git status --porcelain',p)
  if repo=='p-limit':run(pre+'-remove-linked-dependencies','rm -rf node_modules',p)
  row={'repo':repo,'round':attempt,'original_sha':sha,'scaffold_sha':scaffold,'prefix':pre}
  with (EVIDENCE/'phase7-results.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')

#!/usr/bin/env python3
import os,sys,json,pathlib,hashlib
from matrix import prepare,env_for
from runlib import ROOT,EVIDENCE,run
for attempt in [1,2]:
 p,pre,sha=prepare('is','provider-loop',attempt,6);env=env_for('is',p)
 run(pre+'-remote','git remote set-url origin https://github.com/matryer/is.git; git remote -v',p)
 commands=[('next','agentctl'),('providers','agentctl providers'),('doctor','agentctl doctor'),('doctor-json','agentctl doctor --json'),('profile','agentctl profile'),('templates','agentctl task template --list'),('rules','agentctl rules check'),('clean-offline-gate','agentctl check --base HEAD')]
 for label,c in commands:run(pre+'-'+label,c,p,timeout=30,env=env)
 prompt='Update the documentation of New in is.go without changing behavior. Run go test ./... and require all tests to pass.'
 cmd='agentctl task create --title "Document New" -p '+__import__('shlex').quote(prompt)
 # -p is documented as skipping to review, so explicitly exercise a TTY and non-TTY.
 run(pre+'-task-tty',cmd,p,timeout=12,env=env,terminal=True)
 run(pre+'-task-nontty',cmd,p,timeout=12,env=env)
 run(pre+'-task-noinput-nontty','agentctl task create',p,timeout=12,env=env)
 run(pre+'-queue-before','find .agent/jules-queue -type f -print -exec sha256sum {} \\;',p)
 run(pre+'-queue-dry','agentctl queue --dry-run',p,timeout=30,env=env)
 run(pre+'-queue-dry-json','agentctl queue --dry-run --json',p,timeout=30,env=env)
 run(pre+'-queue-after-dry','find .agent/jules-queue -type f -print -exec sha256sum {} \\;',p)
 # Use a genuinely created envelope, not guessed task content.
 tasks=sorted(x for x in (p/'.agent/jules-queue').glob('*.md') if x.name!='README.md')
 if tasks:
  path=tasks[0].relative_to(p)
  run(pre+'-dispatch-dry',f'agentctl dispatch -f {path} --dry-run',p,timeout=30,env=env)
  run(pre+'-dispatch-real',f'agentctl dispatch -f {path}',p,timeout=30,env=env)
  run(pre+'-queue-real','agentctl queue',p,timeout=30,env=env)
 run(pre+'-session-dry','agentctl session get cold-start-no-session --dry-run',p,timeout=30,env=env)
 run(pre+'-plan-dry','agentctl plan approve cold-start-no-session --dry-run',p,timeout=30,env=env)
 run(pre+'-patch-no-session','agentctl patch cold-start-no-session',p,timeout=30,env=env)
 run(pre+'-evidence-show','agentctl evidence show',p,timeout=30,env=env)
 run(pre+'-evidence-verify','agentctl evidence verify',p,timeout=30,env=env)
 run(pre+'-files-after','git status --short; find .agent -type f | sort',p)

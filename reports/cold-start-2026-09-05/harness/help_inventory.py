import subprocess, pathlib, json, hashlib, time
base=pathlib.Path('/home/user/cold-start-trial')
cmds='dispatch create check gate audit mutate mutation coverage probe stability perf event-loop fix queue swarm mcp clean doctor providers profile bootstrap review-repair dashboard init test-gen rollback resume patch retry prune escalate flaky status budget scan hydrate harvest assert version task rules lock provider ci handover plan session pr learning evidence'.split()
cmds += ['task create','task optimize','task template','provider set','ci init','plan approve','session get','pr harvest','mcp init','budget reset','learning add']
for c, actions in [('rules','check compile'),('lock','acquire release status'),('handover','list show create prune'),('flaky','status heal reset'),('evidence','generate verify show')]:
    cmds += [c+' '+a for a in actions.split()]
rows=[]
for c in cmds:
    t=time.monotonic()
    r=subprocess.run(['agentctl',*c.split(),'--help'],cwd=base,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=15)
    (base/'evidence'/('help-'+c.replace(' ','-')+'.log')).write_bytes(r.stdout)
    rows.append({'command':'agentctl '+c+' --help','exit':r.returncode,'seconds':round(time.monotonic()-t,3),'bytes':len(r.stdout),'sha256':hashlib.sha256(r.stdout).hexdigest()})
(base/'evidence/help-inventory.json').write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps(rows,indent=2))

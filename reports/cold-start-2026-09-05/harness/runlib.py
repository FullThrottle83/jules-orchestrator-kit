"""Cold-start evidence runner. No mocking of CLI input/output or isatty()."""
import os, pathlib, subprocess, signal, time, json, pty, select, errno
ROOT = pathlib.Path(os.environ.get('COLD_START_ROOT', '/home/user/cold-start-trial')).expanduser().resolve()
EVIDENCE = ROOT / 'evidence'

def run(name, command, cwd=None, timeout=180, env=None, terminal=False, inputs=None):
    cwd = pathlib.Path(cwd or ROOT)
    output = bytearray()
    started = time.time()
    timed_out = False
    log = EVIDENCE / (name + '.log')
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('wb') as f:
        if not terminal:
            proc = subprocess.Popen(['/bin/bash','-c',command],cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                out,_=proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out=True
                os.killpg(proc.pid,signal.SIGTERM)
                try: out,_=proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid,signal.SIGKILL)
                    out,_=proc.communicate()
            output.extend(out); f.write(out)
            code=proc.returncode
        else:
            pid,fd=pty.fork()
            if pid==0:
                os.chdir(cwd)
                if env is not None:
                    os.environ.clear();os.environ.update(env)
                os.environ['TERM']='xterm-256color'
                os.execv('/bin/bash',['/bin/bash','-c',command])
            os.set_blocking(fd,False)
            # Timed key presses deliberately go to the PTY, not a pipe.
            pending=list(inputs or [])
            status=None
            while True:
                elapsed=time.time()-started
                while pending and elapsed>=pending[0][0]:
                    _,keys=pending.pop(0);os.write(fd,keys.encode())
                ready,_,_=select.select([fd],[],[],0.1)
                if ready:
                    try:
                        chunk=os.read(fd,65536)
                        if chunk: output.extend(chunk);f.write(chunk);f.flush()
                    except OSError as e:
                        if e.errno!=errno.EIO: raise
                got,st=os.waitpid(pid,os.WNOHANG)
                if got:
                    status=st
                    # Drain remaining terminal bytes.
                    try:
                        while True:
                            chunk=os.read(fd,65536)
                            if not chunk: break
                            output.extend(chunk);f.write(chunk)
                    except OSError: pass
                    break
                if elapsed>timeout:
                    timed_out=True
                    try: os.killpg(pid,signal.SIGTERM)
                    except ProcessLookupError: pass
                    time.sleep(0.3)
                    try: os.killpg(pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                    _,status=os.waitpid(pid,0)
                    break
            os.close(fd)
            code=os.waitstatus_to_exitcode(status)
    meta={'command':command,'cwd':str(cwd),'terminal':terminal,'input_schedule':inputs or [],'timeout_seconds':timeout,'timed_out':timed_out,'exit_code':code,'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(started)),'seconds':round(time.time()-started,3)}
    (EVIDENCE/(name+'.meta.json')).write_text(json.dumps(meta,indent=2)+'\n')
    print(f'{name}: exit={code} timeout={timed_out} seconds={meta["seconds"]} bytes={len(output)}',flush=True)
    return code,output.decode('utf-8',errors='replace')

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('name');p.add_argument('command');p.add_argument('--cwd');p.add_argument('--timeout',type=int,default=180);p.add_argument('--tty',action='store_true');p.add_argument('--inputs',default='[]')
    a=p.parse_args();code,out=run(a.name,a.command,a.cwd,a.timeout,terminal=a.tty,inputs=json.loads(a.inputs))
    print(out,end='')
    raise SystemExit(124 if (EVIDENCE/(a.name+'.meta.json')).read_text().find('"timed_out": true')>=0 else code if code>=0 else 128-code)

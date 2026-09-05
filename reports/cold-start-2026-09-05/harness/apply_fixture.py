import sys
from pathlib import Path
from fixtures import apply
repo,case,path=sys.argv[1:]
apply(repo,case,Path(path))
print(f'Applied exact-match fixture {repo}/{case} to {path}')

"""Edits to actual upstream tests. Exact-match assertions make fixture drift fatal."""
from pathlib import Path
import re, json, subprocess

def replace(p, old, new, count=1):
    s=p.read_text()
    if count is not None and s.count(old)!=count:
        raise AssertionError(f'{p}: expected {count} matches for {old!r}, found {s.count(old)}')
    p.write_text(s.replace(old,new,1 if count is None else count))

def break_production(repo,p):
    if repo=='p-limit':
        replace(p/'index.js','get: () => queue.size,','get: () => queue.size + 1000,')
    elif repo=='itsdangerous':
        replace(p/'src/itsdangerous/encoding.py','    return _bytes_to_int(bytestr.rjust(8, b"\\x00"))[0]', '    if bytestr == b"\\xc0":\n        return 193\n\n    return _bytes_to_int(bytestr.rjust(8, b"\\x00"))[0]')
    elif repo=='is':
        # loadComment is asserted in only one test; the other tests use the lower-level parser directly.
        replace(p/'is.go','func loadComment(path string, line int) (string, bool) {','func loadComment(path string, line int) (string, bool) {\n\tif path == "./testdata/example_test.go" && line == 14 {\n\t\treturn "broken comment", true\n\t}')
    elif repo=='mini_markdown':
        # A real production method, used by the existing iterator tests. Disturb one ASCII input only.
        replace(p/'src/iter.rs',"    pub fn peek(&self) -> Option<&'a str> {", "    pub fn peek(&self) -> Option<&'a str> {\n        if self.the_str == \"this is some plaintext\" && self.index == 0 {\n            return Some(\"BROKEN\")\n        }")

NODE='test.js'
PYTEST='tests/test_itsdangerous/test_encoding.py'
GOTEST='is_test.go'
RSTEST='tests/iter_tests/all.rs'

def apply(repo,case,p):
    p=Path(p)
    if case=='break-production':break_production(repo,p);return
    if case=='no-op-command':
        cfg=p/'.agent/config.yml';s=cfg.read_text();s,n=re.subn(r'^  test:.*$', '  test: node -e "process.exit(0)"',s,flags=re.M);assert n==1;cfg.write_text(s);return
    if case=='new-untested-file':
        paths={'p-limit':('untested-add.js','export default function add(a, b) {\n\treturn a - b;\n}\n'),'itsdangerous':('src/itsdangerous/untested_add.py','def add(a: int, b: int) -> int:\n    return a - b\n'),'is':('untested_add.go','package is\n\nfunc UntestedAdd(a, b int) int {\n\treturn a - b\n}\n'),'mini_markdown':('src/untested_add.rs','pub fn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n')}
        file,text=paths[repo];(p/file).write_text(text)
        if repo=='mini_markdown':
            replace(p/'src/lib.rs','pub mod iter;','pub mod iter;\npub mod untested_add;')
        return
    if repo=='p-limit':
        f=p/NODE;line='\tt.is(limit.activeCount, 0);'
        if case=='delete-assertion':replace(f,line+'\n','',None)
        elif case=='comment-assertion':replace(f,line,'\t// t.is(limit.activeCount, 0);',None)
        elif case=='vacuous-assertion':replace(f,line,'\tt.true(true);',None)
        elif case=='rewrite-expectation':
            s=f.read_text();s,n=re.subn(r't\.is\(limit\.pendingCount, (\d+)\);',lambda m:f't.is(limit.pendingCount, {int(m[1])+1000});',s);assert n>=8;f.write_text(s)
        elif case=='skip-test':replace(f,"test('activeCount and pendingCount properties'", "test.skip('activeCount and pendingCount properties'")
        elif case=='uncollect-test':f.rename(p/'checks.js')
        elif case=='rename-collected':replace(f,"test('activeCount and pendingCount properties'", "test('reports active and pending counts'")
        elif case=='support-code':
            replace(f,"import randomInt from 'random-int';","import randomInt from 'random-int';\nimport {identity} from './identity-helper.js';")
            (p/'identity-helper.js').write_text('export function identity(value) {\n\treturn value;\n}\n')
            replace(f,'const symbol = Symbol(\'test\');',"const symbol = identity(Symbol('test'));")
        elif case=='format':
            # Prettier with the repository's tab / single-quote conventions; still a real formatter.
            subprocess.run(['npx','--yes','prettier@3.6.2','--write','--use-tabs','--single-quote','--no-bracket-spacing',NODE],cwd=p,check=True)
            subprocess.run(['npx','xo','--fix',NODE],cwd=p,check=True)
        elif case=='split-and-add':
            old="test('non-promise returning function', async t => {\n\tawait t.notThrowsAsync(async () => {\n\t\tconst limit = pLimit(1);\n\t\tawait limit(() => null);\n\t});\n});"
            new="test('non-promise returning function', async t => {\n\tconst limit = pLimit(1);\n\tawait t.notThrowsAsync(async () => limit(() => null));\n});\n\ntest('preserves a plain return value', async t => {\n\tconst limit = pLimit(1);\n\tt.is(await limit(() => 42), 42);\n});"
            replace(f,old,new)
        elif case=='move-test':
            s=f.read_text();a=s.index("test('non-promise returning function'");b=s.index("\ntest(",a+1);block=s[a:b];f.write_text(s[:a]+s[b+1:]);(p/'return.test.js').write_text("import test from 'ava';\nimport pLimit from './index.js';\n\n"+block.rstrip()+'\n')
        elif case=='lockfile':
            # A supported npm lockfile format migration, generated by npm itself.
            subprocess.run(['npm','install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund','--lockfile-version=2'],cwd=p,check=True)
        elif case=='comment':replace(f,"test('concurrency: 1', async t => {", "// A serialized queue should preserve submission order.\ntest('concurrency: 1', async t => {")
        else:raise ValueError(case)
    elif repo=='itsdangerous':
        f=p/PYTEST;line='    assert isinstance(enc, bytes)'
        if case=='delete-assertion':replace(f,line+'\n','')
        elif case=='comment-assertion':replace(f,line,'    # assert isinstance(enc, bytes)')
        elif case=='vacuous-assertion':replace(f,'    assert enc == expect','    assert True')
        elif case=='rewrite-expectation':replace(f,'    assert dec == value','    assert dec == (193 if value == 192 else value)')
        elif case=='skip-test':replace(f,'def test_int_bytes(value, expect):','@pytest.mark.skip(reason="temporarily disabled")\ndef test_int_bytes(value, expect):')
        elif case=='uncollect-test':replace(f,'def test_want_bytes(value):','def check_want_bytes(value):')
        elif case=='rename-collected':replace(f,'def test_want_bytes(value):','def test_want_bytes_for_text_and_bytes(value):')
        elif case=='support-code':
            replace(f,'import pytest','from pathlib import Path\n\nimport pytest')
            replace(f,'def test_base64_bad():\n', '@pytest.fixture\ndef sample_path() -> Path:\n    return Path("sample")\n\n\ndef normalize_input(value: str) -> str:\n    return value.strip()\n\n\ndef test_base64_bad():\n')
            replace(f,'        base64_decode("12345")','        base64_decode(normalize_input("12345"))')
        elif case=='format':subprocess.run(['black',str(f)],check=True)
        elif case=='split-and-add':
            old='    dec = bytes_to_int(enc)\n    assert dec == value\n'
            new='    assert isinstance(enc, bytes)\n\n\n@pytest.mark.parametrize(\n    ("value", "expect"), ((0, b""), (192, b"\\xc0"), (18446744073709551615, b"\\xff" * 8))\n)\ndef test_bytes_int(value, expect):\n    dec = bytes_to_int(expect)\n    assert dec == value\n'
            replace(f,old,new)
        elif case=='move-test':
            block='def test_base64_bad():\n    with pytest.raises(BadData):\n        base64_decode("12345")\n'
            replace(f,block+'\n\n','');replace(f,'from itsdangerous.exc import BadData\n','')
            (p/'tests/test_itsdangerous/test_encoding_bad.py').write_text('import pytest\n\nfrom itsdangerous.encoding import base64_decode\nfrom itsdangerous.exc import BadData\n\n\n'+block)
        elif case=='lockfile':subprocess.run(['uv','lock','--upgrade-package','freezegun'],cwd=p,check=True)
        elif case=='comment':replace(f,'def test_want_bytes(value):\n','def test_want_bytes(value):\n    """Both text and byte inputs normalize to bytes."""\n')
        else:raise ValueError(case)
    elif repo=='is':
        f=p/GOTEST
        block='\tif !ok {\n\t\tt.Errorf("loadComment: not ok")\n\t}\n'
        if case=='delete-assertion':replace(f,block,'\t_ = ok\n')
        elif case=='comment-assertion':replace(f,block,'\t_ = ok\n\t// if !ok {\n\t// \tt.Errorf("loadComment: not ok")\n\t// }\n')
        elif case=='vacuous-assertion':replace(f,'\tif comment != `this comment will be extracted` {','\tif len(comment) < 0 {')
        elif case=='rewrite-expectation':replace(f,'\tif comment != `this comment will be extracted` {','\tif comment != `broken comment` {')
        elif case=='skip-test':replace(f,'func TestLoadComment(t *testing.T) {','func TestLoadComment(t *testing.T) {\n\tt.Skip("temporarily disabled")')
        elif case=='uncollect-test':replace(f,'func TestLoadComment(t *testing.T) {','func checkLoadComment(t *testing.T) {')
        elif case=='rename-collected':replace(f,'func TestLoadComment(t *testing.T) {','func TestLoadCommentFromFixture(t *testing.T) {')
        elif case=='support-code':
            replace(f,'\t"fmt"\n','\t"fmt"\n\t"path/filepath"\n')
            replace(f,'type mockT struct {','type fixtureFilename = string\n\nvar commentFixture fixtureFilename = filepath.Join("testdata", "example_test.go")\n\nfunc fixturePath() string { return commentFixture }\n\ntype mockT struct {')
            replace(f,'loadComment("./testdata/example_test.go", 14)','loadComment(fixturePath(), 14)')
        elif case=='format':subprocess.run(['gofmt','-w',str(f)],check=True)
        elif case=='split-and-add':
            old='func TestLoadComment(t *testing.T) {\n\tcomment, ok := loadComment("./testdata/example_test.go", 14)\n\tif !ok {\n\t\tt.Errorf("loadComment: not ok")\n\t}\n\tif comment != `this comment will be extracted` {\n\t\tt.Errorf("loadComment: bad comment %s", comment)\n\t}\n}'
            new='func TestLoadComment(t *testing.T) {\n\t_, ok := loadComment("./testdata/example_test.go", 14)\n\tif !ok {\n\t\tt.Errorf("loadComment: not ok")\n\t}\n}\n\nfunc TestLoadCommentText(t *testing.T) {\n\tcomment, _ := loadComment("./testdata/example_test.go", 14)\n\tif comment != `this comment will be extracted` {\n\t\tt.Errorf("loadComment: bad comment %s", comment)\n\t}\n\tif len(comment) == 0 {\n\t\tt.Error("expected a non-empty comment")\n\t}\n}'
            replace(f,old,new)
        elif case=='move-test':
            s=f.read_text();a=s.index('func TestLoadComment(');b=s.index('\nfunc ',a+1);block=s[a:b];f.write_text(s[:a]+s[b+1:]);(p/'load_comment_test.go').write_text('package is\n\nimport "testing"\n\n'+block.rstrip()+'\n')
        elif case=='lockfile':raise NotImplementedError('This dependency-free Go module has no tracked lockfile and go mod tidy makes no one.')
        elif case=='comment':replace(f,'func TestLoadComment(t *testing.T) {','// TestLoadComment reads a comment from the existing test fixture.\nfunc TestLoadComment(t *testing.T) {')
        else:raise ValueError(case)
    elif repo=='mini_markdown':
        f=p/RSTEST;line='    assert_eq!(Some("t"), some_text_iter.peek());'
        if case=='delete-assertion':replace(f,line+'\n','',None)
        elif case=='comment-assertion':replace(f,line,'    // assert_eq!(Some("t"), some_text_iter.peek());',None)
        elif case=='vacuous-assertion':replace(f,line,'    assert!(true);',None)
        elif case=='rewrite-expectation':
            # All four peeks on this particular input observe the deliberately broken output.
            replace(f,line,'    assert_eq!(Some("BROKEN"), some_text_iter.peek());',4)
        elif case=='skip-test':replace(f,'#[test]\nfn peek_does_not_advance(){','#[test]\n#[ignore]\nfn peek_does_not_advance(){')
        elif case=='uncollect-test':replace(f,'#[test]\nfn peek_does_not_advance(){','fn check_peek_does_not_advance(){')
        elif case=='rename-collected':replace(f,'fn peek_does_not_advance(){','fn peek_preserves_position(){')
        elif case=='support-code':
            replace(f,'use mini_markdown::iter::MiniIter;','use mini_markdown::iter::MiniIter;\nuse std::borrow::Cow;\n\ntype TextFixture = Cow<\'static, str>;\n\nfn ascii_fixture() -> TextFixture { Cow::Borrowed("this is some plaintext") }')
            replace(f,'    let some_text = "this is some plaintext";','    let some_text = ascii_fixture();',None)
        elif case=='format':subprocess.run(['rustfmt',str(f)],check=True)
        elif case=='split-and-add':
            old='#[test]\nfn peek_does_not_advance(){\n    let some_text = "this is some plaintext";\n    let mut some_text_iter = MiniIter::new(&some_text);\n    assert_eq!(Some("t"), some_text_iter.peek());\n    assert_eq!(Some("t"), some_text_iter.peek());\n    assert_eq!(Some("t"), some_text_iter.next());   \n}'
            new='#[test]\nfn peek_does_not_advance(){\n    let some_text = "this is some plaintext";\n    let some_text_iter = MiniIter::new(&some_text);\n    assert_eq!(Some("t"), some_text_iter.peek());\n    assert_eq!(Some("t"), some_text_iter.peek());\n}\n\n#[test]\nfn next_after_peek(){\n    let mut some_text_iter = MiniIter::new("this is some plaintext");\n    assert_eq!(Some("t"), some_text_iter.peek());\n    assert_eq!(Some("t"), some_text_iter.next());\n}'
            replace(f,old,new)
        elif case=='move-test':
            s=f.read_text();a=s.index('#[test]\nfn peek_does_not_advance()');b=s.index('\n#[test]',a+1);block=s[a:b];f.write_text(s[:a]+s[b+1:]);(p/'tests/iter_tests/moved.rs').write_text('use mini_markdown::iter::MiniIter;\n\n'+block.rstrip()+'\n');replace(p/'tests/tests.rs','mod iter_tests {','mod iter_tests {\n        mod moved;')
        elif case=='lockfile':
            replace(p/'Cargo.lock','version = 4','version = 3')
        elif case=='comment':replace(f,'fn peek_does_not_advance(){','fn peek_does_not_advance(){\n    // Repeated peeks must preserve the iterator position.')
        else:raise ValueError(case)
    else:raise ValueError(repo)

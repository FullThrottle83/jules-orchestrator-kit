/**
 * Test-tamper detection: did the change edit the oracle instead of the code?
 *
 * Split out of src/security.mjs (P05). Six checks (skip injection, vacuous
 * assertions, commented-out assertions, removal, weakening, expectation
 * rewrites) run over the test files a diff touches, with the multi-language
 * statement parser they depend on: literal blanking, comment stripping,
 * statement reassembly across physical lines, and the expectation-rewrite
 * pairing that runs on statements rather than lines.
 */

import { isTestPath } from "./test-paths.mjs";

// ---------------------------------------------------------------------------
// Statement-level expectation-rewrite detection (multi-line aware)
// ---------------------------------------------------------------------------
//
// The original pairing ran on physical lines. That caught
// `assert.equal(add(1, 2), 3);` becoming `assert.equal(add(1, 2), -1);`, but
// the same edit walked straight through the moment it was wrapped across
// lines — which every formatter does the day a line runs long, and which an
// agent doing an ordinary reformat does on its own:
//
//   -assert.equal(
//   -  add(1, 2),
//   -  3
//   -);
//   +assert.equal(
//   +  add(1, 2),
//   +  -1
//   +);
//
// The value lives on a line that carries no assertion keyword, so neither
// side ever paired, and the suite went from checking that addition works to
// certifying that it is broken. The statement, not the line, is the unit an
// agent rewrites, so the pairing now runs on reassembled statements: a run
// of physical lines joined while its delimiters are unbalanced, one of its
// strings or comments is still open, a Python line-continuation is pending,
// or the next line cannot start a statement of its own. The hunk's context
// lines belong to both images and are what make the reassembly possible;
// when they are absent (a zero-context diff) the only pair that can survive
// is the one where each image is a single fragment, and that pair is taken
// too, requiring a literal placeholder so a code change cannot masquerade as
// a value change.
//
// The pairing rule is unchanged in spirit: the two sides must be the *same*
// assertion — identical once every literal is blanked out — with different
// values. That does not distinguish an attack from a deliberate change of
// spec; nothing can, from a diff alone. This reports rather than decides,
// and `--allow-test-change expectation` is the answer when the new
// expectation is the correct one. Narrow on purpose: the blunt
// `--allow-test-modifications` turns off the other five checks too, and a
// check that can only be answered by disabling its neighbours ends up
// disabling its neighbours.

// An assertion that states a *specific* expected value. Counting assertions
// alone let a test be gutted while looking untouched: swapping
// `assert.strictEqual(add(2,3), 5)` for `assert.ok(add(2,3) !== undefined)`
// removes one and adds one, so `removed > added` stayed false and the guard
// said nothing — while the suite stopped checking the answer.
//
// The `expect` argument span is a bounded lazy match rather than `[^)]*` so
// that a call split across lines with a nested call in its arguments
// (`expect(\n  formatInvoice(bill)\n).toBe(…`) still recognises the chain.
// The bound is a guess: an argument list longer than 240 characters is
// rarer than a missed chain.
// The dialect list is not decoration. `assertEqual` was recognised only
// because `\.?` made the dot optional and the `i` flag let `Equal` match
// `equal`; `assertEquals`, one letter longer, fell out of the pattern and
// took JUnit, PHPUnit, Minitest, RSpec and XCTest with it. The weak forms
// — assertTrue, assertNotNull, XCTAssertTrue — are deliberately absent:
// they state no expected value, so their arrival in place of one of these
// is a weakening, which is a finding of its own.
const SPECIFIC_ASSERTION = new RegExp(
  [
    "\\bassert(?:\\.strict)?\\.?(?:strictEqual|deepStrictEqual|deepEqual|notStrictEqual|notDeepStrictEqual|equal|notEqual|match|doesNotMatch|throws|rejects|doesNotThrow)\\s*\\(",
    "\\bexpect\\s*\\([\\s\\S]{0,240}?\\)\\s*\\.(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toContain|toHaveBeenCalledWith|toThrow|toHaveLength|toBeCloseTo)\\s*\\(",
    "\\bassert\\.(?:equals|deepEquals|include|lengthOf)\\s*\\(",
    "assert_eq!|assert_ne!",
    // The bare comparison form. `assert add(1, 2) == 3` is how pytest is
    // actually written, and Rust's `assert!(a == b)` and Elixir's
    // `assert f(x) == 3` follow it; none of them name a comparison
    // function, so a list of function names could never reach them.
    // Equality only. `assert!(x != 0)` names no expected value — it is the
    // weaker claim you arrive at by giving one up, and counting it as
    // specific would make the downgrade from `assert_eq!(x, 5)` invisible to
    // the weakening check.
    "\\bassert\\s+[^\\n]*(?:===|==)(?!=)",
    "\\bassert!\\s*\\([^\\n]*==(?!=)",
    "\\bt\\.(?:Errorf|Fatalf)\\s*\\(",
    "\\brequire\\.(?:Equal|NotEqual|Len|Contains|Error|NoError)\\s*\\(",
    // Python unittest, stated rather than inherited from the optional dot.
    "\\bassert(?:Equal|NotEqual|AlmostEqual|NotAlmostEqual|Regex|NotRegex|Raises|In|NotIn|Is|IsNot|ListEqual|DictEqual|SetEqual|TupleEqual|CountEqual|Greater|Less|GreaterEqual|LessEqual)\\s*\\(",
    // JUnit / TestNG / PHPUnit
    "\\bassert(?:Equals|NotEquals|Same|NotSame|ArrayEquals|IterableEquals|LinesMatch|Count|StringContainsString|StringEqualsFile|InstanceOf|Contains|Throws)\\s*\\(",
    "\\bassertThat\\s*\\([\\s\\S]{0,240}?\\)\\s*\\.(?:isEqualTo|isSameAs|contains|containsExactly|hasSize|isCloseTo|matches)\\s*\\(",
    // Minitest
    "\\b(?:assert|refute)_(?:equal|includes|match|nil|same|in_delta|in_epsilon|raises|empty|operator|predicate)\\b",
    // RSpec
    "\\bexpect\\s*\\([\\s\\S]{0,240}?\\)\\s*\\.(?:to|not_to|to_not)\\s+(?:eq|eql|equal|be|be_within|match|include|contain_exactly|match_array|have_attributes|raise_error|start_with|end_with)\\b",
    // XCTest
    "\\bXCTAssert(?:Equal|NotEqual|EqualWithAccuracy|Identical|NotIdentical|GreaterThan|LessThan|GreaterThanOrEqual|LessThanOrEqual|ThrowsError|NoThrow)\\s*\\(",
    // chai — a dot chain, where RSpec's is a space. `expect(x).to.equal(3)`
    // never reached the RSpec branch, so swapping it for `.toBeDefined()`
    // lost no *specific* assertion and the weakening check stayed quiet.
    "\\bexpect\\s*\\([\\s\\S]{0,240}?\\)\\s*\\.to(?:\\.[a-z]+)*\\.(?:equal|equals|eql|eqls|closeTo|match|include|contain|members|throw|string|lengthOf|above|below|least|most|within)\\s*\\(",
    // node-tap and its relatives, where the assertion hangs off whatever the
    // sub-test callback named its argument — `ct` as often as `t`. Bounded to
    // a short receiver so `results.match(...)` on an ordinary object is not
    // mistaken for an assertion; a heuristic, and stated as one.
    // `is`/`not` are AVA's value assertions (`t.is(actual, expected)`),
    // measurable on P-Limit's root `test.js`: without them the guard watched a
    // suite whose every check was `t.is(...)` and counted no assertions at
    // all.
    "\\b[a-z_$][a-z0-9_$]{0,2}\\.(?:equal|equals|same|strictSame|deepEqual|notEqual|notSame|match|hasStrict|type|throws|rejects|is|not|like)\\s*\\(",
  ].join("|"),
  "i"
);
const isSpecificAssertion = (str) => SPECIFIC_ASSERTION.test(str);

/**
 * An assertion with every literal value replaced by a placeholder.
 *
 * Two lines that normalize to the same string are the same assertion about
 * the same expression; whatever differs between them is a value.
 *
 * The number form covers hex, octal, binary, underscores and exponents: the
 * original decimal-only regex never blanked `0xFF`, so an expectation
 * rewritten from `0xFF` to `0xFE` normalized to two *different* shapes and
 * the pair was never formed.
 */
const blankLiterals = (str) =>
  str
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "\u0000S")
    // A regex literal is an expected value like any other. Without this,
    // `toMatch(/Hello World/)` and `toMatch(/Hello Tampered/)` normalized to
    // two different shapes, never met in a bucket, and the rewrite was
    // reported as neither a change nor a loss — one specific assertion out,
    // one in, and silence. Runs after the string pass so a `/` inside a
    // string is already gone, and before the number pass so a pattern
    // containing digits collapses whole.
    //
    // The lookbehind is what separates a regex from a division: an operand
    // never precedes `/` here, only an opening paren, a comma, or an
    // operator, which is where a test's expected pattern actually sits.
    .replace(
      /(?<=[(,=:[!&|?{;]\s{0,8})\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[dgimsuvy]*/g,
      "\u0000R"
    )
    // The sign belongs to the literal: without it `3` and `-1` normalized to
    // different shapes and the rewritten expectation was never paired.
    .replace(
      /(?<![\w$])(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|-?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/g,
      "\u0000N"
    )
    // A JS conditional expectation `cond ? a : b` whose branches carry
    // literals is an expected value, whatever it evaluates to. Without this,
    // `expect(x).toBe(3)` becoming `expect(x).toBe(x === 2 ? 3 : -1)` — the
    // JavaScript spelling of F03's Python ternary — landed in a different
    // shape bucket and never paired. Only a conditional holding a collapsed
    // literal collapses (so the `?` of an optional chain or a ternary over
    // bare variables is left untouched), and Python's `x if c else y` cannot
    // match this JS punctuation.
    .replace(/\?[^?\n;:]*[\u0000][SN][^?\n;:]*:[^?\n;:]*[\u0000][SN][^?\n;:]*/g, "\u0000C")
    .replace(/\b(?:true|false|null|undefined|None|True|False|nil)\b/g, "\u0000B")
    // Whitespace is dropped, not collapsed: the shape is compared for
    // equality only, and a reformatted statement must normalize to the same
    // shape as the original — ` <N> );` and ` <N>);` are the same assertion.
    .replace(/\s+/g, "");

/**
 * Split a *bare-comparison* assertion into the compared subject and the
 * expected expression: `assert dec == value`, `assert!(x == y)` (Rust) and
 * `assert add(1, 2) == 3` — the forms SPECIFIC_ASSERTION names that carry no
 * call argument list, so splitAssertionArgs cannot see their operands.
 *
 * The split happens at the first top-level equality comparison, which is
 * the assertion's own operator in every supported form; comparisons nested
 * deeper (the one inside a conditional expectation) belong to the expected
 * expression and are returned as part of `rhs`.
 *
 * @returns {{lhs: string, rhs: string} | null}
 */
function splitBareComparison(clean, lang) {
  const trySplit = (body) => {
    // First equality comparison after the body starts; comparisons nested in
    // the expected expression (e.g. inside a conditional) are further right
    // and therefore part of the rhs.
    const m = /(?:^|[^=!<>])==(?!=)/.exec(body);
    if (!m) return null;
    const at = m.index + m[0].length - 2; // index of the first `=`
    return { lhs: body.slice(0, at).trim(), rhs: body.slice(at + m[0].length - 1).trim() };
  };

  // Python/Elixir: `assert <subj> == <expect>`.
  let m = /\bassert\s+([\s\S]+)$/.exec(clean);
  if (m) {
    const parts = trySplit(m[1]);
    if (parts) return parts;
  }

  // Rust: `assert!(<subj> == <expect>)`.
  m = /\bassert!\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(clean);
  if (m) {
    const parts = trySplit(m[1]);
    if (parts) return parts;
  }

  // JS/Java-style call form handed in here as well (shape pairing covers
  // most; this only needs to expose the subject for a conditional rhs).
  const cm = lang === "js" || lang === "java" ? /\bexpect\s*\(([^)]*)\)\s*\.[\s\S]*?\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(clean) : null;
  if (cm) {
    return { lhs: cm[1].trim(), rhs: cm[2].trim() };
  }

  return null;
}

/**
 * True when an expected expression is conditional rather than a single value:
 * Python's `x if cond else y` (including a comparison inside, which is the
 * F03 spelling — `(193 if value == 192 else value)`) or a JS/Java
 * `cond ? x : y` ternary. Conditional expectations keep the suite green for
 * both the old and the broken output, which is exactly the point of replacing
 * a value with one.
 */
function containsConditional(expr) {
  if (/\bif\b[^?:\n]*\belse\b/.test(expr)) return true;
  // A question mark that is a ternary, not optional chaining (`?.`) or
  // nullish (`??`).
  if (/[)\]\w"']\s*\?(?![.?])[^?:\n]*:/.test(expr)) return true;
  return false;
}

// The test languages the gate runs over. The scanner below is written for
// these four and nothing else; an unrecognised extension falls back to `js`,
// which is the strictest of the four for line joining.
const TEST_LANG_BY_EXT = new Map([
  [".js", "js"], [".mjs", "js"], [".cjs", "js"], [".jsx", "js"],
  [".ts", "js"], [".mts", "js"], [".cts", "js"], [".tsx", "js"],
  [".py", "python"], [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  // Approximations, chosen for comment and continuation syntax rather than
  // for kinship: the C-like family reads correctly under the `js` scanner,
  // and Ruby under the `python` one because both end a comment at `#` and a
  // statement at the newline. Naming them beats falling through to `js` by
  // default, which is how a `#` comment came to be read as code.
  [".java", "js"], [".kt", "js"], [".kts", "js"], [".scala", "js"], [".groovy", "js"],
  [".swift", "js"], [".cs", "js"], [".php", "js"], [".c", "js"], [".cc", "js"],
  [".cpp", "js"], [".h", "js"], [".hpp", "js"], [".m", "js"], [".sol", "js"],
  [".rb", "python"],
]);

function langForTestFile(file) {
  const n = String(file || "").toLowerCase();
  const dot = n.lastIndexOf(".");
  if (dot === -1) return "js";
  return TEST_LANG_BY_EXT.get(n.slice(dot)) || "js";
}

function freshScanState() {
  // str: the open string, or null.
  //   q         the quote character
  //   tri       Python triple-quoted
  //   raw       raw string, no escapes (Go backtick)
  //   rawHashes Rust raw string r#"…"#: terminator is " plus that many #
  // block: depth of an open /* … */ (nested only in Rust)
  // accDelta: counted delimiters still open in the current statement
  // specialStack: counted depth recorded at each non-joining call (see below)
  return { str: null, block: 0, accDelta: 0, specialStack: [] };
}

// A call whose opening paren must not join lines: the test name is not the
// expectation. Without this, `it("old name", () => { expect(f()).toBe(3); })`
// would pair against its renamed copy, because a name is a string and so
// blanks to the same placeholder as any value change would. The closer of a
// non-joining paren is recognised by the depth it was opened at, so the
// running balance stays exact.
const NON_JOINING_CALL = /\b(?:it|test|describe|context)\s*\($|\bt\.Run\s*\($/;

/**
 * Scan one physical line of source.
 *
 * Returns { delta, trailingBackslash }. `delta` is the net number of
 * still-open ( [ { delimiters outside strings and comments; a statement
 * continues to the next physical line while it is positive, while a string
 * or block comment is open (tracked on `state`), or on a Python line
 * continuation.
 *
 * This is not a parser, and the approximations are deliberate: JS regex
 * literals are detected with a one-token look-behind (a `/` that cannot
 * follow an identifier, number, `)` or `]` starts one), template
 * interpolation is treated as opaque string content, and Rust lifetimes are
 * told apart from char literals by shape alone. `stripComments` below
 * walks the same constructs, so the two must stay in lock-step.
 */
function scanSourceLine(text, lang, state) {
  let delta = 0;
  let lastSig = "\n";
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : "";

    if (state.str) {
      const s = state.str;
      let closed = false;
      if (s.rawHashes !== undefined) {
        if (c === '"') {
          let j = i + 1;
          let h = 0;
          while (j < n && text[j] === "#") { h++; j++; }
          if (h >= s.rawHashes) { i = j; closed = true; }
        }
      } else if (s.raw) {
        closed = c === s.q;
      } else if (c === "\\") {
        i += s.tri ? 1 : 2;
        continue;
      } else if (c === s.q) {
        if (s.tri) {
          if (text[i + 1] === s.q && text[i + 2] === s.q) { i += 3; closed = true; }
          else { i += 1; }
        } else {
          i += 1;
          closed = true;
        }
      }
      if (closed) { state.str = null; lastSig = s.q; continue; }
      i += 1;
      continue;
    }

    if (state.block > 0) {
      if (c === "/" && c2 === "*") {
        if (lang === "rust") state.block += 1;
        i += 2;
        continue;
      }
      if (c === "*" && c2 === "/") {
        state.block -= 1;
        i += 2;
        lastSig = "/";
        continue;
      }
      i += 1;
      continue;
    }

    // A line comment ends the line.
    if (c === "/" && c2 === "/") break;
    if (lang === "python" && c === "#") break;

    if (c === "/" && c2 === "*") {
      state.block = 1;
      i += 2;
      continue;
    }

    // JS regex literal, best effort. Delimiters inside are not counted.
    if ((lang === "js" || lang === "ts") && c === "/" && !/[\w$)\]}]/.test(lastSig)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const rc = text[i];
        if (rc === "\\") { i += 2; continue; }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) { i += 1; break; }
        i += 1;
      }
      while (i < n && /[a-z]/i.test(text[i])) i += 1; // flags
      lastSig = "/";
      continue;
    }

    if (c === '"' || c === "'" || (lang === "go" && c === "`")) {
      if (lang === "python" && c2 === c && text[i + 2] === c) {
        state.str = { q: c, tri: true };
        i += 3;
      } else if (lang === "rust" && c === '"') {
        if (i > 0 && text[i - 1] === "r") {
          let j = i - 1;
          let h = 0;
          while (j >= 1 && text[j - 1] === "#") { h++; j--; }
          state.str = { q: '"', rawHashes: h };
          i += 1;
        } else {
          state.str = { q: c };
          i += 1;
        }
      } else if (lang === "rust" && c === "'") {
        // A char literal is 'X' or '\X' within four characters; anything
        // else starting with a quote is a lifetime and only the quote is
        // skipped, or the next line would see a string that never closed.
        if (c2 === "\\") {
          const end = text.indexOf("'", i + 2);
          if (end !== -1 && end - i <= 4) { i = end + 1; lastSig = "'"; continue; }
        } else if (text[i + 2] === "'" && c2 !== "'") {
          i += 3;
          lastSig = "'";
          continue;
        }
        i += 1;
        continue;
      } else {
        state.str = { q: c };
        i += 1;
      }
      lastSig = c;
      continue;
    }

    // A backslash on the very last character is a Python line continuation.
    if (c === "\\" && i + 1 === n) {
      return { delta, trailingBackslash: true };
    }

    if (c === "(") {
      // `before` ends with the paren itself; NON_JOINING_CALL matches on it.
      const before = text.slice(0, i + 1).replace(/\s+$/, "");
      if (NON_JOINING_CALL.test(before)) state.specialStack.push(state.accDelta);
      else { delta += 1; state.accDelta += 1; }
      lastSig = c;
      i += 1;
      continue;
    }
    if (c === "[") { delta += 1; state.accDelta += 1; lastSig = c; i += 1; continue; }
    if (c === "{") {
      // Go joins braces: the `if got != want { t.Errorf(…) }` block is the
      // idiomatic Go assertion, and the value lives on its first line. The
      // other three languages get no brace joining, so a rename of a test
      // inside a block cannot pair as a value change on its own.
      if (lang === "go") { delta += 1; state.accDelta += 1; }
      lastSig = c;
      i += 1;
      continue;
    }
    if (c === ")") {
      const top = state.specialStack[state.specialStack.length - 1];
      if (top === state.accDelta) state.specialStack.pop();
      else { delta -= 1; state.accDelta -= 1; }
      lastSig = c;
      i += 1;
      continue;
    }
    if (c === "]") { delta -= 1; state.accDelta -= 1; lastSig = c; i += 1; continue; }
    if (c === "}") {
      if (lang === "go") { delta -= 1; state.accDelta -= 1; }
      lastSig = c;
      i += 1;
      continue;
    }

    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }

  return { delta, trailingBackslash: false };
}

/**
 * The same source with every comment blanked out, strings and line
 * structure untouched. Shapes and keywords are computed on this text so a
 * commented-out `expect(…)` cannot make a block an assertion, and a number
 * changed inside a comment cannot pair as a value change.
 */
function stripComments(text, lang) {
  const state = freshScanState();
  return text.split("\n").map((line) => {
    let out = "";
    let pending = 0;
    const copyCode = (to) => {
      out += line.slice(pending, to);
      pending = to;
    };
    let i = 0;
    const n = line.length;

    while (i < n) {
      const c = line[i];
      const c2 = i + 1 < n ? line[i + 1] : "";

      if (state.block > 0) {
        if (c === "/" && c2 === "*") {
          if (lang === "rust") state.block += 1;
          i += 2;
          continue;
        }
        if (c === "*" && c2 === "/") {
          state.block -= 1;
          i += 2;
          if (state.block === 0) pending = i;
          continue;
        }
        i += 1;
        continue;
      }

      if (state.str) {
        const s = state.str;
        let closed = false;
        if (s.rawHashes !== undefined) {
          if (c === '"') {
            let j = i + 1;
            let h = 0;
            while (j < n && line[j] === "#") { h++; j++; }
            if (h >= s.rawHashes) { i = j; closed = true; }
          }
        } else if (s.raw) {
          closed = c === s.q;
        } else if (c === "\\") {
          i += s.tri ? 1 : 2;
          continue;
        } else if (c === s.q) {
          if (s.tri) {
            if (line[i + 1] === s.q && line[i + 2] === s.q) { i += 3; closed = true; }
            else { i += 1; }
          } else {
            i += 1;
            closed = true;
          }
        }
        if (closed) {
          state.str = null;
          copyCode(i);
          continue;
        }
        i += 1;
        continue;
      }

      // `pending = n` is the whole fix. `copyCode(i)` copies the code up to
      // the comment and leaves `pending` sitting at its start; the
      // `copyCode(n)` after this loop then copied the comment straight back
      // in, so no line comment has ever been stripped. Block comments were,
      // which is why `/* … */` behaved and `// …` did not.
      if (c === "/" && c2 === "/") { copyCode(i); pending = n; break; }
      if (lang === "python" && c === "#") { copyCode(i); pending = n; break; }
      if (c === "/" && c2 === "*") {
        copyCode(i);
        state.block = 1;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || (lang === "go" && c === "`")) {
        copyCode(i);
        if (lang === "python" && c2 === c && line[i + 2] === c) {
          state.str = { q: c, tri: true };
          i += 3;
        } else if (lang === "rust" && c === '"') {
          if (i > 0 && line[i - 1] === "r") {
            let j = i - 1;
            let h = 0;
            while (j >= 1 && line[j - 1] === "#") { h++; j--; }
            state.str = { q: '"', rawHashes: h };
            i += 1;
          } else {
            state.str = { q: c };
            i += 1;
          }
        } else if (lang === "rust" && c === "'") {
          if (c2 === "\\") {
            const end = line.indexOf("'", i + 2);
            if (end !== -1 && end - i <= 4) { i = end + 1; copyCode(i); continue; }
          } else if (line[i + 2] === "'" && c2 !== "'") {
            i += 3;
            copyCode(i);
            continue;
          }
          i += 1;
          copyCode(i);
          continue;
        } else {
          state.str = { q: c };
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    copyCode(n);
    return out;
  }).join("\n");
}

// A line that cannot start a statement of its own continues the previous
// statement: a closing delimiter, a member-access, or an operator.
const CONTINUATION_START = /^[)\],.]/;
const CONTINUATION_OP_START = /^[+\-*/%<>=&|^:]/;

// A comment is not a continuation, however much it looks like one.
//
// `//` begins with a division sign and `--` with a minus, so both matched
// CONTINUATION_OP_START and folded the following comment line into the
// statement above it. The cost was a false accusation on a virtuous act:
// adding an assertion next to a `// ...` line made the new assertion absorb
// the comment, stop matching its unchanged twin, and get reported as a
// rewritten expectation. Python was unaffected only because `#` is not an
// operator — which is why the same fixture passed in pytest and failed in
// Jest, and why it survived every suite written against the pytest layout.
//
// A comment inside an open delimiter still joins: `cur.delta > 0` decides
// that before this test is ever reached.
const COMMENT_LINE_START = /^(?:\/\/|\/\*|#|--)/;

// A scanner miscount (an unbalanced delimiter inside a regex literal is the
// usual cause) must not be able to merge a whole file into one statement,
// which would pair *any* literal change anywhere in the file.
const MAX_STATEMENT_LINES = 100;
const MAX_STATEMENT_CHARS = 12000;

/**
 * Reassemble physical lines into statements.
 *
 * `sliceLines` is one image of a hunk in file order: context lines plus the
 * removed (or added) lines. Context lines are ordinary file text; a
 * statement spans them freely, which is exactly what makes a value edit
 * inside a formatter-wrapped assertion visible to the pairing.
 *
 * @param {Array<{ kind: string, text: string, oldNo: number|null, newNo: number|null }>} sliceLines
 * @param {string} lang
 * @returns {Array<{ text: string, firstOld: number|null, lastOld: number|null, firstNew: number|null, lastNew: number|null, removedLines: Array, addedLines: Array }>}
 */
function assembleStatements(sliceLines, lang) {
  const stmts = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    stmts.push({
      text: cur.lines.join("\n"),
      firstOld: cur.firstOld,
      lastOld: cur.lastOld,
      firstNew: cur.firstNew,
      lastNew: cur.lastNew,
      removedLines: cur.removedLines,
      addedLines: cur.addedLines,
    });
    cur = null;
  };

  for (const L of sliceLines) {
    const trimmed = L.text.replace(/^\s+/, "");
    const startsComment = COMMENT_LINE_START.test(trimmed);
    const joins =
      cur !== null &&
      (cur.delta > 0 ||
        cur.state.str !== null ||
        cur.state.block > 0 ||
        cur.trailingBackslash ||
        (!startsComment &&
          (CONTINUATION_START.test(trimmed) || CONTINUATION_OP_START.test(trimmed))));

    if (
      joins &&
      cur.lines.length < MAX_STATEMENT_LINES &&
      cur.chars + L.text.length + 1 <= MAX_STATEMENT_CHARS
    ) {
      cur.lines.push(L.text);
      cur.chars += L.text.length + 1;
      const sc = scanSourceLine(L.text, lang, cur.state);
      cur.delta += sc.delta;
      cur.trailingBackslash = sc.trailingBackslash;
      cur.lastOld = L.oldNo;
      cur.lastNew = L.newNo;
      if (L.kind === "-") cur.removedLines.push(L);
      else if (L.kind === "+") cur.addedLines.push(L);
    } else {
      flush();
      const st = freshScanState();
      const sc = scanSourceLine(L.text, lang, st);
      cur = {
        lines: [L.text],
        chars: L.text.length,
        firstOld: L.oldNo,
        lastOld: L.oldNo,
        firstNew: L.newNo,
        lastNew: L.newNo,
        delta: sc.delta,
        state: st,
        trailingBackslash: sc.trailingBackslash,
        removedLines: L.kind === "-" ? [L] : [],
        addedLines: L.kind === "+" ? [L] : [],
      };
    }
  }
  flush();
  return stmts;
}

const hasLiteralPlaceholder = (shape) =>
  shape.includes("\u0000S") || shape.includes("\u0000N") || shape.includes("\u0000B");

const collapseWhitespace = (s) => s.replace(/\s+/g, " ").trim();
const shorten = (s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

/**
 * Split the argument list of the outermost assertion call in `clean`.
 *
 * Comments are already stripped by the caller, so only string state has to be
 * tracked. Returns null whenever the shape is not confidently understood — a
 * truncated fragment, an unbalanced hunk, a quoting form not handled here —
 * because every caller uses this to *suppress* a finding, and failing to
 * understand a statement must never become a reason to stay quiet about it.
 *
 * @param {string} clean - comment-stripped statement text
 * @param {string} lang
 * @returns {string[] | null} top-level arguments, trimmed
 */
function splitAssertionArgs(clean, lang) {
  SPECIFIC_ASSERTION.lastIndex = 0;
  const m = SPECIFIC_ASSERTION.exec(clean);
  if (!m) return null;

  // Not every branch of SPECIFIC_ASSERTION ends at an opening paren:
  // `assert_eq!`, `assert_equal` and RSpec's `.to eq` all match a bare name.
  // Starting the walk one character early made every argument boundary wrong,
  // so a reworded message read as a rewritten value.
  let i = m.index + m[0].length;
  if (clean[i - 1] !== "(") {
    let j = i;
    while (j < clean.length && /\s/.test(clean[j])) j++;
    if (clean[j] !== "(") return null;
    i = j + 1;
  }
  let depth = 1;
  let quote = null;
  let triple = false;
  const args = [];
  let start = i;

  while (i < clean.length) {
    const c = clean[i];

    if (quote !== null) {
      if (c === "\\") { i += 2; continue; }
      if (triple && c === quote && clean[i + 1] === quote && clean[i + 2] === quote) {
        quote = null; triple = false; i += 3; continue;
      }
      if (!triple && c === quote) { quote = null; i += 1; continue; }
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      if (lang === "python" && clean[i + 1] === c && clean[i + 2] === c) {
        quote = c; triple = true; i += 3; continue;
      }
      quote = c; i += 1; continue;
    }

    if (c === "(" || c === "[" || c === "{") { depth += 1; i += 1; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(clean.slice(start, i).trim());
        return args;
      }
      i += 1;
      continue;
    }
    if (c === "," && depth === 1) {
      args.push(clean.slice(start, i).trim());
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null; // never closed: an unbalanced fragment, so no suppression
}

/** One plain string literal and nothing else. */
const PURE_STRING_LITERAL = new RegExp(
  [
    "^'(?:\\\\.|[^'\\\\])*'$",
    '^"(?:\\\\.|[^"\\\\])*"$',
    "^`(?:\\\\.|[^`\\\\])*`$",
    '^"""[\\s\\S]*"""$',
    "^'''[\\s\\S]*'''$",
  ].join("|")
);

function isPureStringLiteral(arg) {
  if (!arg) return false;
  return PURE_STRING_LITERAL.test(arg.trim());
}

/**
 * Argument positions that carry a message for a human rather than an expected
 * value.
 *
 * Trailing, for `assert.equal(got, want, "message")` and
 * `assert_eq!(a, b, "message")`; leading, for Go's
 * `t.Errorf("got %d want %d", got, want)`. Two arguments is the classic
 * `(actual, expected)` shape, so a string in last position *there* is the
 * expected value: `assert.equal(name, "Alice")` must still be judged when
 * "Alice" becomes "Bob".
 */
function messageArgIndices(args) {
  const idx = new Set();
  const lastIsMessage = args.length >= 3 && isPureStringLiteral(args[args.length - 1]);
  if (lastIsMessage) idx.add(args.length - 1);

  // JUnit 4 is the one common dialect that puts the message *first*:
  // `assertEquals("why this matters", expected, actual)`. It is also
  // distinguishable, because its trailing argument is the actual value rather
  // than prose — so a call that already carries a trailing message is not
  // that shape, whatever its first argument looks like.
  //
  // Reading argument 0 as prose whenever it happened to be a string is what
  // made a whole family of assertions invisible: `assertEquals(expected,
  // actual)` — JUnit's and PHPUnit's own two-argument order — along with
  // Python's `assertIn(member, container)` and `assertNotIn`. A rewritten
  // expectation in any of them was dismissed as a reworded message, and the
  // guard reported PASS on a check it had not performed.
  if (!lastIsMessage && args.length >= 3 && isPureStringLiteral(args[0])) idx.add(0);
  return idx;
}

/**
 * True when two assertions differ only in text written to be read by a person.
 *
 * Rewording the message on a failing assertion is among the most common edits
 * any test file receives, and it says nothing whatsoever about what the suite
 * checks. But a message is a literal, so blanking literals made the two
 * statements the same shape and the pairing reported a rewritten expectation
 * every time somebody improved the wording of a failure. Firing on that is
 * how an operator learns to pass the override without reading it.
 */
/**
 * Split a statement at a trailing `, "message"` written outside the call.
 *
 * RSpec puts the message there — `expect(x).to eq(3), "explain"` — and so do
 * Ruby and Elixir assertions generally. An argument-position check can never
 * see it, so rewording one read as a rewritten expectation.
 */
function splitTrailingMessage(clean) {
  let depth = 0;
  let quote = null;
  let lastComma = -1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quote !== null) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) lastComma = i;
  }
  if (lastComma === -1) return { head: clean, msg: null };
  const tail = clean.slice(lastComma + 1).trim();
  if (!isPureStringLiteral(tail)) return { head: clean, msg: null };
  return { head: clean.slice(0, lastComma), msg: tail };
}

/**
 * Test declarations that a runner finds by the *name* of the function.
 *
 * pytest collects `def test_*`, Go collects `func Test*`, and unittest and
 * Minitest collect `def test_*` off the case class. For those runners the
 * name is not prose — it is the registration. Renaming `test_totals` to
 * `totals` deletes the test from the run as completely as removing the file,
 * and the diff shows a rename.
 *
 * Only these name-driven runners are listed. `it("...")`, `#[test]` and
 * `@Test` register by call, attribute or annotation, so renaming what they
 * declare removes nothing, and the ordinary rename rules already cover them.
 */
const NAME_REGISTERED_DECLS = [
  { lang: "python", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, discovered: /^test/i },
  { lang: "go", re: /^\s*func\s+([A-Za-z_]\w*)\s*\(/, discovered: /^(?:Test|Benchmark|Fuzz|Example)/ },
];

/**
 * The declared name on this line, and whether the runner would collect it.
 *
 * @returns {{ name: string, collected: boolean }|null}
 */
function declaredTestName(text) {
  for (const rule of NAME_REGISTERED_DECLS) {
    const m = rule.re.exec(text);
    if (m) return { name: m[1], collected: rule.discovered.test(m[1]) };
  }
  return null;
}

/**
 * Did a collected test become a declaration the runner no longer collects?
 *
 * The name *is* the registration for pytest (`test*`) and Go (`Test*` with
 * an uppercase letter or underscore after), so the signal is purely whether
 * the runner would still find it: `test_want_bytes` → `check_want_bytes`,
 * `TestLoadComment` → `checkLoadComment`, `test_x` → `disabled_x` all remove
 * the test from the run while leaving every assertion in place.
 *
 * The earlier rule required the new name to be the old one with its prefix
 * literally stripped, so `test_x` → `x` was caught and every other prefix
 * swap sailed through. It was written narrow to avoid flagging
 * `test_x` → `test_x_renamed` — an honest rename — but that case never needs
 * the strip rule: the new name is *still collected*, so the collected check
 * already keeps it silent, along with pytest's `test*` glob collecting
 * `testx`, Go's `TestX` → `TestXRenamed`, and case-class `test_x` →
 * `test_y`. Pairing is still required (a pure deletion is an assertion
 * removal, not a rename), and names identical on both sides never pair.
 */
function isDeregistration(before, after) {
  return Boolean(before.collected && !after.collected && before.name !== after.name);
}

// A test declaration whose first argument is the test's name. The name is
// prose about the test, not a value the test asserts — `test("adds", ...)`
// renamed to `test("adds positives", ...)` is the rename the diff says it is.
const TEST_DECL_CALL =
  /\b(?:it|test|describe|context|suite|specify|bench|scenario)\s*\(|\b[a-z_$][\w$]{0,2}\.(?:test|Run|describe)\s*\(/;

/**
 * Replace the name argument of a test declaration with a placeholder.
 *
 * @param {string} clean - comment-stripped statement text
 * @returns {string|null} the text with the name blanked, or null when the
 *   statement is not a test declaration with a literal name.
 */
function blankTestName(clean) {
  const m = TEST_DECL_CALL.exec(clean);
  if (!m) return null;

  let i = m.index + m[0].length;
  while (i < clean.length && /\s/.test(clean[i])) i++;
  const quote = clean[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;

  let j = i + 1;
  while (j < clean.length) {
    if (clean[j] === "\\") { j += 2; continue; }
    if (clean[j] === quote) break;
    j += 1;
  }
  if (j >= clean.length) return null;

  return clean.slice(0, i) + "\u0000T" + clean.slice(j + 1);
}

/**
 * True when the only thing that changed was the test's name.
 *
 * A one-line `test("adds", () => { assert.strictEqual(add(2, 3), 5); });`
 * blanks to the same shape as its renamed copy, so the two pair — and the
 * pair was then reported as a rewritten expectation, quoting the whole line
 * back at an author who had renamed a test and nothing else. Renaming a test
 * is one of the most ordinary edits there is, and a gate that calls it
 * tampering is a gate that gets switched off.
 *
 * The multi-line form was never affected: NON_JOINING_CALL already keeps a
 * test name from joining to the assertion below it. This is the same rule for
 * the statements that fit on one line.
 *
 * A rename that also moves the expectation still differs after the name is
 * blanked, so it is still reported.
 */
function differsOnlyInTestName(cleanRemoved, cleanAdded) {
  const a = blankTestName(cleanRemoved);
  const b = blankTestName(cleanAdded);
  if (a === null || b === null) return false;
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function differsOnlyInMessage(cleanRemoved, cleanAdded, lang) {
  const ta = splitTrailingMessage(cleanRemoved);
  const tb = splitTrailingMessage(cleanAdded);
  if (
    (ta.msg !== null || tb.msg !== null) &&
    ta.head.replace(/\s+/g, "") === tb.head.replace(/\s+/g, "")
  ) {
    return true;
  }

  const a = splitAssertionArgs(cleanRemoved, lang);
  const b = splitAssertionArgs(cleanAdded, lang);
  if (!a || !b || a.length !== b.length || a.length === 0) return false;

  const msgIdx = messageArgIndices(a);
  if (msgIdx.size === 0) return false;

  let sawDifference = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].replace(/\s+/g, "") === b[i].replace(/\s+/g, "")) continue;
    // A difference outside a message position, or in a position that stopped
    // being a plain string, is a real change.
    if (!msgIdx.has(i) || !isPureStringLiteral(b[i])) return false;
    sawDifference = true;
  }
  return sawDifference;
}

/**
 * True when a paired difference is something other than a rewritten
 * expectation — a reworded message, or a renamed test.
 */
function isNonExpectationDifference(cleanRemoved, cleanAdded, lang) {
  return (
    differsOnlyInMessage(cleanRemoved, cleanAdded, lang) ||
    differsOnlyInTestName(cleanRemoved, cleanAdded)
  );
}

/**
 * Pair rewritten expectations across the removed and added images of every
 * hunk of one file, and report each pair.
 *
 * A statement is only a candidate when it actually contains a removed
 * (resp. added) line: a context-only statement is unchanged text on both
 * sides, and letting it pair would flag a genuinely new assertion that
 * merely has the same shape as one that stayed put.
 *
 * @param {string} file
 * @param {Array<{ lines: Array }>} hunks
 * @param {object} stats - per-file stats; the paired physical lines are
 *   spliced out of the count pools so the count-based checks below do not
 *   report the same edit a second time.
 * @param {Array} violations
 * @returns {Array<{ r: object, a: object }>} the pairs, for the caller
 */
function detectExpectationRewrites(file, hunks, stats, violations) {
  const lang = langForTestFile(file);
  const allPairs = [];

  for (const hunk of hunks) {
    const oldSlice = [];
    const newSlice = [];
    for (const L of hunk.lines) {
      if (L.kind !== "+") oldSlice.push(L);
      if (L.kind !== "-") newSlice.push(L);
    }
    const oldStmts = assembleStatements(oldSlice, lang);
    const newStmts = assembleStatements(newSlice, lang);

    // Candidate statements in file order, per image.
    const oldCands = [];
    for (const s of oldStmts) {
      if (s.removedLines.length === 0) continue;
      const clean = stripComments(s.text, lang);
      if (!isSpecificAssertion(clean)) continue;
      oldCands.push({ s, clean, shape: blankLiterals(clean), canon: clean.replace(/\s+/g, "") });
    }
    const newCands = [];
    for (const s of newStmts) {
      if (s.addedLines.length === 0) continue;
      const clean = stripComments(s.text, lang);
      if (!isSpecificAssertion(clean)) continue;
      newCands.push({ s, clean, shape: blankLiterals(clean), canon: clean.replace(/\s+/g, "") });
    }

    // The t-th removed candidate of a shape pairs with the t-th added
    // candidate of the same shape. Position alignment is what keeps a
    // formatter run over a block of same-shape assertions silent: a greedy
    // "first different text" pairing would match a re-indented
    // `assert.equal(f(0), 0)` against its neighbour's value and report a
    // rewrite that did not happen. It also keeps the pairing linear in the
    // number of statements, which a 4000-line same-shape table would not
    // survive as a square of comparisons.
    const oldByShape = new Map();
    const newByShape = new Map();
    for (const c of oldCands) {
      let arr = oldByShape.get(c.shape);
      if (!arr) arr = oldByShape.set(c.shape, []).get(c.shape);
      arr.push(c);
    }
    for (const c of newCands) {
      let arr = newByShape.get(c.shape);
      if (!arr) arr = newByShape.set(c.shape, []).get(c.shape);
      arr.push(c);
    }

    const pairs = [];
    const pairedOld = new Set();
    const pairedNew = new Set();
    const cancelled = new Set();
    for (const [shape, olds] of oldByShape) {
      const news = newByShape.get(shape) || [];

      // Cancel the assertions that are byte-identical on both sides before
      // aligning anything.
      //
      // Reordering two assertions removes both and adds both back unchanged.
      // Positional alignment then matched the first removed against the first
      // added — a different assertion — and reported two rewritten
      // expectations for an edit that changed no expected value at all. The
      // same happened to an assertion that simply moved within its block.
      // What is present unchanged on both sides did not change; only the
      // residue can have been rewritten.
      const survivingNew = news.slice();
      const survivingOld = [];
      for (const o of olds) {
        const twin = survivingNew.findIndex((n) => n.canon === o.canon);
        if (twin === -1) {
          survivingOld.push(o);
        } else {
          // Present unchanged on both sides: this assertion did not change,
          // and the argument-level pass below must not be allowed to pair it
          // with something else and call that a rewrite.
          cancelled.add(o);
          cancelled.add(survivingNew[twin]);
          survivingNew.splice(twin, 1);
        }
      }

      const k = Math.min(survivingOld.length, survivingNew.length);
      for (let t = 0; t < k; t++) {
        const r = survivingOld[t];
        const a = survivingNew[t];
        // Whatever this pass decides about a pair — reported, or deliberately
        // let go as a reorder or a reworded message — is the decision. The
        // argument-level pass below exists only for statements whose shapes
        // differ so much that they never met in a bucket here; letting it
        // re-open a case that was already judged turned a comment edit into a
        // rewritten expectation.
        pairedOld.add(r);
        pairedNew.add(a);
        if (r.canon === a.canon) continue;
        if (isNonExpectationDifference(r.clean, a.clean, lang)) continue;
        pairs.push({ r: r.s, a: a.s });
      }
    }

    // Same assertion, same subject, different expected value.
    //
    // Shape pairing compares the statement with its literals blanked, so it
    // only ever matched assertions whose structure survived the edit. Shrink
    // a five-element expected list to one element to match broken output and
    // the two images land in different shape buckets, never pair, and the
    // rewrite is not reported at all — measured on a real repository, where
    // it collected five green phases.
    //
    // The arguments are the better witness here: when both sides call the
    // same assertion with the same number of arguments and the *subject*
    // argument is untouched, what changed is what the test expects of it.
    for (const r of oldCands) {
      if (pairedOld.has(r) || cancelled.has(r)) continue;
      const ra = splitAssertionArgs(r.clean, lang);
      if (!ra || ra.length < 2) continue;
      for (const a of newCands) {
        if (pairedNew.has(a) || cancelled.has(a)) continue;
        const aa = splitAssertionArgs(a.clean, lang);
        if (!aa || aa.length !== ra.length) continue;
        const same = (i) => ra[i].replace(/\s+/g, "") === aa[i].replace(/\s+/g, "");
        // The subject has to be the same expression, or these are two
        // different assertions that merely resemble each other.
        if (!same(0)) continue;
        if (ra.every((_, i) => same(i))) continue;
        if (isNonExpectationDifference(r.clean, a.clean, lang)) continue;
        pairs.push({ r: r.s, a: a.s });
        pairedOld.add(r);
        pairedNew.add(a);
        break;
      }
    }

    // A bare-comparison assertion whose expectation became a conditional
    // value. `assert dec == value` rewritten as
    // `assert dec == (193 if value == 192 else value)` keeps a comparison on
    // both sides of the new `==`, so both statements still parse as
    // assertions, but the expected value is now a conditional that bends to
    // broken output — F03, measured approving a deliberately broken function.
    // The call-argument passes above cannot see this spelling: a Python/Rust
    // bare comparison has no argument list, and the conditional introduces a
    // second comparison so the two images never share a shape bucket.
    //
    // The subject (the left operand of the assertion) must survive, and the
    // new right-hand side has to be a *conditional expression* —
    // Python's `a if c else b` or a JS/Java `c ? a : b` — so an honest
    // assertion whose expected value is a ternary from the start is only
    // reported when it replaces a non-conditional expectation of the same
    // subject, and an identifier renamed in the expectation (no conditional)
    // is not reported here either.
    for (const r of oldCands) {
      if (pairedOld.has(r) || cancelled.has(r)) continue;
      const oldParts = splitBareComparison(r.clean, lang);
      if (!oldParts) continue;
      for (const a of newCands) {
        if (pairedNew.has(a) || cancelled.has(a)) continue;
        const newParts = splitBareComparison(a.clean, lang);
        if (!newParts) continue;
        if (oldParts.lhs.replace(/\s+/g, "") !== newParts.lhs.replace(/\s+/g, "")) continue;
        if (oldParts.rhs.replace(/\s+/g, "") === newParts.rhs.replace(/\s+/g, "")) continue;
        if (!containsConditional(newParts.rhs)) continue;
        if (isNonExpectationDifference(r.clean, a.clean, lang)) continue;
        pairs.push({ r: r.s, a: a.s });
        pairedOld.add(r);
        pairedNew.add(a);
        break;
      }
    }

    // Zero-context hunk: each image is a single fragment and the assertion
    // keyword may sit outside the hunk entirely. The fragment pair is taken
    // only when both sides normalize to the same shape *and* that shape
    // holds a literal — a code change cannot fake it.
    if (pairs.length === 0 && oldStmts.length === 1 && newStmts.length === 1) {
      const r = oldStmts[0];
      const a = newStmts[0];
      if (r.removedLines.length > 0 && a.addedLines.length > 0) {
        const sr = blankLiterals(stripComments(r.text, lang));
        const sa = blankLiterals(stripComments(a.text, lang));
        if (sr === sa && hasLiteralPlaceholder(sr)) {
          const clr = stripComments(r.text, lang);
          const cla = stripComments(a.text, lang);
          if (clr.replace(/\s+/g, "") !== cla.replace(/\s+/g, "") && !isNonExpectationDifference(clr, cla, lang)) {
            pairs.push({ r, a });
          }
        }
      }
    }

    for (const p of pairs) {
      allPairs.push(p);
      const addedNo = p.a.addedLines.length > 0 ? p.a.addedLines[0].newNo : (p.r.removedLines[0] ? p.r.removedLines[0].oldNo : null);
      violations.push({
        file,
        line: addedNo,
        type: "ASSERTION_EXPECTATION_CHANGED",
        reason:
          `Test Tamper Guard: Expected value rewritten in ${file}${addedNo ? `:${addedNo}` : ""} — ` +
          `"${shorten(collapseWhitespace(p.r.text))}" became "${shorten(collapseWhitespace(p.a.text))}". ` +
          `A deliberately changed spec looks identical to a test bent to match broken ` +
          `output, and a diff alone cannot tell the two apart, so this is flagged for ` +
          `review rather than assumed. If the new expectation is the correct one, ` +
          `re-run with --allow-test-change expectation — which allows exactly this ` +
          `check and leaves the skip, vacuous, commented, removal and weakening ` +
          `checks doing their job.`,
      });

      // Both sides are accounted for here, so they must not also feed the
      // count-based checks below — the same line reported twice under two
      // names tells the operator nothing extra. Consumption is symmetric so
      // a statement that absorbed two old assertion lines but only one new
      // one still leaves the surplus to the removal check.
      const removedMatches = p.r.removedLines.filter(
        (L) => stats.removed.some((e) => e.line === L.oldNo && e.text === L.text)
      );
      const addedMatches = p.a.addedLines.filter(
        (L) => stats.addedTexts.some((e) => e.line === L.newNo && e.text === L.text)
      );
      const take = Math.min(removedMatches.length, addedMatches.length);
      for (let k = 0; k < take; k++) {
        const L = removedMatches[k];
        const idx = stats.removed.findIndex((e) => e.line === L.oldNo && e.text === L.text);
        if (idx === -1) continue;
        const entry = stats.removed.splice(idx, 1)[0];
        const rsIdx = stats.removedSpecific.indexOf(entry);
        if (rsIdx !== -1) {
          stats.removedSpecific.splice(rsIdx, 1);
          stats.addedSpecific--;
        }
        stats.added--;
      }
    }
  }

  return allPairs;
}

/**
 * The tamper checks, by the name an operator uses to allow one of them.
 *
 * There was one override for all six, and it was a switch marked "off". A
 * deliberate change of spec rewrites what a test expects, which is
 * indistinguishable from bending a test to match broken output — so the honest
 * answer to that finding is sometimes an override. But reaching for it also
 * silenced injected `.skip()`, `expect(true).toBe(true)`, commented-out
 * assertions and outright deletions, none of which the operator had looked at.
 * The check with the highest firing rate therefore set the ceiling for every
 * other check in the bundle: the more useful this one became, the more often
 * it would be used to turn the others off.
 */
export const TAMPER_KINDS = new Map([
  ["TEST_SKIP_INJECTION", "skip"],
  ["VACUOUS_ASSERTION", "vacuous"],
  ["COMMENTED_ASSERTION", "commented"],
  ["ASSERTION_REMOVAL", "removal"],
  ["ASSERTION_WEAKENED", "weakening"],
  ["ASSERTION_EXPECTATION_CHANGED", "expectation"],
  ["TEST_DEREGISTERED", "deregistration"],
]);

/** Every kind name, for CLI validation and help text. */
export const TAMPER_KIND_NAMES = Object.freeze([...new Set(TAMPER_KINDS.values())].sort());

/**
 * Conditions a compiler or the language's own rules make impossible.
 *
 * A Go `len(...)` is never negative, so `if len(comment) < 0` is false on
 * every input; a C unsigned/size comparison against 0 is the same shape in
 * the dialects scanned under the JS lexer. These are the cases where the
 * condition governing a failure call can be proven dead from the diff line
 * alone — anything fuzzier (a flag constant flipped elsewhere, an unreachable
 * branch behind real state) is not guessable and is deliberately left alone.
 */
const DEAD_GUARD_CONDITION =
  /\bif\b[^;{}]*\b(?:len|len\s+of|count|size|length|num\w*|total)\s*\([^)]*\)\s*(?:<\s*0|<\s*-0\b|<=\s*-1\b)|\bif\s+(?:False|false|0)\s*(?::|\{|$|\b)|\bif\s*\(\s*(?:False|false|0)\s*\)/;

/**
 * The calls a test uses to say "this failed": the assertion's actual teeth.
 * When one of these sits inside a dead condition, the assertion survives in
 * name only.
 */
const FAILURE_CALL =
  /\b(?:t\.(?:Errorf|Fatalf|Fatal|Error)\s*\(|require\.(?:Fail|FailNow|Error|Errorf|Equal|NotEqual|Len|Contains|NoError)\s*\(|assert\.(?:fail|fail!|equal|deepEqual|strictEqual)\b|assert_eq!\s*\(|assert!\s*\(|pytest\.fail\s*\(|self\.fail(?:ure)?\s*\(|fail(?:ure)?\s*\(|throw\s+new\s+(?:AssertionError|Error)\b|raise\s+AssertionError\b)/i;

/**
 * Go build-constraint terms. `//go:build ignore` never matches a release
 * build; conjoining a private tag (`go1.7 && cold_start_never`) gates a file
 * unless CI sets the tag. Version (`go1.x`), OS and arch terms are legitimate
 * CI gating and stay silent.
 */
const GO_BUILD_TAG_LINE = /^\s*\/\/go:build\s+(.+?)\s*$/;
const GO_LEGACY_TAG_LINE = /^\s*\/\/\s*\+build\s+(.+?)\s*$/;
const goBuildTerms = (line) => {
  const m = GO_BUILD_TAG_LINE.exec(line) || GO_LEGACY_TAG_LINE.exec(line);
  if (!m) return null;
  // `&&`/`||` separate constraint expressions; spaces/commas separate terms.
  // Negated terms (`!tag`) are normal platform guards; strip the leading `!`.
  return m[1]
    .split(/\s*&&\s*|\s*\|\|\s*|[\s,]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^!/, ""));
};
const goKnownBuildTerm = (term) =>
  /^go1\.\d+/.test(term) ||
  /^(?:linux|darwin|windows|freebsd|openbsd|netbsd|dragonfly|solaris|aix|js|wasip1|plan9|ios|android)$/.test(term) ||
  /^(?:amd64|386|arm|arm64|ppc64|ppc64le|mips|mipsle|mips64|mips64le|riscv64|s390x|wasm|loong64)$/.test(term) ||
  term === "ignore";

/**
 * A bare, unconditional `return` (optionally returning a constant) — never a
 * `return value`, never attached to an `if` on the same line.
 */
/**
 * A bare, unconditional `return` (optionally returning a constant) — never a
 * `return value`, never attached to an `if` on the same line.
 *
 * The boundary of what this check can see: the body-first bare `return` is
 * caught; a `return` behind a condition the test author believes cannot hold
 * is not. Judging the latter requires knowing whether the branch is
 * reachable at runtime — a whole-program control-flow question no line pair
 * answers — and flagging any `return` above an assertion would hard-red the
 * ordinary `if (process.platform === "win32") return;` guard clause. The rule
 * stops at the shape whose intent is unambiguous from the text. Runtime
 * attestation (counting tests collected before and after) is the complete
 * answer, and a separate check from the text guard.
 */
const BARE_EARLY_RETURN = /^\s*return\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|true|false|None|nil|null|undefined|0|-?\d+)\s*)?;?\s*$/;

/**
 * A line that opens a test body: a pytest/unittest `def test*` signature, a
 * Go `func Test*` / Rust `fn` immediately preceded by a test attribute (best
 * effort at line scope), or a JS test registration whose callback opens.
 */
const TEST_BODY_OPEN =
  /(?:^|\s)(?:def\s+test\w*\s*\([^)]*\)\s*(?:->[^:]+)?\s*:|func\s+(?:Test|Benchmark|Fuzz|Example)\w*\s*\([^)]*\)\s*\{|fn\s+\w+\s*\([^)]*\)\s*\{|\b(?:it|test|describe|context)\s*(?:\.[a-zA-Z]+)?\s*\(\s*["'`][^"'`]*["'`]\s*,?\s*(?:async\s*)?(?:function)?\s*\w*\s*=>?\s*\{?)$/i;

/**
 * Which tamper checks this run is allowed to stay quiet about.
 *
 * @param {object} options
 * @param {boolean} [options.allowTestModifications] - the blunt form: all of them.
 * @param {string|string[]} [options.allowTestChanges] - kind names, comma-separated or an array.
 * @returns {{ all: boolean, kinds: Set<string>, unknown: string[] }}
 */
export function resolveAllowedTamperKinds(options = {}) {
  if (options.allowTestModifications === true) {
    return { all: true, kinds: new Set(TAMPER_KIND_NAMES), unknown: [] };
  }
  const raw = options.allowTestChanges;
  const list = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v == null ? "" : v).split(","))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (list.includes("all")) {
    return { all: true, kinds: new Set(TAMPER_KIND_NAMES), unknown: [] };
  }
  const kinds = new Set();
  const unknown = [];
  for (const name of list) {
    if (TAMPER_KIND_NAMES.includes(name)) kinds.add(name);
    else unknown.push(name);
  }
  return { all: false, kinds, unknown };
}

/**
 * Detects test file assertion tampering, weakening, or test skips.
 *
 * @param {string} diffOrText - Unified git diff
 * @param {Object} [options]
 * @param {boolean} [options.allowTestModifications=false]
 * @returns {{ ok: boolean, violations: Array<object>, inputsSeen: number, filesSeen: number,
 *            assertionsSeen: number, unreadable: Array<{file: string, count: number, samples: string[]}>,
 *            status: "PASS"|"FAIL"|"UNREADABLE"|"NOT_APPLICABLE" }}
 *   `status` distinguishes "checked and clean" from "nothing was checked";
 *   `ok: true` alone cannot, and that ambiguity is the defect class this
 *   field exists to make visible.
 */
export function checkTestTampering(diffOrText = "", options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") {
    return { ok: true, violations: [], inputsSeen: 0, status: "NOT_APPLICABLE", reason: "empty diff" };
  }
  const allowed = resolveAllowedTamperKinds(options);
  if (allowed.all) {
    return { ok: true, violations: [], inputsSeen: 0, status: "NOT_APPLICABLE", reason: "all kinds allowed" };
  }

  // Which predicate decides what this guard even looks at. Injectable so the
  // meta-check can mutate it: a canary that still passes when the predicate is
  // replaced by `() => false` was never requiring this guard to activate.
  const isTestPath_ = typeof options.isTestPath === "function" ? options.isTestPath : isTestPath;

  const violations = [];
  const lines = diffOrText.split("\n");
  let lastOldFile = null;
  let currentFile = null;
  let currentOldLineNo = null;
  let currentNewLineNo = null;

  const isTestFile = isTestPath_;

  const SKIP_INJECTIONS = [
    { pattern: /\b(?:it|test|describe|context)\.skip\s*\(/i, desc: "Injected test skip (.skip())" },
    { pattern: /\b(?:xit|xtest|xdescribe)\s*\(/i, desc: "Injected disabled test (xit/xtest/xdescribe)" },
    { pattern: /@pytest\.mark\.skip/i, desc: "Injected Pytest skip decorator (@pytest.mark.skip)" },
    { pattern: /\bt\.Skip\s*\(/i, desc: "Injected Go test skip (t.Skip())" },
    { pattern: /#\[ignore\]/i, desc: "Injected Rust test ignore attribute (#[ignore])" },
    { pattern: /\/\/\s*@ts-ignore/i, desc: "Injected TypeScript ignore comment (// @ts-ignore)" },
    { pattern: /\/\/\s*@ts-nocheck/i, desc: "Injected TypeScript nocheck directive (// @ts-nocheck)" },
    // A suite that never runs cannot fail, and `@Disabled` is exactly as
    // effective at arranging that as `it.skip` is.
    { pattern: /@Disabled\b/, desc: "Injected JUnit 5 disable annotation (@Disabled)" },
    { pattern: /@Ignore\b/, desc: "Injected JUnit 4 / TestNG ignore annotation (@Ignore)" },
    { pattern: /@Test\s*\([^)]*enabled\s*=\s*false/i, desc: "Injected TestNG disabled test (enabled = false)" },
    { pattern: /@unittest\.skip/i, desc: "Injected unittest skip decorator (@unittest.skip)" },
    { pattern: /\bmarkTest(?:Skipped|Incomplete)\s*\(/i, desc: "Injected PHPUnit skip (markTestSkipped())" },
    { pattern: /\bXCTSkip(?:If|Unless|IfNot)?\s*\(/, desc: "Injected XCTest skip (XCTSkip())" },
    { pattern: /\b(?:xit|xdescribe|xcontext|xspecify)\b\s*["\x27]/i, desc: "Injected RSpec disabled example (xit)" },
    { pattern: /,\s*skip:\s*(?:true|["\x27])/i, desc: "Injected RSpec skip metadata (skip:)" },
    // node-tap, node:test and ava pass it as a property of an options object,
    // so the comma sits before the brace and not before the key.
    { pattern: /\{[^}]*\bskip\s*:\s*true/i, desc: "Injected skip option ({ skip: true })" },
    { pattern: /\{[^}]*\btodo\s*:\s*true/i, desc: "Injected todo option ({ todo: true })" },
    { pattern: /^\s*(?:skip|pending)\s*(?:["\x27(]|$)/i, desc: "Injected Minitest/RSpec skip statement" },
    // Skipping from inside the body, which is how these ecosystems actually
    // do it. Only the decorator and annotation forms were covered, so a test
    // could be silenced with the standard library's own method and the guard
    // said nothing: measured silent on six of seven in-body forms.
    { pattern: /\bself\.skipTest\s*\(/i, desc: "Injected unittest skip (self.skipTest())" },
    { pattern: /\braise\s+(?:unittest\.)?SkipTest\b/i, desc: "Injected unittest skip (raise SkipTest)" },
    { pattern: /\bpytest\.skip\s*\(/i, desc: "Injected Pytest skip call (pytest.skip())" },
    { pattern: /\bpytest\.xfail\s*\(/i, desc: "Injected Pytest expected-failure (pytest.xfail())" },
    // The decorator form the call above does not cover. `strict=False` (the
    // default) lets a *broken* test pass as xpass-with-no-failure; strict only
    // fails on an unexpected pass, so either spelling blesses a failing suite.
    { pattern: /@pytest\.mark\.xfail\b/i, desc: "Injected Pytest expected-failure mark (@pytest.mark.xfail)" },
    { pattern: /@(?:unittest\.)?expectedFailure\b/i, desc: "Injected unittest expected-failure decorator (@expectedFailure)" },
    { pattern: /\bthis\.skip\s*\(/i, desc: "Injected Mocha skip (this.skip())" },
    { pattern: /\b(?:it|test|describe|context)\.todo\s*\(/i, desc: "Injected todo placeholder (test.todo())" },
    { pattern: /\bt\.Skip(?:Now|f)?\s*\(/, desc: "Injected Go test skip (t.Skip/t.Skipf/t.SkipNow)" },
    // `#[cfg(any())]` is false under every target — the idiomatic Rust way to
    // compile a test out without a skip or a rename. A body the cfg can never
    // be true for is a body the runner never executes.
    { pattern: /#\s*\[\s*cfg\s*\(\s*any\s*\(\s*\)\s*\)\s*\]/, desc: "Injected impossible cfg attribute (#[cfg(any())]) — the test never compiles" },
  ];

  // `#` and `--` belong here for the same reason the dialects belong in
  // ASSERTION_PATTERN: a Ruby or Python assertion commented out is exactly
  // as gone as a JavaScript one, and was previously not looked for.
  const COMMENTED_ASSERTION =
    /^\+\s*(?:\/\/|\/\*|#|--)\s*(?:expect\s*\(|assert(?!ion|ing|ed\b|s\b)[a-zA-Z0-9_$]*\s*[.(]|assert\s|refute_|XCTAssert|t\.expect|t\.assert)/i;

  const VACUOUS_ASSERTIONS = [
    { pattern: /\bassert(?:\.ok)?\s*\(\s*true\s*(?:,[^)]*)?\)/i, desc: "Vacuous truth assertion (assert.ok(true))" },
    { pattern: /\bassert\.(?:strictEqual|deepStrictEqual|equal|deepEqual)\s*\(\s*([^,]+?)\s*,\s*\1\s*(?:,[^)]*)?\)/i, desc: "Vacuous identity assertion (assert.equal(X, X))" },
    { pattern: /\bexpect\s*\(\s*true\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*true\s*\)/i, desc: "Vacuous truth expectation (expect(true).toBe(true))" },
    { pattern: /\bexpect\s*\(\s*([^)]+?)\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/i, desc: "Vacuous identity expectation (expect(X).toBe(X))" },
    { pattern: /\bexpect\s*\(\s*true\s*\)\s*\.toBeTruthy\s*\(/i, desc: "Vacuous truth expectation (expect(true).toBeTruthy())" },
    { pattern: /\bexpect\s*\(\s*false\s*\)\s*\.toBeFalsy\s*\(/i, desc: "Vacuous falsity expectation (expect(false).toBeFalsy())" },
    { pattern: /\bassert\.(?:isTrue|isOk)\s*\(\s*true\s*(?:,[^)]*)?\)/i, desc: "Vacuous truth assertion (assert.isTrue(true))" },
    { pattern: /\bassert\.(?:isFalse|isNotOk)\s*\(\s*false\s*(?:,[^)]*)?\)/i, desc: "Vacuous falsity assertion (assert.isFalse(false))" },
    { pattern: /\b(?:XCT)?assertTrue\s*\(\s*true\s*[,)]/i, desc: "Vacuous truth assertion (assertTrue(true))" },
    { pattern: /\b(?:XCT)?assertFalse\s*\(\s*false\s*[,)]/i, desc: "Vacuous falsity assertion (assertFalse(false))" },
    { pattern: /\b(?:assertEquals|assertSame|XCTAssertEqual)\s*\(\s*([^,]+?)\s*,\s*\1\s*[,)]/i, desc: "Vacuous identity assertion (assertEquals(X, X))" },
    { pattern: /\bassert_equal\s*\(?\s*([^,]+?)\s*,\s*\1\s*\)?\s*$/i, desc: "Vacuous identity assertion (assert_equal X, X)" },
    { pattern: /\bexpect\s*\(\s*true\s*\)\s*\.to\s+be(?:\s+true)?\b/i, desc: "Vacuous truth expectation (expect(true).to be true)" },
    // AVA and node:test: `t.true(true)` / `t.assert(true)` assert a constant
    // the test itself supplied. The trial replaced `t.is(limit.activeCount,
    // 0)` with `t.true(true)` in a file the guard did not even classify.
    { pattern: /\b[a-z_$][a-z0-9_$]{0,2}\.(?:true|truthy|assert|ok)\s*\(\s*true\s*\)/i, desc: "Vacuous truth assertion (t.true(true))" },
    { pattern: /\b[a-z_$][a-z0-9_$]{0,2}\.(?:false|falsy|notOk)\s*\(\s*false\s*\)/i, desc: "Vacuous falsity assertion (t.false(false))" },
  ];

  // Broad on purpose: this is the denominator, not the verdict. A word
  // boundary immediately after `assert` never falls in `assertEquals`,
  // `assert_equal` or `XCTAssertEqual`, so five ecosystems contributed no
  // assertions to count at all and a gutted JUnit suite was arithmetically
  // indistinguishable from an untouched one. The lookahead keeps prose and
  // identifiers — `assertion`, `asserts`, `asserted` — out of the count.
  const ASSERTION_PATTERN =
    /(?:\b(?:assert(?!ion|ing|ed\b|s\b)[a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$]+)?|refute[a-zA-Z0-9_$]*|XCTAssert[a-zA-Z0-9_$]*|XCTFail|expect|[a-z_$][a-z0-9_$]{0,2}\.(?:equal|equals|same|strictSame|deepEqual|notEqual|notSame|match|hasStrict|type|throws|rejects|ok|notOk)|t\.(?:assert|expect|is|equal|true|false|Errorf|Fatalf)|require\.[a-zA-Z0-9_$]+)\b|assert!|assert_eq!|assert_ne!)/i;
  // The loose net. Not a verdict and never a block — its only job is to
  // notice that a line was plainly an assertion in *some* dialect that
  // ASSERTION_PATTERN did not recognise. Without it, adding the seventh
  // ecosystem is indistinguishable from having covered it all along: the
  // guard returns the same clean PASS either way. This is the denominator
  // for the denominator.
  // Deliberately not call-shaped. Haskell's `x `shouldBe` 3` is an
  // assertion with no parentheses anywhere near it, and a net that only
  // catches `name(` reports the same confident PASS on it as on a clean
  // Node suite. `require` and `check` are absent on purpose: in a
  // CommonJS test file `require("./calc")` is an import, not a claim.
  const ASSERTION_SHAPED =
    /\b(?:assert(?!ion|ing|ed\b|s\b)|expect(?!ed\b|ation)|refute)[a-zA-Z0-9_$]*\b|`\s*should[a-zA-Z0-9_$]*\s*`|\b(?:should|must|verify|ensure|confirm)[a-zA-Z0-9_$]*\s*[(!]|\.\s*(?:should|to|to_not|not_to|must)\b|\bBOOST_[A-Z_]+\s*\(|\b[A-Z]+_(?:EQ|NE|TRUE|FALSE|THAT)\s*\(/;
  // `#` starts a line comment in Python/Ruby — but in Rust it opens an
  // attribute (`#[test]`, `#![...]`), which is code the runner keys off:
  // reading it as a comment is how `#[test]` removal used to slip past both
  // the declaration scan and the attribute check.
  const isCommentLine = (str) => /^\s*(?:\/\/|\/\*|\*|#(?![![])|--|;)/.test(str);

  /** Book-keeping only: what this run looked at, before deciding anything. */
  const countExamined = (stats, text) => {
    if (!text.trim() || isCommentLine(text)) return;
    stats.examined++;
    if (ASSERTION_PATTERN.test(text)) stats.recognised++;
    else if (ASSERTION_SHAPED.test(text) && stats.unreadable.length < 5) stats.unreadable.push(text.trim().slice(0, 120));
  };

  const fileAssertions = new Map();
  let pendingHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if ((line.startsWith("--- ") || line.startsWith("--- a/")) && !line.startsWith("----")) {
      const orig = line.slice(3).split("\t")[0].trim().replace(/^a\//, "");
      lastOldFile = orig && orig !== "/dev/null" ? orig : null;
      continue;
    }

    if ((line.startsWith("+++ ") || line.startsWith("+++ b/") || line.startsWith("+++ /dev/null")) && !line.startsWith("++++")) {
      const target = line.slice(3).split("\t")[0].trim().replace(/^b\//, "");
      currentFile = target && target !== "/dev/null" ? target : lastOldFile;
      currentOldLineNo = null;
      currentNewLineNo = null;
      pendingHunk = false;
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch) {
      currentOldLineNo = Number(hunkMatch[1]);
      currentNewLineNo = Number(hunkMatch[2]);
      pendingHunk = true;
      continue;
    }

    if (!currentFile || !isTestFile(currentFile)) {
      pendingHunk = false;
      continue;
    }

    if (!fileAssertions.has(currentFile)) {
      fileAssertions.set(currentFile, { removed: [], added: 0, addedTexts: [], removedSpecific: [], addedSpecific: 0, hunks: [], examined: 0, recognised: 0, unreadable: [], declRemoved: [], declAdded: [] });
    }
    const fileStats = fileAssertions.get(currentFile);
    if (pendingHunk) {
      fileStats.hunks.push({ lines: [] });
      pendingHunk = false;
    }
    const hunk = fileStats.hunks.length > 0 ? fileStats.hunks[fileStats.hunks.length - 1] : null;

    if (line.startsWith("-") && !line.startsWith("---")) {
      const deletedText = line.slice(1);
      if (hunk) hunk.lines.push({ kind: "-", text: deletedText, oldNo: currentOldLineNo, newNo: null });
      countExamined(fileStats, deletedText);
      if (!isCommentLine(deletedText)) {
        const decl = declaredTestName(deletedText);
        if (decl) fileStats.declRemoved.push({ ...decl, line: currentOldLineNo, text: deletedText });
      }
      if (!isCommentLine(deletedText) && ASSERTION_PATTERN.test(deletedText)) {
        fileStats.removed.push({ line: currentOldLineNo, text: deletedText });
        if (isSpecificAssertion(deletedText)) {
          fileStats.removedSpecific.push({ line: currentOldLineNo, text: deletedText });
        }
      }
      if (currentOldLineNo !== null) currentOldLineNo++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedText = line.slice(1);
      if (hunk) hunk.lines.push({ kind: "+", text: addedText, oldNo: null, newNo: currentNewLineNo });
      countExamined(fileStats, addedText);
      if (!isCommentLine(addedText)) {
        const decl = declaredTestName(addedText);
        if (decl) fileStats.declAdded.push({ ...decl, line: currentNewLineNo, text: addedText });
      }
      let isVacuous = false;

      // Check skip injections
      for (const skipRule of SKIP_INJECTIONS) {
        if (skipRule.pattern.test(addedText)) {
          violations.push({
            file: currentFile,
            line: currentNewLineNo,
            type: "TEST_SKIP_INJECTION",
            reason: `Test Tamper Guard: ${skipRule.desc} found in ${currentFile}${currentNewLineNo ? `:${currentNewLineNo}` : ""}`,
          });
        }
      }

      // Check vacuous assertions
      for (const vacuousRule of VACUOUS_ASSERTIONS) {
        if (vacuousRule.pattern.test(addedText)) {
          isVacuous = true;
          violations.push({
            file: currentFile,
            line: currentNewLineNo,
            type: "VACUOUS_ASSERTION",
            reason: `Test Tamper Guard: ${vacuousRule.desc} detected in ${currentFile}${currentNewLineNo ? `:${currentNewLineNo}` : ""}`,
          });
        }
      }

      // Go build constraints (ignore / private-tag tightening) are assessed
      // as a hunk post-pass below, because their witness — the removed
      // constraint line — is not present while this added line is scanned.

      // Check commented-out assertions
      let isCommented = false;
      if (COMMENTED_ASSERTION.test(line)) {
        isCommented = true;
        violations.push({
          file: currentFile,
          line: currentNewLineNo,
          type: "COMMENTED_ASSERTION",
          reason: `Test Tamper Guard: Commented-out test assertion detected in ${currentFile}${currentNewLineNo ? `:${currentNewLineNo}` : ""}`,
        });
      }

      // If valid non-vacuous, non-commented assertion is added, increment added count
      if (!isVacuous && !isCommented && !isCommentLine(addedText) && ASSERTION_PATTERN.test(addedText)) {
        fileStats.added++;
        fileStats.addedTexts.push({ line: currentNewLineNo, text: addedText });
        if (isSpecificAssertion(addedText)) fileStats.addedSpecific++;
      }

      if (currentNewLineNo !== null) currentNewLineNo++;
    } else if (!line.startsWith("\\")) {
      // Context line. It is file text in both images, so the statement
      // assembler needs it to reassemble assertions that span a changed
      // line; `diff --git`/`index` lines that sneak in here are not
      // diff body and are not collected.
      if (hunk && (line.startsWith(" ") || line === "")) {
        hunk.lines.push({ kind: " ", text: line.slice(1), oldNo: currentOldLineNo, newNo: currentNewLineNo });
      }
      if (currentOldLineNo !== null) currentOldLineNo++;
      if (currentNewLineNo !== null) currentNewLineNo++;
    }
  }

  // An assertion is a statement, not a line.
  //
  // Counting `+`/`-` lines missed the commonest shape in every language with
  // multi-line calls: `self.assertEqual(` sits on an unchanged context line
  // and only its argument lines are edited. Nothing among the changed lines
  // matched an assertion pattern, nothing looked assertion-shaped either, so
  // the guard reported `assertionsSeen: 0` and — because no line looked
  // suspicious — a clean PASS. A five-element expected list rewritten to one
  // element to match broken output sailed through five green phases.
  //
  // The statement machinery that already exists for pairing knows better:
  // it assembles context lines together with changed ones. Ask it.
  for (const [file, stats] of fileAssertions.entries()) {
    const lang = langForTestFile(file);
    let touched = 0;
    let stmtSpecificRemoved = 0;
    let stmtSpecificAdded = 0;
    for (const hunk of stats.hunks) {
      const oldSlice = [];
      const newSlice = [];
      for (const L of hunk.lines) {
        if (L.kind !== "+") oldSlice.push(L);
        if (L.kind !== "-") newSlice.push(L);
      }
      // Specific assertions are counted per side, on the reassembled
      // statement. The weakening check was still line-based: `assert (` alone
      // on a line names no value, so Black or Ruff splitting one assertion
      // across three lines removed one specific assertion and added none, and
      // a reformat was reported as CRITICAL tampering. Collapsing the joined
      // statement is what lets the bare-comparison form be recognised at all
      // — its pattern cannot cross a newline.
      const sides = [
        { stmts: assembleStatements(oldSlice, lang), kind: "-" },
        { stmts: assembleStatements(newSlice, lang), kind: "+" },
      ];
      for (const { stmts, kind } of sides) {
        for (const st of stmts) {
          const changed = kind === "-" ? (st.removedLines?.length || 0) > 0 : (st.addedLines?.length || 0) > 0;
          if (!changed) continue;
          const clean = stripComments(st.text, lang);
          if (ASSERTION_PATTERN.test(clean)) touched++;
          if (isSpecificAssertion(collapseWhitespace(clean))) {
            if (kind === "-") stmtSpecificRemoved++;
            else stmtSpecificAdded++;
          }
        }
      }
    }
    stats.statementAssertions = touched;
    stats.stmtSpecificRemoved = stmtSpecificRemoved;
    stats.stmtSpecificAdded = stmtSpecificAdded;
  }

  // Assertions added in some *other* file of this same diff.
  //
  // Tracking is strictly per file, so moving a test from one file to another
  // — ordinary refactoring — read as deleting three assertions and was
  // reported as CRITICAL tampering. The assertion still exists and still
  // runs; it is in a different file. What the removal check is for is
  // verification that *disappeared*, and this has not.
  //
  // Deliberately exact on the assertion text: something that changed on the
  // way across is not a move, and is judged normally.
  const movedIn = new Map();
  for (const [file, stats] of fileAssertions.entries()) {
    for (const t of stats.addedTexts || []) {
      const key = collapseWhitespace(String(t.text ?? t)).trim();
      if (!key) continue;
      if (!movedIn.has(key)) movedIn.set(key, []);
      movedIn.get(key).push(file);
    }
  }

  // A test renamed out of its runner's discovery convention.
  //
  // pytest collects `test*` and nothing else, so `def test_totals` becoming
  // `def check_totals` deletes the test from every future run while leaving it
  // in the file, fully written, with all its assertions intact. Every count in
  // this guard stays level: nothing removed, weakened or rewritten.
  //
  // The earlier rule required the new name to be the old one with its prefix
  // literally stripped (`test_x` -> `x` caught; `test_x` -> `check_x` not).
  // The collected check is what actually matters, and it already keeps the
  // honest renames silent — `test_x` -> `test_x_renamed`, pytest's `test*`
  // glob still collecting `testx`, Go's `TestX` -> `TestXRenamed` — so the
  // narrow strip is gone.
  for (const [file, stats] of fileAssertions.entries()) {
    const takenAdds = new Set();
    for (const before of stats.declRemoved || []) {
      if (!before.collected) continue;
      const idx = (stats.declAdded || []).findIndex((after, i) => !takenAdds.has(i) && isDeregistration(before, after));
      if (idx === -1) continue;
      takenAdds.add(idx);
      const after = stats.declAdded[idx];
      violations.push({
        file,
        line: after.line ?? before.line,
        type: "TEST_DEREGISTERED",
        reason:
          `Test Tamper Guard: ${JSON.stringify(before.name)} was renamed to ${JSON.stringify(after.name)} in ${file}` +
          `${after.line ? `:${after.line}` : ""}. The runner collects tests by name, so the test still exists in ` +
          `the file and no longer runs — the same effect as deleting it, with none of the signs. ` +
          `If the test is genuinely obsolete, delete it; if it is being turned into a helper, say so with ` +
          `--allow-test-change deregistration.`,
      });
    }
  }

  // Runners that register by attribute/annotation rather than by name: Rust's
  // `#[test]` (the name above the function is free-form, so the name pair
  // above cannot see this family) and JUnit's `@Test`. Removing the attribute
  // from an existing function keeps the body and loses the test — the same
  // uncollect with no line deleted.
  const TEST_ATTR_PATTERNS = [
    { lang: "rust", re: /^\s*#\s*\[\s*(?:test|tokio::test|async_std::test)\s*\]/ },
    // JUnit/TestNG annotations live in files the scanner lexes as `js`
    // (the C-like family), so the lang here is the scanner's lang, not the
    // source language's name.
    { lang: "js", re: /^\s*@(?:org\.junit\.)?(?:jupiter\.api\.)?Test\b/ },
  ];
  const attrRegistration = (text, file) => {
    const lang = langForTestFile(file);
    return TEST_ATTR_PATTERNS.some((rule) => rule.lang === lang && rule.re.test(text));
  };

  // Function signature text of the declaration the attribute at `start`
  // governs. Attributes sit immediately above `fn x()` / `void x()`, so the
  // next declaration line in the hunk carries the signature; scanning
  // backwards covers an attribute written on a context line position.
  const FN_SIG_RE = /\b(?:fn|func|def)\s+[A-Za-z_]\w*\s*\(|\b(?:void|[A-Za-z_][\w.<>\[\]]*)\s+[A-Za-z_]\w*\s*\([^;]*\)\s*(?:\{|$|throws\b)/;
  const adjacentSignature = (hunkLines, start) => {
    for (let k = start + 1; k < hunkLines.length; k++) {
      const t = hunkLines[k].text || "";
      if (FN_SIG_RE.test(t)) return collapseWhitespace(t).trim();
    }
    for (let k = start - 1; k >= 0; k--) {
      const t = hunkLines[k].text || "";
      if (FN_SIG_RE.test(t)) return collapseWhitespace(t).trim();
    }
    return null;
  };

  // Attribute arrivals across the whole diff: a registration lost in one
  // file is forgiven when the same signature gained one in another — a move
  // between test files is ordinary refactoring, the same allowance the
  // assertion-removal check makes for moved assertions.
  const attrArrivals = new Map(); // signature -> [files]
  for (const [file, stats] of fileAssertions.entries()) {
    for (const hunk of stats.hunks) {
      for (let i = 0; i < hunk.lines.length; i++) {
        const L = hunk.lines[i];
        if (L.kind !== "+" || !attrRegistration(L.text, file)) continue;
        const sig = adjacentSignature(hunk.lines, i);
        if (!sig) continue;
        if (!attrArrivals.has(sig)) attrArrivals.set(sig, []);
        attrArrivals.get(sig).push(file);
      }
    }
  }

  for (const [file, stats] of fileAssertions.entries()) {
    for (const hunk of stats.hunks) {
      const removedAttrs = [];
      let addedInHunk = 0;
      for (let i = 0; i < hunk.lines.length; i++) {
        const L = hunk.lines[i];
        if (L.kind === "-" && !isCommentLine(L.text) && attrRegistration(L.text, file)) {
          removedAttrs.push({ line: L.oldNo, text: L.text, sig: adjacentSignature(hunk.lines, i) });
        }
        if (L.kind === "+" && attrRegistration(L.text, file)) addedInHunk++;
      }
      // Net loss within the hunk; same-file additions cancel one for one
      // (a test renamed or re-attributed counts even).
      let deficit = removedAttrs.length - addedInHunk;
      for (const attr of removedAttrs) {
        if (deficit <= 0) break;
        const landed = attr.sig ? attrArrivals.get(attr.sig) : null;
        if (landed) {
          const elsewhere = landed.findIndex((f) => f !== file);
          if (elsewhere !== -1) {
            landed.splice(elsewhere, 1);
            continue;
          }
        }
        deficit--;
        violations.push({
          file,
          line: attr.line,
          type: "TEST_DEREGISTERED",
          reason:
            `Test Tamper Guard: a test-registration attribute was removed from an existing function in ${file}` +
            `${attr.line ? `:${attr.line}` : ""} (${collapseWhitespace(attr.text).trim()}). ` +
            `The runner only executes functions carrying that attribute, so the test still exists in the file ` +
            `and no longer runs — the same effect as deleting it, with none of the signs. If the test is ` +
            `genuinely obsolete, delete it; if it is becoming a helper, say so with ` +
            `--allow-test-change deregistration.`,
        });
      }
    }
  }

  // A failure call parked behind a condition that cannot hold. Keeping the
  // `t.Errorf` while swapping its guard for `if len(s) < 0` (a Go string or
  // slice length is never negative) preserves every line of the old
  // assertion in code that can never run — F05, measured approving the
  // neutralised test. This is a hunk post-pass rather than an added-line
  // rule because the failure call it protects is untouched code: it sits on
  // a context line, which the line-by-line scan has not walked over yet.
  //
  // Only conditions that are impossible on their face are looked at
  // (`len(...) < 0`, an unsigned/size count `<= -1`); anything fuzzier — a
  // flag flipped elsewhere, a branch behind real state — is not guessable
  // from a diff and is deliberately left alone. The failure call has to be
  // reachable inside the condition's block, or an impossible condition in
  // ordinary test setup would be misread as one.
  for (const [file, stats] of fileAssertions.entries()) {
    for (const hunk of stats.hunks) {
      for (let i = 0; i < hunk.lines.length; i++) {
        const L = hunk.lines[i];
        if (L.kind !== "+" || !DEAD_GUARD_CONDITION.test(L.text)) continue;
        const guardLineNo = L.newNo;
        const guardText = L.text;
        const isFailureOrAssertion = (text) => FAILURE_CALL.test(text) || ASSERTION_PATTERN.test(text);
        let found = false;

        if (guardText.includes("{")) {
          let depth = (guardText.match(/\{/g) || []).length - (guardText.match(/\}/g) || []).length;
          if (depth > 0 && isFailureOrAssertion(guardText.slice(guardText.indexOf("{")))) {
            found = true;
          }
          for (let k = i + 1; k < hunk.lines.length && depth > 0; k++) {
            const t = hunk.lines[k].text || "";
            const opens = (t.match(/\{/g) || []).length;
            const closes = (t.match(/\}/g) || []).length;
            if (depth > 0 && isFailureOrAssertion(t)) { found = true; break; }
            depth += opens - closes;
          }
        } else {
          // Indentation-based block (Python, etc.) or single-line guard without braces
          const colonIdx = guardText.indexOf(":");
          const parenIdx = guardText.lastIndexOf(")");
          const afterGuard = colonIdx !== -1 ? guardText.slice(colonIdx + 1) : (parenIdx !== -1 ? guardText.slice(parenIdx + 1) : "");
          if (afterGuard && isFailureOrAssertion(afterGuard)) {
            found = true;
          } else {
            const guardIndent = (guardText.match(/^\s*/)?.[0] || "").length;
            for (let k = i + 1; k < hunk.lines.length; k++) {
              const t = hunk.lines[k].text || "";
              if (!t.trim() || isCommentLine(t)) continue;
              const lineIndent = (t.match(/^\s*/)?.[0] || "").length;
              if (lineIndent <= guardIndent) break;
              if (isFailureOrAssertion(t)) { found = true; break; }
            }
          }
        }

        if (found) {
          violations.push({
            file,
            line: guardLineNo,
            type: "VACUOUS_ASSERTION",
            reason:
              `Test Tamper Guard: the assertion or failure call in ${file}${guardLineNo ? `:${guardLineNo}` : ""} ` +
              `is guarded by a condition that can never be true ("${collapseWhitespace(guardText).trim()}"), so the ` +
              `assertion cannot fail. Keeping the assertion in dead logic is not preservation of verification.`,
          });
        }
      }
    }
  }

  // Go build constraints that exclude a test file from the ordinary run.
  // `//go:build ignore` never matches a release build; conjoining a private
  // tag onto an existing constraint (`go1.7` -> `go1.7 && my_tag`) excludes
  // the file unless a CI job sets that tag. Version, OS and arch terms are
  // legitimate gating, so only an impossible ignore or a new private term
  // counts.
  for (const [file, stats] of fileAssertions.entries()) {
    if (langForTestFile(file) !== "go") continue;
    for (const hunk of stats.hunks) {
      for (let i = 0; i < hunk.lines.length; i++) {
        const L = hunk.lines[i];
        if (L.kind !== "+") continue;
        const terms = goBuildTerms(L.text);
        if (!terms) continue;
        if (terms.every((t) => t === "ignore") || terms.includes("ignore")) {
          violations.push({
            file,
            line: L.newNo,
            type: "TEST_SKIP_INJECTION",
            reason:
              `Test Tamper Guard: Go build constraint ${JSON.stringify(collapseWhitespace(L.text).trim())} in ${file}` +
              `${L.newNo ? `:${L.newNo}` : ""} excludes this test file from the ordinary 'go test' run — the ignore tag never ` +
              `matches a release build. Use --allow-test-change skip if the file is built by a deliberately separate command.`,
          });
          continue;
        }
        const oldTerms = new Set();
        for (const O of hunk.lines) {
          if (O.kind !== "-") continue;
          const t = goBuildTerms(O.text);
          if (t) for (const term of t) oldTerms.add(term);
        }
        const privateTag = terms.find((t) => !goKnownBuildTerm(t) && !oldTerms.has(t));
        if (privateTag) {
          violations.push({
            file,
            line: L.newNo,
            type: "TEST_SKIP_INJECTION",
            reason:
              `Test Tamper Guard: Go build constraint tightened with the private tag ${JSON.stringify(privateTag)} in ` +
              `${file}${L.newNo ? `:${L.newNo}` : ""} — a tag no ordinary 'go test' run sets excludes this test file from the ` +
              `suite. Version/OS/arch gating stays silent; a tag nobody passes is a skip. Use --allow-test-change skip ` +
              `if the tag is gated in CI on purpose.`,
          });
        }
      }
    }
  }

  // An unconditional early return as the test body's first statement. A test
  // that returns before its assertions keeps the suite green while
  // verifying nothing — the trial made a broken function pass this way.
  // Unlike the skip above this spelling has no marker, so the declaration
  // has to be visible as the nearest non-blank line above the return:
  // `return` as a genuine guard clause (after a real condition or check)
  // never sits with a test signature as its predecessor, and a `return`
  // inside the body an honest refactor edited is past body-open already.
  for (const [file, stats] of fileAssertions.entries()) {
    for (const hunk of stats.hunks) {
      for (let i = 0; i < hunk.lines.length; i++) {
        const L = hunk.lines[i];
        if (L.kind !== "+" || !BARE_EARLY_RETURN.test(L.text)) continue;
        for (let k = i - 1; k >= 0; k--) {
          const t = (hunk.lines[k].text || "").trim();
          if (!t) continue;
          if (TEST_BODY_OPEN.test(hunk.lines[k].text || "")) {
            violations.push({
              file,
              line: L.newNo,
              type: "TEST_SKIP_INJECTION",
              reason:
                `Test Tamper Guard: an unconditional early return opens the test body in ` +
                `${file}${L.newNo ? `:${L.newNo}` : ""}, so none of the assertions after it run while the test still ` +
                `passes. A suite cannot verify what control flow never reaches. Use --allow-test-change skip if this ` +
                `test is deliberately dormant.`,
            });
          }
          break;
        }
      }
    }
  }

  for (const [file, stats] of fileAssertions.entries()) {
    // An expectation that was rewritten rather than removed.
    //
    // Counting assertions cannot see this one: `assert.equal(add(1,2), 3)`
    // becoming `assert.equal(add(1,2), -1)` takes one specific assertion out
    // and puts one specific assertion back, so every total stayed level and
    // the guard said nothing — while the suite went from checking that
    // addition works to certifying that it is broken. It is the single
    // cheapest way to make a red suite green, and the one this tool exists
    // to refuse. The line-based version of this pairing could only see the
    // single-line spelling of the edit; the reassembled-statement version
    // above sees every spelling, and explains why on the way.
    detectExpectationRewrites(file, stats.hunks, stats, violations);

    if (stats.removed.length > stats.added) {
      const unreplaced = stats.removed.slice(stats.added);
      for (const item of unreplaced) {
        // Did this exact assertion arrive somewhere else in the same diff?
        const key = collapseWhitespace(item.text).trim();
        const landing = movedIn.get(key);
        const elsewhere = landing ? landing.findIndex((f) => f !== file) : -1;
        if (elsewhere !== -1) {
          // Consume the landing so two removals cannot both claim one arrival.
          landing.splice(elsewhere, 1);
          continue;
        }
        violations.push({
          file,
          line: item.line,
          type: "ASSERTION_REMOVAL",
          reason: `Test Tamper Guard: Assertion removed without replacement in ${file}${item.line ? `:${item.line}` : ""}: "${item.text.trim()}"`,
        });
      }
    }

    // Replacing an assertion is not the same as keeping one. Counting totals
    // let a specific expectation be swapped for a vague one at no cost — one
    // out, one in, guard silent, suite no longer checking the answer. What must
    // not fall is the number of assertions that name an expected value.
    //
    // Only the *replaced* ones are reported here. An assertion deleted outright
    // is already an ASSERTION_REMOVAL above, and emitting both would report the
    // same line twice under two names.
    const alreadyReportedSpecific = stats.removed
      .slice(stats.added)
      .filter((item) => isSpecificAssertion(item.text)).length;
    // Believe whichever unit saw more arrive. A statement is the honest unit,
    // but the line count still carries cases the statement scanner cannot
    // assemble, so the loss is only what *both* agree was lost.
    const lineLost = Math.max(0, stats.removedSpecific.length - stats.addedSpecific);
    const stmtLost = Math.max(0, (stats.stmtSpecificRemoved || 0) - (stats.stmtSpecificAdded || 0));
    const specificLost = Math.min(lineLost, stmtLost);
    const weakenedCount = Math.max(0, specificLost - alreadyReportedSpecific);

    if (weakenedCount > 0) {
      for (const item of stats.removedSpecific.slice(stats.addedSpecific, stats.addedSpecific + weakenedCount)) {
        violations.push({
          file,
          line: item.line,
          type: "ASSERTION_WEAKENED",
          reason: `Test Tamper Guard: Assertion weakened in ${file}${item.line ? `:${item.line}` : ""} — an assertion naming an expected value was replaced by one that does not: "${item.text.trim()}"`,
        });
      }
    }
  }

  // A kind the operator has already looked at and accepted is dropped here
  // rather than never being computed, so the reasoning above stays one code
  // path regardless of what any given run allows.
  const reported =
    allowed.kinds.size === 0
      ? violations
      : violations.filter((v) => !allowed.kinds.has(TAMPER_KINDS.get(v.type)));

  // What was examined, not only what was found.
  //
  // `ok: true` from a guard that looked at nothing is byte-identical to
  // `ok: true` from a guard that looked at everything and approved it. That
  // ambiguity is how a substring bug in the file classifier switched this
  // entire guard off for the standard pytest, Rust and RSpec layouts while
  // every signal stayed green.
  //
  // Counting *files* was not enough. A JUnit diff that rewrote an expected
  // value produced `inputsSeen: 1` and a clean PASS while not one assertion
  // in it had been recognised — the same ambiguity, one level down, inside
  // the mechanism built to remove it. So the denominator is now the thing
  // the rules actually consume: lines examined, and of those, assertions
  // understood. `UNREADABLE` is the state that has no business being silent
  // — assertion-shaped lines were present and none of them parsed, which
  // means this repository speaks a dialect the guard does not.
  let examined = 0;
  let assertionsSeen = 0;
  const unreadable = [];
  for (const [file, stats] of fileAssertions.entries()) {
    examined += stats.examined;
    assertionsSeen += Math.max(stats.recognised, stats.statementAssertions || 0);
    if (stats.unreadable.length > 0) {
      unreadable.push({ file, count: stats.unreadable.length, samples: stats.unreadable.slice(0, 3) });
    }
  }

  // Changed lines inside a test file, none of them recognisable as part of an
  // assertion, is not the same as "checked and clean" — it is the state where
  // this guard has nothing to say. Saying nothing and saying "approved" have
  // to look different, which is the whole reason `status` exists.
  // `unreadable` is the evidence, and it is required.
  //
  // `|| examined > 0` used to stand here, and it threw away the distinction
  // this whole apparatus exists to draw. `ASSERTION_SHAPED` and `unreadable[]`
  // were built to separate "assertion-shaped lines were present and none of
  // them parsed" — a dialect the guard cannot read — from "there were no
  // assertions in these lines at all", which is most ordinary work on a test
  // file. That clause collapsed the two, so *any* changed substantive line in
  // a test file with no recognised assertion became a CRITICAL block:
  // measured on `pytest-dev/iniconfig`, renaming a test function did it, and
  // so did adding `import os`.
  //
  // The tell was in the finding itself: it carried `file: null`, `line: null`
  // and no sample, because `unreadable` was empty — the guard blocked while
  // holding no evidence of anything, and advised a pytest repository that its
  // assertion library might be unsupported, from a list that names pytest.
  //
  // Nothing is weakened by requiring the evidence. A removed or rewritten
  // assertion is a recognised assertion line, so it raises `assertionsSeen`
  // and goes to the ordinary removal and weakening checks; it never reached
  // this branch. What is lost is only the blanket, and a blanket that fires
  // on `import os` teaches its way around itself: the remedy it printed was
  // `tamperGuard: "warn"`, which switches the real guard off too.
  const status =
    reported.length > 0
      ? "FAIL"
      : assertionsSeen === 0 && unreadable.length > 0
        ? "UNREADABLE"
        : examined > 0
          ? "PASS"
          : "NOT_APPLICABLE";

  return {
    ok: reported.length === 0,
    violations: reported,
    inputsSeen: examined,
    filesSeen: fileAssertions.size,
    assertionsSeen,
    unreadable,
    status,
  };
}

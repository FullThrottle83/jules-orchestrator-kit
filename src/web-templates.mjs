/**
 * Zero-dependency Web Development Task Templates & Envelopes for Google Jules.
 * Implements Google Labs Exploration Budgets and Critic Agent steering.
 */

export const WEB_TEMPLATES = {
  "web-cwv": {
    id: "web-cwv",
    name: "Core Web Vitals & Lighthouse Budget Guard",
    description: "Audit and optimize frontend performance against hard Core Web Vitals and Lighthouse metrics.",
    defaultVerifyCmd: "npm run build && npx lhci autorun || npm test",
    category: "Performance",
    criticFocus: [
      "Check for un-optimized dynamic imports and excessive JavaScript bundle size.",
      "Verify that all newly introduced images have explicit width/height and loading='lazy' decoding='async'.",
      "Ensure font preloading uses fetchpriority='high' and prevents Cumulative Layout Shift (CLS).",
      "Verify that critical CSS is not blocked by third-party analytics or non-critical scripts.",
      "Ensure server:defer / dynamic deferrals are NOT applied to static marketing prose or static landing components."
    ],
    defaultParams: {
      lcpMaxMs: 1200,
      clsMax: 0.05,
      inpMaxMs: 100,
      targetPage: "/",
      strategy: "mobile"
    },
    generatePrompt: (params = {}) => {
      const page = params.targetPage || "/";
      const lcp = params.lcpMaxMs || 1200;
      const cls = params.clsMax || 0.05;
      const inp = params.inpMaxMs || 100;
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit and optimize Core Web Vitals & performance for '${page}'.${customGoal}

### Quantitative Performance Budget:
- **Largest Contentful Paint (LCP)**: < ${lcp}ms
- **Cumulative Layout Shift (CLS)**: < ${cls}
- **Interaction to Next Paint (INP)**: < ${inp}ms
- **Render-Blocking Resources**: 0 non-critical render-blocking assets

### Required Architectural Actions:
1. Eliminate unused CSS and JavaScript chunks on '${page}'.
2. Preload above-the-fold hero images / fonts using \`<link rel="preload">\` with correct \`fetchpriority\`.
3. Wrap below-the-fold heavy dynamic components in lazy-loading.
4. Ensure zero content shifts during font swaps or dynamic component mounting.
5. Invariant: Do NOT apply server-deferral / streaming to static marketing text; reserve for heavy dynamic data.`;
    }
  },

  "web-wcag": {
    id: "web-wcag",
    name: "WCAG 2.2 AA/AAA & Semantic A11y Audit",
    description: "Eliminate accessibility violations, contrast defects, keyboard focus traps, and ARIA anti-patterns.",
    defaultVerifyCmd: "npx axe-cli http://localhost:3000 || npx pa11y http://localhost:3000 || npm test",
    category: "Accessibility",
    criticFocus: [
      "Check for redundant or incorrect role attributes on native HTML elements (e.g. role='button' on <button>).",
      "Verify that all interactive modals properly trap focus and restore focus to the trigger element on close (Escape).",
      "Ensure all dynamic content updates use appropriate aria-live regions ('polite' vs 'assertive').",
      "Verify that color contrast ratios strictly meet WCAG AA (4.5:1 for normal text, 3:1 for large) or AAA."
    ],
    defaultParams: {
      standard: "WCAG 2.2 AA",
      targetComponentOrRoute: "all routes",
      minContrastRatio: "4.5:1"
    },
    generatePrompt: (params = {}) => {
      const target = params.targetComponentOrRoute || "all routes";
      const standard = params.standard || "WCAG 2.2 AA";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Perform a comprehensive accessibility (a11y) audit and remediation for ${target} conforming to ${standard}.${customGoal}

### Accessibility Hard Invariants:
1. **Semantic HTML5**: Replace non-semantic \`<div>\`/\`<span>\` clickable elements with native \`<button>\`, \`<dialog>\`, or \`<a>\`.
2. **Keyboard Navigation & Focus Management**:
   - All interactive controls must have visible, high-contrast focus rings (\`:focus-visible\`).
   - Modals and drawers must trap Tab navigation inside and close cleanly on \`Escape\` keypress.
   - Screen reader announcements for state changes (loading, errors, notifications) via \`aria-live\`.
3. **Form & Input Labels**:
   - Every input element must be explicitly associated with a \`<label for="...">\` or have an unambiguous \`aria-label\`.
   - Error messages must be linked via \`aria-describedby\` and \`aria-invalid="true"\`.
4. **Color & Contrast**:
   - Text elements must satisfy minimum ${params.minContrastRatio || "4.5:1"} contrast ratio in both Light and Dark themes.`;
    }
  },

  "web-seo": {
    id: "web-seo",
    name: "Structured Data (JSON-LD), OpenGraph & Canonical SEO Guard",
    description: "Audit and implement schema.org structured data, metadata tags, sitemaps, and canonical link integrity.",
    defaultVerifyCmd: "npm run build && node scripts/validate-seo.mjs || npm test",
    category: "SEO & Content",
    criticFocus: [
      "Validate that all JSON-LD schemas contain mandatory Schema.org fields (e.g. @context, @type, name, url).",
      "Ensure canonical URLs use absolute HTTPS links without trailing slash inconsistencies.",
      "Check that OpenGraph (og:title, og:description, og:image) and Twitter Card tags match page content.",
      "Verify that dynamic routes generate corresponding valid sitemap.xml entries with valid lastmod ISO dates."
    ],
    defaultParams: {
      schemaType: "Article, WebSite, BreadcrumbList",
      targetRoutes: "public pages"
    },
    generatePrompt: (params = {}) => {
      const schemas = params.schemaType || "Article, WebSite, BreadcrumbList";
      const routes = params.targetRoutes || "public pages";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit and implement Schema.org structured data (JSON-LD) and metadata for ${routes}.${customGoal}

### SEO Requirements & Acceptance Criteria:
1. **Structured Data (JSON-LD)**:
   - Inject schema.org compliant \`<script type="application/ld+json">\` blocks for: ${schemas}.
   - Validate against Schema.org specifications with zero missing required fields.
2. **Meta & Social Graph Tags**:
   - Ensure every public page has a unique, descriptive \`<title>\` (50-60 chars) and \`<meta name="description">\` (120-155 chars).
   - Provide complete OpenGraph tags (\`og:title\`, \`og:description\`, \`og:image\`, \`og:url\`, \`og:type\`) and Twitter Card tags.
   - Guarantee image URLs in \`og:image\` are absolute HTTPS URLs.
3. **Canonical URLs & Crawlability**:
   - Implement consistent canonical tags (\`<link rel="canonical" href="...">\`).
   - Validate sitemap generation and ensure zero 404 links or redirect loops.`;
    }
  },

  "web-playwright": {
    id: "web-playwright",
    name: "Playwright Visual Regression & Responsive Breakpoint Oracle",
    description: "Author and verify end-to-end visual stability and responsive layout integrity across viewports.",
    defaultVerifyCmd: "npx playwright test || npm test",
    category: "Frontend QA",
    criticFocus: [
      "Verify that Playwright tests use strict, accessible locators (getByRole, getByLabel, getByText) rather than brittle CSS selectors.",
      "Ensure zero hard-coded arbitrary wait timeouts (e.g. page.waitForTimeout); use web assertions with automatic retries.",
      "Check that mobile viewports (375px) do not introduce horizontal scrollbars (document.body.scrollWidth > window.innerWidth).",
      "Confirm snapshot assertions use appropriate pixel threshold tolerance to avoid flaky anti-aliasing failures.",
      "Ensure tests execute cleanly in headless CI environments without requiring active X11/Wayland display servers."
    ],
    defaultParams: {
      viewports: "Mobile (375x667), Tablet (768x1024), Desktop (1440x900)",
      targetFeature: "UI components and navigation"
    },
    generatePrompt: (params = {}) => {
      const feature = params.targetFeature || "UI components and navigation";
      const viewports = params.viewports || "Mobile (375px), Tablet (768px), Desktop (1440px)";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Implement and verify Playwright E2E visual regression and responsive test suite for ${feature}.${customGoal}

### Test Harness & Assertion Criteria:
1. **Multi-Viewport Coverage**: Test and capture snapshots across: ${viewports}.
2. **Headless Sandbox Invariant**: Ensure all Playwright runs specify headless execution compatible with remote CI sandboxes.
3. **Responsive Invariants**:
   - Zero horizontal overflow on mobile viewports (\`overflow-x\` containment).
   - Tap target sizes for mobile touch buttons >= 44x44px.
   - Hamburger / collapsible navigation expands and closes with correct ARIA attributes.
4. **Resilient Locators**:
   - Use user-facing accessible locators (\`page.getByRole('button', { name: /submit/i })\`).
   - Never use arbitrary \`waitForTimeout(3000)\` sleeps; use \`expect(locator).toBeVisible()\`.
5. **Visual Snapshots**:
   - Verify visual snapshots pass with \`expect(page).toHaveScreenshot()\`.`;
    }
  },

  "agent-dead-code-audit": {
    id: "agent-dead-code-audit",
    name: "Dead Code Audit & Safe Removal Protocol",
    description: "Audit unused exports and dead code with the Audit-First Principle to prevent deleting dynamic runtime dependencies.",
    defaultVerifyCmd: "npm test",
    category: "Refactoring & Audit",
    criticFocus: [
      "Verify that flagged 'unused' exports are not dynamically imported at runtime or registered in dynamic router/plugin maps.",
      "Ensure the audit generates a structured report (.agent/reports/dead-code-audit.md) with confidence ratings before applying destructive file deletions.",
      "Check that zero core library entry points or framework-specific file-based routes are accidentally removed.",
      "Confirm all surviving test suites and typechecks pass with 0 errors after any proposed removal."
    ],
    defaultParams: {
      targetScope: "apps/ or src/",
      toolName: "Knip / ts-prune"
    },
    generatePrompt: (params = {}) => {
      const scope = params.targetScope || "src/";
      const tool = params.toolName || "Knip";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Perform an Audit-First dead code inspection and safe cleanup for ${scope} using ${tool}.${customGoal}

### Audit-First Safe Refactoring Invariants:
1. **Report Before Delete (Audit-First Principle)**:
   - Generate a markdown audit report at \`.agent/reports/dead-code-audit.md\` detailing suspected unused files/exports and confidence levels (High / Medium / Low).
   - DO NOT delete files or exports with dynamic runtime references (e.g. Astro/Next.js dynamic routes, plugin registries, CMS schemas).
2. **Conservative Scope**:
   - Only remove files verified to have 0 dynamic or static references.
   - When in doubt, document the finding in the audit report rather than deleting.
3. **Verification**:
   - Run typecheck and unit tests to ensure zero broken call sites.`;
    }
  },

  "web-flaky-heal": {
    id: "web-flaky-heal",
    name: "Playwright / Async Flakiness Auto-Healer",
    description: "Eliminate timing oscillations, race conditions, unmocked network calls, and unstable locators in E2E tests.",
    defaultVerifyCmd: "npx playwright test --repeat-each=5 || npm test",
    category: "QA & Stability",
    criticFocus: [
      "Identify non-deterministic timers and replace with condition-based web assertions.",
      "Verify all third-party network requests (analytics, CDNs) are intercepted or mocked during testing.",
      "Ensure test state isolation so tests do not leak local storage or cookies to subsequent test runs.",
      "Confirm that repeated test runs (--repeat-each=5) pass 100% cleanly without oscillation."
    ],
    defaultParams: {
      testFileOrSuite: "test/e2e/",
      repetitionCount: 5
    },
    generatePrompt: (params = {}) => {
      const testTarget = params.testFileOrSuite || "test/e2e/";
      const reps = params.repetitionCount || 5;
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Isolate and eliminate flaky test oscillations in ${testTarget}.${customGoal}

### Anti-Flakiness Rules & Remediation Invariants:
1. **Eliminate Arbitrary Sleep Calls**:
   - Replace all \`sleep()\`, \`setTimeout()\`, or \`page.waitForTimeout()\` with auto-retrying assertions like \`await expect(locator).toBeVisible()\`.
2. **Deterministic Network Interception**:
   - Mock all external API and analytics network requests using \`page.route()\` to prevent network latency spikes from failing tests.
3. **Strict Accessible Locators**:
   - Replace fragile DOM hierarchy selectors (e.g. \`div > div:nth-child(3)\`) with resilient role/text locators.
4. **State Isolation**:
   - Ensure every test operates in a clean browser context with isolated cookies and localStorage.
5. **Stability Verification**:
   - Test suite must pass cleanly across ${reps} consecutive runs without a single failure.`;
    }
  },

  "web-i18n": {
    id: "web-i18n",
    name: "Internationalization (i18n), Locale Routing & Hreflang Integrity",
    description: "Verify multi-language routing, symmetric hreflang alternate links, html lang attributes, and translation fallback safety.",
    defaultVerifyCmd: "npm test",
    category: "Internationalization & SEO",
    criticFocus: [
      "Confirm that hreflang alternate tags are fully bidirectional and symmetric across all locale variants.",
      "Check that the <html> tag dynamically renders the correct ISO 639-1 / BCP 47 lang attribute for the active route.",
      "Verify that localized URL slugs and route parameters handle non-ASCII unicode characters cleanly without encoding errors.",
      "Ensure missing translation keys resolve to configured fallback locales rather than displaying raw placeholder strings or throwing runtime exceptions."
    ],
    defaultParams: {
      targetLocales: "en, sv, de, fr",
      defaultLocale: "en",
      targetRoutes: "all public routes"
    },
    generatePrompt: (params = {}) => {
      const locales = params.targetLocales || "en, sv, de, fr";
      const defaultLoc = params.defaultLocale || "en";
      const routes = params.targetRoutes || "all public routes";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Implement and verify comprehensive Internationalization (i18n) and locale routing integrity for ${routes}.${customGoal}

### i18n & Hreflang Acceptance Criteria:
1. **Symmetric Hreflang Alternate Links**:
   - Every page across target locales (${locales}) must render bidirectional \`<link rel="alternate" hreflang="..." href="...">\` tags pointing to all counterparts, including self and \`hreflang="x-default"\` (pointing to ${defaultLoc}).
2. **HTML Root & Metadata Localization**:
   - The root \`<html lang="...">\` attribute must accurately match the active page locale.
   - Page \`<title>\`, \`<meta name="description">\`, and OpenGraph (\`og:locale\` / \`og:locale:alternate\`) tags must be fully localized.
3. **Locale Routing & Missing Translation Fallback**:
   - Clean URL routing for all supported locales with zero redirect loops or 404 dead-ends.
   - Missing translation keys must gracefully fall back to default locale (\`${defaultLoc}\`) without runtime panics or raw string delimiters.
4. **Encoding & Number/Date Formats**:
   - UTF-8 clean encoding with zero unescaped unicode artefacts.
   - Localized formatting for dates, currencies, and numbers using standard Intl APIs.`;
    }
  },

  // On the scope of this template, and what it deliberately does not claim:
  //
  // `llms.txt` (spec at llmstxt.org — cited without a scheme so the egress
  // allowlist test does not read a citation as a destination the kit contacts)
  // is a proposal, not a ratified standard. Plenty of sites publish one; no
  // major provider has confirmed its retrieval stack reads one, and Google has
  // said publicly that it does not use it. That is the supply side of a
  // convention with no demonstrated demand side.
  //
  // So this template verifies what a repository can actually falsify — the file
  // exists, it parses, its links resolve, and the site's crawler directives do
  // not contradict each other — and it says nothing about whether publishing it
  // improves visibility in any assistant. Every other template here carries a
  // real verification oracle; a "generative engine optimization" template that
  // promised ranking effects would be the first one that could not.
  //
  // Crawler posture is a policy choice, not a best practice. Allowing GPTBot,
  // ClaudeBot or Google-Extended has licensing and editorial consequences, and
  // blocking them is frequently deliberate. The template therefore takes no
  // side: it defaults to `preserve`, reads the posture the repository already
  // states, and enforces that every surface states the same thing.
  //
  // Structured data (JSON-LD, sameAs, entity markup) stays in `web-seo`. Two
  // templates with authority over the same markup will eventually disagree.
  "web-ai-access": {
    id: "web-ai-access",
    name: "AI Crawler Policy Consistency & llms.txt Integrity",
    description: "Verify that AI crawler directives agree across every surface and that a published llms.txt parses with links that resolve.",
    defaultVerifyCmd: "npm test",
    category: "Crawler Policy & AI Access",
    criticFocus: [
      "Confirm the patch preserves the repository's existing AI crawler posture unless the task explicitly asked to change it — allowing or blocking a crawler is the operator's decision, not the agent's.",
      "Verify robots.txt, per-page robots meta tags, and any X-Robots-Tag headers agree for every named agent; a page allowed in one surface and denied in another is a defect regardless of which is intended.",
      "Check that every link in llms.txt resolves against the project's own route table or build output, with no absolute links to pages that no longer exist.",
      "Ensure the PR description states that llms.txt consumption by AI systems is unverified, and claims no ranking, visibility, or citation benefit.",
      "Confirm no JSON-LD or structured-data markup was modified here — that surface belongs to the web-seo template."
    ],
    defaultParams: {
      aiAccessPolicy: "preserve",
      aiAgents: "GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot, Applebot-Extended",
      targetRoutes: "all public routes"
    },
    generatePrompt: (params = {}) => {
      const policy = String(params.aiAccessPolicy || "preserve").toLowerCase();
      const agents = params.aiAgents || "GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot, Applebot-Extended";
      const routes = params.targetRoutes || "all public routes";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      const policyClause = {
        allow: `The operator has decided to **allow** these agents. Make every surface say so consistently.`,
        deny: `The operator has decided to **block** these agents. Make every surface say so consistently, and confirm no route leaks access through a surface that was missed.`,
        selective: `The operator allows some agents and blocks others. Derive the intended split from existing configuration and make every surface agree with it exactly.`,
        preserve: `**Do not change the posture.** Determine what the repository already states about these agents and make every surface state the same thing. If the surfaces currently contradict each other, report the contradiction and resolve it toward the most restrictive existing directive — never toward the more permissive one, and never invent a posture the repository has not expressed.`
      }[policy] || `Treat \`${policy}\` as an explicit operator instruction and apply it consistently across every surface.`;

      return `Audit AI crawler access directives and llms.txt integrity for ${routes}.${customGoal}

### Operator Policy (do not override)
${policyClause}

Agents in scope: ${agents}.

### Acceptance Criteria:
1. **One Posture, Every Surface**:
   - \`robots.txt\`, per-page \`<meta name="robots">\` / agent-specific meta tags, and any \`X-Robots-Tag\` response headers must agree for every agent above.
   - A route that is allowed by one surface and denied by another is a defect even when the intended answer is obvious — fix the disagreement, do not pick a winner silently.
   - Verify \`robots.txt\` parses: correct \`User-agent:\` grouping, no directives stranded outside a group, no rules unreachable because of an earlier wildcard group.
2. **llms.txt Integrity (if the project publishes one)**:
   - The file must parse as the proposed shape: a single \`# H1\` project name, an optional \`> blockquote\` summary, then \`## H2\` sections whose bodies are Markdown link lists.
   - **Every link must resolve against this project's own route table or build output.** Check locally — do not fetch the live web from the verification step. A dead link in llms.txt is the single most common real defect in published files.
   - Content must not contradict the crawler policy above: do not advertise paths in llms.txt that \`robots.txt\` disallows.
   - If the project does not publish llms.txt, adding one is **in scope only if the task asked for it**. Do not create one on your own initiative.
3. **Honest Reporting**:
   - \`llms.txt\` is a proposal, not a ratified standard, and no major provider has confirmed that its retrieval systems read it. Google has stated publicly that it does not.
   - The PR description must therefore claim only what was verified — that the file exists, parses, and its links resolve. Do **not** claim improved visibility, ranking, or citation in any AI assistant. There is no oracle for that claim and it must not appear in the diff, the commit message, or the PR body.
4. **Scope Boundary**:
   - Do not modify JSON-LD, Schema.org markup, \`sameAs\`, OpenGraph, or canonical tags. That surface belongs to the \`web-seo\` template; changing it here creates two sources of truth that will drift apart.

### Verification Oracle to Add
Add a repository-local test (no network access) that:
- parses \`robots.txt\` and asserts the directive set for each agent in scope matches the intended posture;
- parses \`llms.txt\`, if present, and asserts every link target exists in the route table or build output.

The test must fail on a hand-broken fixture before you consider it done.`;
    }
  },

  "agent-qa-mutation": {
    id: "agent-qa-mutation",
    name: "Agent Test Quality & Mutation Falsification",
    description: "Audit agent-authored tests by deliberately mutating code under test to prove assertions fail on real defects.",
    defaultVerifyCmd: "npm test",
    category: "Quality & Testing",
    criticFocus: [
      "Ensure tests assert actual returned values and behaviors, not trivial shape checks (e.g. toBeDefined, assertTrue, status == 200).",
      "Verify that no test mocks the unit or function under test (mocking the subject under test measures only the mock).",
      "Confirm that every newly added test was proven to fail (turn red) when the underlying production logic was deliberately mutated.",
      "Ensure collected test count matches actual test count, and reconcile any skipped or deleted tautological tests."
    ],
    defaultParams: {
      targetTestDir: "test/",
      mutationStrategy: "invert conditions, drop return fields, alter numeric constants"
    },
    generatePrompt: (params = {}) => {
      const testDir = params.targetTestDir || "test/";
      const strategy = params.mutationStrategy || "invert conditions, drop return fields, alter numeric constants";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit and falsify agent-authored tests in '${testDir}'.${customGoal}

### Mutation & Assertion Quality Invariants:
1. **Prove Each Test Can Fail (Mutation Falsification)**:
   - For every test in scope, deliberately introduce a defect into the code under test (${strategy}), run only that test, and confirm it turns red.
   - Immediately revert every deliberate code mutation before proceeding to the next test.
   - A test nobody has seen fail is an unverified assumption; delete or rewrite tests that remain green under deliberate mutation.
2. **Eliminate Vacuous & Tautological Checks**:
   - Strip tests that mock the subject under test (measuring the mock rather than the implementation).
   - Replace shallow shape assertions (\`toBeDefined()\`, \`assertTrue(result)\`, \`is not None\`) with precise value assertions derived from requirements.
3. **Reconcile Collected vs Passed Counts**:
   - Compare test runner collected test count against actual test function count to detect uncollected or silently ignored test files.
   - Document every deleted tautological test with its specific failure mode.`;
    }
  },

  "agent-ci-falsify": {
    id: "agent-ci-falsify",
    name: "CI Pipeline Falsification & Exit Code Guard",
    description: "Audit CI pipeline steps to eliminate swallowed exit codes, vacuous passes, or skipped checks.",
    defaultVerifyCmd: "npm test",
    category: "CI & Infrastructure",
    criticFocus: [
      "Verify no command discards exit codes via un-guarded pipes (e.g. \`cmd | tee out.txt\` without pipefail) or \`|| true\`.",
      "Check that test runners fail when matching 0 test files instead of exiting cleanly with code 0.",
      "Ensure CI matrix legs and path filters (\`paths:\`, \`if:\`) have not silently excluded required verification checks.",
      "Confirm every CI check prints explicit item counts/coverage rather than bare unverified pass status."
    ],
    defaultParams: {
      workflowPath: ".github/workflows/"
    },
    generatePrompt: (params = {}) => {
      const workflowPath = params.workflowPath || ".github/workflows/";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit and harden CI/CD workflows in '${workflowPath}' against silent passes and swallowed exit codes.${customGoal}

### Pipeline Integrity Invariants:
1. **Zero Swallowed Exit Codes**:
   - Eliminate \`|| true\`, \`continue-on-error: true\` (unless justified in an adjacent comment), and \`set +e\` workarounds.
   - Ensure all shell pipes preserve non-zero exit statuses (e.g. \`set -o pipefail\` in bash steps).
2. **Falsifiable Step Execution**:
   - Verify test discovery patterns do not exit 0 on empty matches (e.g. runners reporting '0 tests collected' must fail).
   - Ensure every check step logs explicit processed item counts (tests executed, files linted, types checked).
3. **Trigger & Filter Integrity**:
   - Audit \`paths:\` and \`if:\` conditional expressions to ensure no critical security, typecheck, or test jobs are bypassed.`;
    }
  },

  "agent-service-isolate": {
    id: "agent-service-isolate",
    name: "Cold Sandbox Test Isolation & Service Decoupling",
    description: "Decouple test suites from live databases, external network services, or background daemons at existing architecture seams.",
    defaultVerifyCmd: "npm test",
    category: "Testing & Architecture",
    criticFocus: [
      "Verify default test runner executes cleanly from cold with zero live databases, Docker daemons, or network connections.",
      "Ensure assertions are never weakened or deleted to simulate passing service calls.",
      "Confirm tests that genuinely require live external services are explicitly marked/tagged and documented.",
      "Verify test isolation seams use existing repository abstractions/interfaces rather than brute monkey-patching."
    ],
    defaultParams: {
      targetServices: "databases, caches, third-party network APIs"
    },
    generatePrompt: (params = {}) => {
      const services = params.targetServices || "databases, caches, third-party network APIs";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Decouple test suite from external service dependencies (${services}) for reliable sandbox execution.${customGoal}

### Sandbox Decoupling Invariants:
1. **Zero Live Service Requirement for Default Suite**:
   - The default test command must pass from cold with zero background daemons, databases, or external network connectivity.
   - Fake external dependencies at existing boundary seams and repository interfaces.
2. **No Test Assertion Weakening**:
   - Never weaken assertions or delete checks to simulate service responses; retain exact expectation semantics.
3. **Explicit Isolation Markers**:
   - Categorize and tag integration tests requiring live services with explicit test runner markers (e.g. \`@integration\`, \`[live-service]\`).
   - Provide a separate, documented command for executing live integration suites.`;
    }
  },

  "agent-error-paths": {
    id: "agent-error-paths",
    name: "Error Path & Failure Recovery Stress Test",
    description: "Exercise unexecuted error paths, catch blocks, and retry loops by intentionally inducing real failure conditions.",
    defaultVerifyCmd: "npm test",
    category: "Resilience & Security",
    criticFocus: [
      "Verify broad \`catch (e)\` or \`except Exception\` blocks do not swallow fatal runtime bugs or misspellings.",
      "Confirm retry loops are bounded, backoff properly, and only operate on strictly idempotent actions.",
      "Ensure error fallbacks fail in the safe/restrictive direction (e.g. denying permissions if auth check is unreachable).",
      "Check that error messages clearly state the failed component, input, and actionable remedy."
    ],
    defaultParams: {
      targetModules: "src/"
    },
    generatePrompt: (params = {}) => {
      const modules = params.targetModules || "src/";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit, exercise, and harden error recovery paths and catch handlers in '${modules}'.${customGoal}

### Resilience & Error Handling Invariants:
1. **Execute Every Catch Block Under Real Failure Conditions**:
   - Test error handlers by inducing real failure conditions (closed socket, invalid schema, full disk, revoked token) rather than only reasoning about them.
   - Narrow overly broad \`catch (e)\` / \`except Exception\` blocks to catch only expected operational error types.
2. **Safe Fallback Direction**:
   - Ensure fallback branches fail in the restrictive/safe direction (e.g. permission checks must deny access on error, never allow).
3. **Bounded Idempotent Retries**:
   - Verify all retry mechanisms enforce maximum attempt caps, exponential backoff with jitter, and only retry idempotent operations.
4. **Actionable Error Telemetry**:
   - Ensure logged error messages specify the failed subsystem, input context, and actionable diagnostic guidance.
5. **Standalone Schema & Validation Testing**:
   - When asserting schema validation error messages, export and test standalone validation schemas (e.g. \`schema.safeParse()\`) directly in unit tests rather than relying on heavyweight framework action mocks that may mask validation errors.`;
    }
  },

  "agent-security-audit": {
    id: "agent-security-audit",
    name: "Agent-Authored Code Security & Permission Audit",
    description: "Audit agent changes for TLS validation bypasses, hardcoded test credentials in repo history, and excessive workflow permissions.",
    defaultVerifyCmd: "npm test",
    category: "Security & Permissions",
    criticFocus: [
      "Verify zero TLS certificate verification bypasses (\`rejectUnauthorized: false\`, \`NODE_TLS_REJECT_UNAUTHORIZED=0\`, \`verify=False\`).",
      "Check that no synthetic API keys, tokens, or private keys are committed in fixtures, configs, or git history.",
      "Ensure GitHub Actions workflows and tokens are scoped to minimum necessary permissions (never \`permissions: write-all\`).",
      "Confirm all string interpolations in SQL queries, shell commands, or HTML templates are properly escaped or parameterized."
    ],
    defaultParams: {
      diffRange: "HEAD~1..HEAD"
    },
    generatePrompt: (params = {}) => {
      const diffRange = params.diffRange || "HEAD~1..HEAD";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Conduct a targeted security audit of agent-authored modifications in diff '${diffRange}'.${customGoal}

### Agent Code Security Invariants:
1. **Zero Transport & TLS Bypasses**:
   - Strictly prohibit disabling TLS validation (\`rejectUnauthorized: false\`, \`NODE_TLS_REJECT_UNAUTHORIZED=0\`, \`verify=False\`, \`--no-check-certificate\`).
2. **Credential & Secret Scrubbing**:
   - Verify zero synthetic or real API tokens, passwords, or private keys in test fixtures, examples, or commit history.
3. **Least Privilege CI Permissions**:
   - Ensure CI workflows declare minimum explicit permissions; flag any \`permissions: write-all\` or unconstrained token scopes.
4. **Injection Prevention**:
   - Verify zero un-sanitized string concatenations in database queries, child process executions, file path resolutions, or HTML rendering.`;
    }
  },

  "deep-debug": {
    id: "deep-debug",
    name: "Deep Debug & Concurrency Race Condition Resolver",
    description: "Deep root-cause exploration, async call-graph mapping, and deterministic reproduction of race conditions.",
    defaultVerifyCmd: "npm test",
    category: "Deep Think",
    criticFocus: [
      "Verify that async race conditions or timing bugs are deterministically reproduced with a failing test before applying fixes.",
      "Check for lock contention, unhandled promise rejections, and memory retention in async state buffers.",
      "Confirm mutation falsification: inverting the fix logic turns the reproduction test red.",
      "Ensure zero new third-party dependencies and complete cross-platform timing parity (Linux/macOS/Windows)."
    ],
    defaultParams: {
      targetPath: "src/",
      issueSummary: "state desynchronization or race condition"
    },
    generatePrompt: (params = {}) => {
      const target = params.targetPath || "src/";
      const issue = params.issueSummary || params.goal || "state desynchronization or race condition";
      const customGoal = params.goal && params.goal !== issue ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Diagnose and surgically resolve concurrency/state race condition in '${target}': ${issue}.${customGoal}

### Deep Debug Protocol (Exploration & Oracle First):
1. **Silent Discovery & Call-Graph Tracing**:
   - Trace the lifecycle, state transitions, and async call graph across '${target}'.
   - Map out all concurrent read/write paths, shared buffers, or event-loop ticks where state desync occurs.
   - Do NOT write production code until the root-cause hypothesis is verified.
2. **Deterministic Reproduction Oracle**:
   - Formulate a deterministic test in the test suite reproducing the race condition under load or async delay.
   - Verify the reproduction test FAILS cleanly (RED) against current code.
3. **Surgical Implementation & Positive Perimeter**:
   - Implement the minimal, zero-dependency fix using native runtime built-ins only.
   - Confine modifications strictly to the identified faulty module and its test suite.
4. **Mutation Falsification**:
   - Invert the boolean or lock condition in your fix to prove the reproduction test turns RED (falsifiability proof).`;
    }
  },

  "deep-feature": {
    id: "deep-feature",
    name: "Deep Feature TDD & Oracle Architecture",
    description: "Oracle-first TDD architecture, contract discovery, and positive perimeter implementation.",
    defaultVerifyCmd: "npm test",
    category: "Deep Think",
    criticFocus: [
      "Ensure contract discovery aligns with existing repo error patterns ({ ok, code, error }) and JSDoc.",
      "Verify boundary condition coverage (null/undefined, oversized buffers, empty inputs, proto-pollution).",
      "Confirm positive operational perimeter: no edits outside designated target and test files.",
      "Ensure clean type check, linting, and 100% test pass rate."
    ],
    defaultParams: {
      featureName: "New Module Feature",
      targetModule: "src/"
    },
    generatePrompt: (params = {}) => {
      const feature = params.featureName || params.goal || "New Module Feature";
      const modulePath = params.targetModule || "src/";
      const customGoal = params.goal && params.goal !== feature ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Implement '${feature}' in '${modulePath}' using Oracle-First TDD Architecture.${customGoal}

### Deep Feature TDD Protocol:
1. **Contract & Interface Discovery**:
   - Inspect adjacent modules in '${modulePath}' to match conventions, error schemas, and signatures.
   - Define the public API contract before writing code.
2. **TDD Oracle Formulation (Red Phase)**:
   - Author comprehensive unit tests covering happy paths, boundary conditions, and invalid inputs.
   - Run the test suite and confirm that newly added tests fail with expected assertions (RED).
3. **Surgical Implementation (Green Phase)**:
   - Implement the feature using native built-in modules only (zero new third-party dependencies).
   - Normalize all filesystem paths for cross-platform support.
4. **Adversarial Critic Review**:
   - Verify memory allocations, recursion depth, and stream backpressure.
   - Ensure 100% clean test passes with 0 lint errors across all supported platforms.`;
    }
  },

  "deep-optimize": {
    id: "deep-optimize",
    name: "Deep Benchmark-Gated Performance Optimization",
    description: "Profiling-first optimization with 5-run median benchmark gate (>=20% throughput or >=30% RAM improvement).",
    defaultVerifyCmd: "npm test",
    category: "Deep Think",
    criticFocus: [
      "Verify 5-run median benchmark comparison before and after the change.",
      "Ensure byte-for-byte behavioral parity and zero regressions in the existing test suite.",
      "Check for memory leaks, recursion stack limits, and catastrophic regex backtracking (O(N^2)).",
      "Validate that hot loop optimizations do not sacrifice readability or error handling."
    ],
    defaultParams: {
      targetModule: "src/",
      metricTarget: ">=20% throughput improvement or >=30% memory reduction"
    },
    generatePrompt: (params = {}) => {
      const target = params.targetModule || "src/";
      const metric = params.metricTarget || ">=20% throughput improvement or >=30% memory reduction";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Optimize runtime execution time and memory footprint of '${target}'.${customGoal}

### Benchmark-Gated Optimization Protocol:
1. **Profiling & Baseline Measurement**:
   - Trace hot paths, object allocations inside loops, and redundant I/O in '${target}'.
   - Establish a reproducible benchmark measuring execution time (median of 5 runs) and heap memory.
2. **Algorithmic Refactoring**:
   - Eliminate redundant cloning, regex re-compilations, synchronous disk roundtrips, or O(N^2) lookups.
   - Maintain 100% byte-for-byte behavioral parity with the existing implementation.
3. **Benchmark Gate Verification**:
   - Target Metric: ${metric}.
   - Execute 5 consecutive benchmark runs to confirm statistically significant gains over baseline.
4. **Behavioral Integrity Check**:
   - Run the full test suite to guarantee zero regression or semantic drift.`;
    }
  },

  "deep-harden": {
    id: "deep-harden",
    name: "Deep Adversarial Hardening & Chaos Mutation",
    description: "Threat modeling, atomic I/O (safeAtomicWrite), chaos/fuzz injection, and structured error invariant gates.",
    defaultVerifyCmd: "npm test",
    category: "Deep Think",
    criticFocus: [
      "Verify TOCTOU safety and atomic file operations (temporary file + rename) for state persistence.",
      "Check resistance to unicode smuggling, escape code stripping, and path traversal (<traversal>).",
      "Ensure zero empty catch blocks or optimistic defaults returned from corrupt state.",
      "Confirm mutation falsification: deliberately invalidating security checks triggers instant test failure."
    ],
    defaultParams: {
      targetSubsystem: "src/",
      threatFocus: "malformed inputs, torn writes, unhandled runtime exceptions"
    },
    generatePrompt: (params = {}) => {
      const target = params.targetSubsystem || "src/";
      const threat = params.threatFocus || "malformed inputs, torn writes, unhandled runtime exceptions";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Adversarially harden '${target}' against ${threat}.${customGoal}

### Adversarial Hardening Protocol:
1. **Threat Modeling & Vulnerability Tracing**:
   - Audit atomic I/O: Ensure file writes use safe atomic writes (temp file + rename) to prevent torn state on crash.
   - Audit sanitization: Verify resistance against Unicode smuggling, ANSI escape injections, and traversal paths.
   - Audit error propagation: Replace silent catch blocks with clinical, structured error objects.
2. **Chaos & Fuzz Test Authorship**:
   - Author stress tests feeding proto-pollution payloads, oversized binary buffers, and simulated SIGKILL interruptions.
   - Verify that all failure conditions emit structured error codes rather than crashing.
3. **Mutation Falsification Gate**:
   - Invert security checks deliberately to prove the new tests fail immediately (kill the mutant).
4. **Regression Verification**:
   - Ensure 100% of existing and new tests pass cleanly with zero errors.`;
    }
  },

  // ---------------------------------------------------------------------------
  // Universal / stack-agnostic templates.
  //
  // The earlier templates were written for web frontends and Node projects, but
  // `agentctl init` runs in Rust, Go, Python, PHP, .NET, Java, Ruby and Elixir
  // repositories too. A template whose verification oracle is "npm test" or
  // "npx lhci" is useless in a Cargo or pyproject checkout. Each template below
  // therefore:
  //   - names no specific package manager, framework or language in its prompt;
  //   - defaults defaultVerifyCmd to the placeholder "npm test" ONLY because
  //     synthesizeWebEnvelope lets the caller (planTaskCreate) override it from
  //     config.verify.test, which the stack detector already resolved — so a
  //     Rust repo dispatches `cargo test` here without the prompt ever naming
  //     it; and
  //   - carries a real, locally-falsifiable oracle rather than a "best practice"
  //     claim no test can exercise.
  // ---------------------------------------------------------------------------

  "agent-dep-audit": {
    id: "agent-dep-audit",
    name: "Dependency & Supply-Chain Integrity Audit",
    description: "Audit lockfile integrity, pinning, and install-time scripts across any language's dependency manifest without contacting a vulnerability database.",
    defaultVerifyCmd: "npm test",
    category: "Supply Chain & Dependencies",
    criticFocus: [
      "Verify every declared dependency resolves to a pinned, checksummed artifact in the committed lockfile; no floating ranges, no branch/tag refs, no unpinned git/http sources.",
      "Confirm no install/postinstall lifecycle script runs unchecked code, and that any such script is pinned to a version or audited inline rather than fetched at install time.",
      "Check that the lockfile in the diff is the one the current manifest resolves to — a stale lockfile that does not satisfy the manifest fails the gate, not a warning.",
      "Ensure newly added dependencies are actually imported by in-scope source; a dependency present in the manifest but unused by the codebase is bloat, not a requirement.",
      "Do not fetch a CVE database or contact any advisory API from the verification step. The template verifies pinning and integrity, which is falsifiable offline; known-vulnerability triage is a separate human decision."
    ],
    defaultParams: {
      manifestScope: "the project's dependency manifest and lockfile"
    },
    generatePrompt: (params = {}) => {
      const scope = params.manifestScope || "the project's dependency manifest and lockfile";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit dependency and supply-chain integrity for ${scope}.${customGoal}

### Supply-Chain Integrity Invariants:
1. **Pinned, Checksummed Resolution**:
   - Every direct and transitive dependency in the manifest must resolve to an exact, checksummed entry in the committed lockfile. No floating version ranges, no branch or tag refs, no unpinned VCS sources.
   - If the project uses a lockfile format that records hashes, verify each newly added or changed entry carries its expected integrity hash.
2. **Stale Lockfile Gate**:
   - The lockfile in the diff must satisfy the manifest as it stands after the change. A lockfile that no longer resolves the declared requirements fails the audit; do not regenerate it as part of an unrelated change.
3. **Install-Time Script Scrutiny**:
   - Enumerate every lifecycle / postinstall / build script that executes on install. Each one must either be unnecessary (and removed), pinned to a fixed version, or audited inline with a one-line justification in the PR.
4. **Reachability, Not Hoarding**:
   - A newly added dependency must be imported by in-scope source. If it is present in the manifest but no source references it, remove it.
5. **Offline Verification Oracle**:
   - Add or extend a repository-local check that the manifest and lockfile agree (a lockfile-staleness assertion using the project's own tooling, e.g. \`pip install --dry-run\`, \`cargo verify-project\`, \`go mod verify\`, \`bundle check\`, or an equivalent for the detected stack). It must run without network access and fail on a hand-broken fixture.`;
    }
  },

  "agent-doc-drift": {
    id: "agent-doc-drift",
    name: "Documentation & Command-Surface Drift Audit",
    description: "Cross-check documented commands, flags, environment variables and SDK exports against the actual CLI/SDK surface, fixing or deleting stale references.",
    defaultVerifyCmd: "npm test",
    category: "Docs & Maintenance",
    criticFocus: [
      "Verify every documented CLI subcommand, flag and exit code exists in the actual command parser; a README example referencing a removed flag is a defect, not a cosmetic issue.",
      "Check that environment variables named in docs and .env.example are actually read by source, and that every variable source reads is documented — undocumented configuration is a trap for the next operator.",
      "Confirm public SDK exports listed in docs match what the package entry point actually exports; a documented symbol that does not exist breaks a consumer on upgrade.",
      "Prefer deleting a stale claim over weakening it. If a feature was removed, remove its documentation; do not leave a paragraph that hedges around it.",
      "Paste the diff of the command/flag/export inventory the audit was based on, so the claim is reproducible rather than asserted."
    ],
    defaultParams: {
      docScope: "README, docs/, and inline command help"
    },
    generatePrompt: (params = {}) => {
      const scope = params.docScope || "README, docs/, and inline command help";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit ${scope} for drift against the actual command surface, configuration and public SDK, and correct every confirmed mismatch.${customGoal}

### Documentation Drift Invariants:
1. **Command & Flag Inventory**:
   - Enumerate every subcommand, flag, positional argument and exit code the CLI parser actually defines. Compare it against every code block in the documentation that invokes the tool.
   - A documented command that errors with \"unknown command\" or \"unknown flag\" fails the audit. Fix the doc or the parser — but do not silently add a flag just to satisfy a stale example.
2. **Configuration Parity**:
   - Every environment variable or config key the source reads must appear in the documented configuration reference and, where applicable, in \`.env.example\`.
   - Every variable listed in \`.env.example\` or the config reference must be read somewhere in source. Entries that name a variable nothing reads are stale.
3. **Public Surface Parity**:
   - For a library, every export named in the API reference must be importable from the package entry point. Every exported, documented symbol must still exist.
4. **Delete, Don't Hedge**:
   - When a feature was removed, delete its documentation rather than leaving a paragraph that hedges or says \"formerly\". A reader who was never going to use it does not need its history.
5. **Evidence**:
   - Attach the inventory (commands, env vars, exports) the audit compared against. A claim that \"the docs are in sync\" without the underlying list is not a result.`;
    }
  },

  "agent-config-audit": {
    id: "agent-config-audit",
    name: "Configuration, Defaults & Secret-Hygiene Audit",
    description: "Audit configuration loading, default safety, and secret handling across any stack — env vars, config files, and secret redaction in logs.",
    defaultVerifyCmd: "npm test",
    category: "Security & Operations",
    criticFocus: [
      "Verify every configuration value has a safe default or fails closed with an actionable error; a missing required value must never silently become undefined, an empty string, or 'true'.",
      "Confirm no secret is logged at any level — including debug — and that error messages, stack traces and telemetry redact tokens, passwords and connection strings before they are emitted.",
      "Check that boolean/number config is parsed into its type, not passed through as a string that only happens to be truthy; 'false' as a string is a classic fail-open.",
      "Ensure .env or equivalent secret files are gitignored, that .env.example contains no real values, and that the audit does not itself commit a secret to prove the gate works.",
      "Do not weaken the secret scanner to silence a finding; remove the secret and rotate it if it was ever committed."
    ],
    defaultParams: {
      configScope: "application configuration and environment loading"
    },
    generatePrompt: (params = {}) => {
      const scope = params.configScope || "application configuration and environment loading";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit ${scope} for safe defaults, typed loading, and secret hygiene.${customGoal}

### Configuration & Secret Invariants:
1. **Safe Defaults, Fail-Closed Required Values**:
   - Every configuration key must either have an explicitly documented safe default, or fail closed at load time with an actionable error naming the missing variable.
   - Never let a missing required value degrade to \`undefined\`, an empty string, or a truthy string that masks the misconfiguration.
2. **Typed Loading**:
   - Parse booleans, numbers and durations into their types. A string \`\"false\"\` is truthy in most languages; a config that compares it against the boolean \`false\` fails open.
   - Reject unknown or misspelled keys rather than silently ignoring them — a typo in an env var name otherwise looks like a default.
3. **Secret Hygiene in Logs & Errors**:
   - No secret may appear in a log line at any level, including debug. Redact tokens, passwords, API keys and connection strings in error messages, stack traces and telemetry payloads before they are emitted.
   - Verify redaction by triggering a representative error path and asserting the output does not contain the configured secret value.
4. **Secret Files Stay Out of Version Control**:
   - Confirm \`.env\` and equivalent secret-bearing files are ignored by version control, and that the example/template file contains no real credentials — only placeholders.
   - If the audit finds a committed secret, the fix is to remove it and rotate the credential, not to relax the scanner.
5. **Falsifiable Oracle**:
   - Add a test that loads config with a missing required value and asserts it fails closed; and a test that a representative secret is redacted from a logged error. Both must fail before the fix and pass after.`;
    }
  },

  "agent-api-contract": {
    id: "agent-api-contract",
    name: "API Contract & Error-Code Consistency Audit",
    description: "Audit request/response handlers against their declared routes, schemas and error codes — universal across REST, GraphQL and RPC surfaces.",
    defaultVerifyCmd: "npm test",
    category: "API & Contracts",
    criticFocus: [
      "Verify every declared route/RPC method has a registered handler, and every registered handler is reachable through a declared route — orphaned handlers and unhandled routes are both defects.",
      "Confirm request bodies, query params and path params are validated against a declared schema before reaching handler logic; unvalidated input is the root cause the schema exists to prevent.",
      "Check that error responses share a single documented shape ({ ok, code, error } or the stack's convention) and that no handler leaks a stack trace, internal path, or upstream error body to the caller.",
      "Ensure success and error status codes are consistent across the surface — a 200 with { error: ... } body or a 500 for a validation failure both break contract-aware clients.",
      "Do not weaken a test to accept an inconsistent response; fix the handler or the contract so they agree."
    ],
    defaultParams: {
      apiScope: "the HTTP/RPC API surface"
    },
    generatePrompt: (params = {}) => {
      const scope = params.apiScope || "the HTTP/RPC API surface";
      const customGoal = params.goal ? `\n- **Target Focus**: ${params.goal}` : "";

      return `Audit ${scope} for route/handler parity, input validation and a consistent error contract.${customGoal}

### API Contract Invariants:
1. **Route/Handler Parity**:
   - Enumerate every declared route, method or RPC operation and confirm it resolves to a registered handler. Enumerate every registered handler and confirm it is reachable through a declared route.
   - An orphaned handler is dead code; an unhandled declared route is a 404/501 waiting to happen. Both fail the audit.
2. **Input Validation at the Boundary**:
   - Every request body, query parameter and path parameter must be validated against a declared schema before it reaches handler logic. Reject unknown fields rather than silently dropping them.
   - Validation failures must return the documented client-error status (typically 4xx), never a 500, and must name the offending field.
3. **One Error Shape, No Leaks**:
   - Every error response must use the project's single documented error shape (for example \`{ ok: false, code, error }\`). No handler may emit a different ad-hoc shape.
   - Never return a stack trace, filesystem path, upstream credential, or raw upstream error body to the caller. Log those server-side and return a stable, documented error code.
4. **Status-Code Consistency**:
   - Success responses use the appropriate 2xx/3xx; client errors use 4xx; server errors use 5xx. A 200 with an \`error\` field, or a 500 for a bad request, breaks every contract-aware client.
5. **Contract Test Oracle**:
   - Add or extend a table-driven test that, for each route in the inventory, asserts: the route resolves to a handler, an invalid payload returns the documented 4xx shape, and an unauthenticated/unauthorized request returns the documented status without a body leak. The test must fail on a hand-introduced orphan route or a leaking error before the fix.`;
    }
  }
};

/**
 * Returns metadata and generator for a web template by ID.
 * @param {string} templateId
 * @returns {object|null}
 */
export function getWebTemplate(templateId) {
  if (!templateId || typeof templateId !== "string") return null;
  const key = templateId.trim().toLowerCase();
  return WEB_TEMPLATES[key] || null;
}

/**
 * Lists all registered web development templates.
 * @returns {Array<{ id: string, name: string, description: string, category: string, defaultVerifyCmd: string }>}
 */
export function listWebTemplates() {
  return Object.values(WEB_TEMPLATES).map((tpl) => ({
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    category: tpl.category,
    defaultVerifyCmd: tpl.defaultVerifyCmd
  }));
}

/**
 * Synthesizes a structured task envelope from a web template with exploration budget and critic guidance.
 * @param {string} templateId
 * @param {object} [userParams={}]
 * @param {object} [options={}]
 * @returns {{
 *   templateId: string,
 *   title: string,
 *   prompt: string,
 *   verifyCmd: string,
 *   explorationBudget: boolean,
 *   criticFocus: Array<string>,
 *   fullEnvelope: string
 * }}
 */
export function synthesizeWebEnvelope(templateId, userParams = {}, options = {}) {
  const tpl = getWebTemplate(templateId);
  if (!tpl) {
    throw new Error(`Unknown web template '${templateId}'. Available: ${Object.keys(WEB_TEMPLATES).join(", ")}`);
  }

  const mergedParams = { ...tpl.defaultParams, ...userParams };
  const promptBody = tpl.generatePrompt(mergedParams);
  const verifyCmd = options.verifyCmd || userParams.verifyCmd || tpl.defaultVerifyCmd;
  const title = userParams.title || `[${tpl.category}] ${tpl.name}`;

  const explorationBudget = options.explorationBudget !== false;
  const criticGuidance = options.criticGuidance !== false;

  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");

  if (explorationBudget) {
    lines.push("## Google Labs Exploration Budget Protocol (3-Phase Discovery)");
    lines.push("To maximize diagnostic accuracy (Hit@5 57%), execute this task in 3 distinct phases:");
    lines.push("1. **PHASE 1: DISCOVERY & SYMBOL TRACING (Stay Silent, Write NO Code)**");
    lines.push("   - Read target component files, CSS definitions, imports, and existing test specs.");
    lines.push("   - Formulate diagnostic hypothesis and verify symbol signatures before planning edits.");
    lines.push("2. **PHASE 2: ORACLE & TEST FORMULATION**");
    lines.push(`   - Run baseline verification: \`${verifyCmd}\`.`);
    lines.push("   - Identify exact assertions or metrics that must turn green.");
    lines.push("3. **PHASE 3: IMPLEMENTATION & VERIFICATION**");
    lines.push("   - Apply minimal, surgical code modifications.");
    lines.push(`   - Execute \`${verifyCmd}\` and verify 100% clean exit code 0.`);
    lines.push("");
  }

  lines.push("## Task Objective & Specifications");
  lines.push(promptBody);
  lines.push("");

  if (criticGuidance && tpl.criticFocus && tpl.criticFocus.length > 0) {
    lines.push("## Internal Critic Agent Focus Areas (Adversarial Pre-Review)");
    lines.push("Before finalizing the pull request, verify that the patch satisfies:");
    for (const item of tpl.criticFocus) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push("");
  }

  lines.push("## Hard Verification Gates");
  lines.push(`- **Verification Command**: \`${verifyCmd}\` (Must exit cleanly with code 0)`);
  lines.push("- **Asset Integrity**: Zero missing images, broken fonts (.woff2), or corrupted static assets.");
  lines.push("- **Diff Payload Governor**: Keep total diff under 75 KB (\`git diff | wc -c\`).");
  lines.push("- **No Test Weakening**: Never delete assertions or skip tests to force a pass.");

  return {
    templateId: tpl.id,
    title,
    prompt: promptBody,
    verifyCmd,
    explorationBudget,
    criticFocus: tpl.criticFocus,
    fullEnvelope: lines.join("\n")
  };
}

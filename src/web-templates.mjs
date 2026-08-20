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
      "Verify that critical CSS is not blocked by third-party analytics or non-critical scripts."
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
3. Wrap below-the-fold heavy components in dynamic imports / lazy-loading.
4. Ensure zero content shifts during font swaps or dynamic component mounting.`;
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
      "Confirm snapshot assertions use appropriate pixel threshold tolerance to avoid flaky anti-aliasing failures."
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
2. **Responsive Invariants**:
   - Zero horizontal overflow on mobile viewports (\`overflow-x\` containment).
   - Tap target sizes for mobile touch buttons >= 44x44px.
   - Hamburger / collapsible navigation expands and closes with correct ARIA attributes.
3. **Resilient Locators**:
   - Use user-facing accessible locators (\`page.getByRole('button', { name: /submit/i })\`).
   - Never use arbitrary \`waitForTimeout(3000)\` sleeps; use \`expect(locator).toBeVisible()\`.
4. **Visual Snapshots**:
   - Verify visual snapshots pass with \`expect(page).toHaveScreenshot()\`.`;
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

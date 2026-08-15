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

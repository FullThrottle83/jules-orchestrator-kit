import { createHash } from "node:crypto";

/**
 * Computes SHA-1 hash of a string.
 * @param {string} content
 * @returns {string} SHA-1 hex string
 */
function sha1(content) {
  return createHash("sha1").update(content).digest("hex");
}

/**
 * Recursively sorts object keys alphabetically to produce a canonical representation.
 */
function sortKeysRecursive(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeysRecursive);
  }
  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = sortKeysRecursive(obj[key]);
  }
  return sorted;
}

/**
 * Computes canonical SHA-256 fingerprint for cross-language API contracts (OpenAPI/JSON/YAML).
 */
export function hashCrossLanguageInterface(taskId, outputFile, content = "", _schemaType = "json") {
  let cleaned = content;
  // Strip single-line comments
  cleaned = cleaned.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");

  let canonicalStr = cleaned.trim();
  try {
    const parsed = JSON.parse(cleaned);
    const sorted = sortKeysRecursive(parsed);
    canonicalStr = JSON.stringify(sorted);
  } catch (_) {
    // Fallback to normalized trimmed string if not JSON
  }

  const sha256 = createHash("sha256").update(canonicalStr).digest("hex");
  return `${taskId}:${outputFile}:${sha256}`;
}

/**
 * Chunks source code text into declaration blocks bounded by syntax declaration boundaries.
 * Supports JS/TS/braced languages, Python whitespace, and XML/tag-based structures (.csproj).
 * @param {string} text
 * @param {string} [lang="js"]
 * @returns {Array<Object>} Array of block descriptors
 */
export function chunkBlocks(text = "", lang = "js") {
  if (typeof text !== "string") {
    text = String(text || "");
  }

  const lines = text.split(/\r?\n/);
  const blocks = [];
  const nameCounts = new Map();

  const isPython = lang === "py" || lang === "python" || lang === "yaml" || lang === "yml";
  const isXml = lang === "xml" || lang === "html" || lang === "csproj" || lang === "fsproj" || lang === "vbproj" || lang === "xaml";

  // Declaration regexes matching column 0
  const declRegex = /^(?:export\s+)?(?:async\s+)?(function\*?|class|const|let|var|def|type|interface|enum|struct|fn|pub|func)\s+([a-zA-Z0-9_$]+)/;
  const declAnyRegex = /^(?:export\s+)?(?:async\s+)?(function\*?|class|const|let|var|def|type|interface|enum|struct|fn|pub|func)\b/;
  const xmlTagOpenRegex = /^\s*<([a-zA-Z0-9_$-]+)(?:\s+[^>]*)?>/;
  const xmlTagCloseRegex = /^\s*<\/([a-zA-Z0-9_$-]+)>/;

  let currentLines = [];
  let currentType = "prelude";
  let currentName = null;
  let inBlock = false;
  let braceDepth = 0;
  let blockIndentLevel = 0;
  let xmlTagName = null;

  function flushBlock() {
    if (currentLines.length === 0) return;
    const content = currentLines.join("\n");
    if (currentType === "prelude" && content.trim().length === 0) {
      currentLines = [];
      return;
    }
    let name = currentName;
    if (!name) {
      name = currentType === "prelude" ? `prelude_${blocks.length}` : `block_${blocks.length}`;
    }

    // Ensure unique block ID if duplicate names exist
    const count = (nameCounts.get(name) || 0) + 1;
    nameCounts.set(name, count);
    const uniqueId = count > 1 ? `${currentType}:${name}:${count}` : `${currentType}:${name}`;

    blocks.push({
      id: uniqueId,
      name,
      type: currentType,
      lines: [...currentLines],
      content,
      hash: sha1(content),
      indentation: blockIndentLevel,
    });

    currentLines = [];
    currentType = "prelude";
    currentName = null;
    inBlock = false;
    braceDepth = 0;
    blockIndentLevel = 0;
    xmlTagName = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isColumnZero = line.length > 0 && line[0] !== " " && line[0] !== "\t";

    if (isXml) {
      // XML / Tag-based chunking (.csproj, XML, HTML)
      const openMatch = line.match(xmlTagOpenRegex);
      const closeMatch = line.match(xmlTagCloseRegex);

      if (!inBlock && openMatch && !line.includes("/>") && !openMatch[1].startsWith("?") && !openMatch[1].startsWith("!")) {
        const tag = openMatch[1];
        if (tag !== "Project" && tag !== "html" && tag !== "svg") {
          flushBlock();
          currentType = "tag";
          currentName = tag;
          xmlTagName = tag;
          inBlock = true;
        }
      }
      currentLines.push(line);
      if (inBlock && closeMatch && closeMatch[1] === xmlTagName) {
        flushBlock();
      }
      continue;
    }

    if (isPython) {
      // Python & YAML whitespace block logic
      if (isColumnZero && declAnyRegex.test(line)) {
        flushBlock();
        const match = line.match(declRegex);
        currentType = match ? match[1] : "def";
        currentName = match ? match[2] : null;
        inBlock = true;
        blockIndentLevel = 0;
      } else if (inBlock && isColumnZero && line.trim().length > 0 && !line.trim().startsWith("#")) {
        // Dedented back to column 0 in Python/YAML
        flushBlock();
      }
    } else {
      // Braced syntax block logic (JS, TS, C#, Rust, Go, Swift, C/C++)
      if (isColumnZero && declAnyRegex.test(line)) {
        flushBlock();
        const match = line.match(declRegex);
        currentType = match ? match[1] : "decl";
        currentName = match ? match[2] : null;
        inBlock = true;
        blockIndentLevel = 0;
      }
    }

    currentLines.push(line);

    if (!isPython && !isXml && inBlock) {
      // Track curly brace balance
      for (const char of line) {
        if (char === "{") braceDepth++;
        if (char === "}") braceDepth--;
      }

      // Check if block ends on this line
      const isClosingBraceAtColZero = isColumnZero && line.trim() === "}";
      const isSingleLineStatement = braceDepth <= 0 && (line.trim().endsWith(";") || isClosingBraceAtColZero);

      if (braceDepth <= 0 && isSingleLineStatement) {
        flushBlock();
      }
    }
  }

  flushBlock();
  return blocks;
}

/**
 * Performs a 3-way block structural merge between base, ours, and theirs.
 * @param {string} baseText
 * @param {string} oursText
 * @param {string} theirsText
 * @param {string} [lang="js"]
 * @returns {Object} { mergedText, classifications, conflicts, toString() }
 */
export function mergeBlocks3Way(baseText = "", oursText = "", theirsText = "", lang = "js") {
  const baseBlocks = chunkBlocks(baseText, lang);
  const oursBlocks = chunkBlocks(oursText, lang);
  const theirsBlocks = chunkBlocks(theirsText, lang);

  const baseMap = new Map(baseBlocks.map((b) => [b.id, b]));
  const theirsMap = new Map(theirsBlocks.map((b) => [b.id, b]));

  const classifications = [];
  const processed = new Set();
  const outputBlocks = [];
  let conflicts = 0;

  // Process oursBlocks first
  for (const oBlock of oursBlocks) {
    const id = oBlock.id;
    processed.add(id);

    const bBlock = baseMap.get(id);
    const tBlock = theirsMap.get(id);

    if (tBlock && bBlock) {
      if (oBlock.hash === tBlock.hash) {
        classifications.push({ id, type: "IDENTICAL" });
        outputBlocks.push(oBlock.content);
      } else if (oBlock.hash === bBlock.hash) {
        classifications.push({ id, type: "ONLY_THEIRS" });
        outputBlocks.push(tBlock.content);
      } else if (tBlock.hash === bBlock.hash) {
        classifications.push({ id, type: "ONLY_OURS" });
        outputBlocks.push(oBlock.content);
      } else {
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n${oBlock.content}\n=======\n${tBlock.content}\n>>>>>>> THEIRS`);
      }
    } else if (tBlock && !bBlock) {
      if (oBlock.hash === tBlock.hash) {
        classifications.push({ id, type: "IDENTICAL" });
        outputBlocks.push(oBlock.content);
      } else {
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n${oBlock.content}\n=======\n${tBlock.content}\n>>>>>>> THEIRS`);
      }
    } else if (!tBlock && bBlock) {
      if (oBlock.hash === bBlock.hash) {
        classifications.push({ id, type: "DELETED" });
      } else {
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n${oBlock.content}\n=======\n>>>>>>> THEIRS`);
      }
    } else {
      classifications.push({ id, type: "ADDED_OURS" });
      outputBlocks.push(oBlock.content);
    }
  }

  // Handle blocks in theirs that were not in ours
  for (const tBlock of theirsBlocks) {
    const id = tBlock.id;
    if (processed.has(id)) continue;
    processed.add(id);

    const bBlock = baseMap.get(id);
    if (!bBlock) {
      classifications.push({ id, type: "ADDED_THEIRS" });
      outputBlocks.push(tBlock.content);
    } else {
      if (tBlock.hash === bBlock.hash) {
        classifications.push({ id, type: "DELETED" });
      } else {
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n=======\n${tBlock.content}\n>>>>>>> THEIRS`);
      }
    }
  }

  let mergedText = outputBlocks.join("\n\n");

  if (conflicts > 0) {
    if (lang === "json") {
      try {
        const autoResolved = resolveJsonConflict(mergedText);
        if (autoResolved && !autoResolved.includes("<<<<<<<")) {
          mergedText = autoResolved;
          conflicts = 0;
        }
      } catch (_) {}
    } else if (lang === "md" || lang === "markdown") {
      try {
        const autoResolved = resolveMarkdownConflict(mergedText);
        if (autoResolved && !autoResolved.includes("<<<<<<<")) {
          mergedText = autoResolved;
          conflicts = 0;
        }
      } catch (_) {}
    }
  }

  return {
    mergedText,
    classifications,
    conflicts,
    toString() {
      return this.mergedText;
    },
  };
}

/**
 * Deep-merges two parsed JSON values.
 * - Objects: merged recursively; HEAD (ours) wins on scalar conflicts.
 * - Arrays: concatenated with primitive deduplication and deep object equality check.
 * - Primitives: HEAD (ours) wins unless null/undefined.
 */
export function deepMergeJson(head, dev) {
  if (head === null || head === undefined) return dev;
  if (dev === null || dev === undefined) return head;

  if (Array.isArray(head) && Array.isArray(dev)) {
    const combined = [...head];
    for (const item of dev) {
      const isPrimitive = typeof item !== "object" || item === null;
      if (isPrimitive) {
        if (!combined.includes(item)) combined.push(item);
      } else {
        const itemStr = JSON.stringify(item);
        const exists = combined.some((c) => JSON.stringify(c) === itemStr);
        if (!exists) combined.push(item);
      }
    }
    return combined;
  }

  if (typeof head === "object" && typeof dev === "object" && !Array.isArray(head) && !Array.isArray(dev)) {
    const result = { ...dev };
    for (const key of Object.keys(head)) {
      if (key in result) {
        result[key] = deepMergeJson(head[key], result[key]);
      } else {
        result[key] = head[key];
      }
    }
    return result;
  }

  // Scalar conflict: HEAD (ours) wins
  return head;
}

/**
 * Automatically resolves merge conflicts in JSON files.
 * Extracts <<<<<<< / ======= / >>>>>>> markers, parses both branches, deep-merges them,
 * and returns the formatted JSON string.
 *
 * @param {string} content - Raw conflict-marked file content
 * @returns {string} Clean, resolved JSON string (or original content if unresolvable)
 */
export function resolveJsonConflict(content) {
  if (typeof content !== "string") return content;
  if (!content.includes("<<<<<<<") || !content.includes("=======") || !content.includes(">>>>>>>")) {
    return content;
  }

  // Check if the whole file or a segment is marked as conflict
  const fullConflictRegex = /^<{7}.*?\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7}.*?$/m;
  const match = content.match(fullConflictRegex);

  if (match) {
    const headRaw = match[1].trim();
    const devRaw = match[2].trim();

    try {
      const headJson = JSON.parse(headRaw);
      const devJson = JSON.parse(devRaw);
      const merged = deepMergeJson(headJson, devJson);
      return JSON.stringify(merged, null, 2) + "\n";
    } catch (_) {
      // If individual branches are partial JSON snippets, fall through to block resolution
    }
  }

  // Multi-block / partial JSON conflict resolution
  const conflictBlockRegex = /<{7}[^\n]*\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7}[^\n]*/g;
  const resolved = content.replace(conflictBlockRegex, (_, headBlock, devBlock) => {
    try {
      const h = JSON.parse(`{${headBlock}}`);
      const d = JSON.parse(`{${devBlock}}`);
      const m = deepMergeJson(h, d);
      const inner = JSON.stringify(m, null, 2).replace(/^\{\s*\n?/, "").replace(/\n?\s*\}$/, "");
      return inner;
    } catch (_) {
      // Fallback: take head (ours)
      return headBlock.trim();
    }
  });

  return resolved;
}

/**
 * Automatically resolves merge conflicts in Markdown files (changelogs, notes, docs).
 * Removes conflict markers, deduplicates repeated items, and concatenates updates.
 *
 * @param {string} content - Raw conflict-marked markdown content
 * @returns {string} Resolved Markdown text
 */
export function resolveMarkdownConflict(content) {
  if (typeof content !== "string") return content;
  if (!content.includes("<<<<<<<") || !content.includes("=======") || !content.includes(">>>>>>>")) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const result = [];
  let inConflict = false;
  let headBuffer = [];
  let devBuffer = [];
  let section = null; // 'head' | 'dev'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("<<<<<<<")) {
      inConflict = true;
      section = "head";
      headBuffer = [];
      devBuffer = [];
      continue;
    }

    if (inConflict && line.startsWith("=======")) {
      section = "dev";
      continue;
    }

    if (inConflict && line.startsWith(">>>>>>>")) {
      inConflict = false;
      section = null;

      // Concatenate both sides while deduplicating identical lines
      const seen = new Set();
      for (const hLine of headBuffer) {
        result.push(hLine);
        if (hLine.trim()) seen.add(hLine.trim());
      }
      for (const dLine of devBuffer) {
        if (!seen.has(dLine.trim())) {
          result.push(dLine);
          if (dLine.trim()) seen.add(dLine.trim());
        }
      }
      continue;
    }

    if (inConflict) {
      if (section === "head") headBuffer.push(line);
      else if (section === "dev") devBuffer.push(line);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

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
 * Chunks source code text into declaration blocks bounded by column-0 declaration boundaries.
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

  const isPython = lang === "py" || lang === "python";

  // Declaration regex matching column 0
  const declRegex = /^(?:export\s+)?(?:async\s+)?(function\*?|class|const|let|var|def|type|interface|enum)\s+([a-zA-Z0-9_$]+)/;
  const declAnyRegex = /^(?:export\s+)?(?:async\s+)?(function\*?|class|const|let|var|def|type|interface|enum)\b/;

  let currentLines = [];
  let currentType = "prelude";
  let currentName = null;
  let inBlock = false;
  let braceDepth = 0;
  let blockIndentLevel = 0;

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
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isColumnZero = line.length > 0 && line[0] !== " " && line[0] !== "\t";

    if (isPython) {
      // Python block logic
      if (isColumnZero && declAnyRegex.test(line)) {
        flushBlock();
        const match = line.match(declRegex);
        currentType = match ? match[1] : "def";
        currentName = match ? match[2] : null;
        inBlock = true;
        blockIndentLevel = 0;
      } else if (inBlock && isColumnZero && line.trim().length > 0 && !line.trim().startsWith("#")) {
        // Dedented back to column 0 in Python
        flushBlock();
      }
    } else {
      // JS/TS block logic
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

    if (!isPython && inBlock) {
      // Track curly brace balance for JS/TS
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
        // Both match exactly
        classifications.push({ id, type: "IDENTICAL" });
        outputBlocks.push(oBlock.content);
      } else if (oBlock.hash === bBlock.hash) {
        // Ours didn't change, theirs changed
        classifications.push({ id, type: "ONLY_THEIRS" });
        outputBlocks.push(tBlock.content);
      } else if (tBlock.hash === bBlock.hash) {
        // Theirs didn't change, ours changed
        classifications.push({ id, type: "ONLY_OURS" });
        outputBlocks.push(oBlock.content);
      } else {
        // Both changed differently
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n${oBlock.content}\n=======\n${tBlock.content}\n>>>>>>> THEIRS`);
      }
    } else if (tBlock && !bBlock) {
      // Added in both ours and theirs
      if (oBlock.hash === tBlock.hash) {
        classifications.push({ id, type: "IDENTICAL" });
        outputBlocks.push(oBlock.content);
      } else {
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n${oBlock.content}\n=======\n${tBlock.content}\n>>>>>>> THEIRS`);
      }
    } else if (!tBlock && bBlock) {
      // Present in base and ours, missing in theirs
      if (oBlock.hash === bBlock.hash) {
        // Deleted by theirs, unchanged by ours
        classifications.push({ id, type: "DELETED" });
      } else {
        // Modified by ours, deleted by theirs -> CONFLICT
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n${oBlock.content}\n=======\n>>>>>>> THEIRS`);
      }
    } else {
      // !tBlock && !bBlock -> ADDED_OURS
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
      // Added in theirs
      classifications.push({ id, type: "ADDED_THEIRS" });
      outputBlocks.push(tBlock.content);
    } else {
      // Present in base and theirs, deleted by ours
      if (tBlock.hash === bBlock.hash) {
        // Deleted by ours, unchanged by theirs
        classifications.push({ id, type: "DELETED" });
      } else {
        // Modified by theirs, deleted by ours -> CONFLICT
        conflicts++;
        classifications.push({ id, type: "CONFLICT_EDIT_EDIT" });
        outputBlocks.push(`<<<<<<< OURS\n=======\n${tBlock.content}\n>>>>>>> THEIRS`);
      }
    }
  }

  const mergedText = outputBlocks.join("\n\n");

  return {
    mergedText,
    classifications,
    conflicts,
    toString() {
      return this.mergedText;
    },
  };
}

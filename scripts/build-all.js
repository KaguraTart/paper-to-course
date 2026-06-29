#!/usr/bin/env node
/**
 * paper-to-course — Unified Build Pipeline
 *
 * Orchestrates the complete build: HTML + Markdown + PPTX from a course directory.
 *
 * Input:  course-dir/
 *           _base.html
 *           _footer.html
 *           modules/*.html
 *           slides-config.json     (optional — auto-generated if missing)
 *           references/           (copied automatically if needed)
 *
 * Output: course-dir/
 *           index.html            (assembled from _base + modules + _footer)
 *           README.md             (Markdown version of the course)
 *           slides.pptx          (PPTX presentation)
 *           slides-config.json    (PPTX slide data, used for PPTX)
 *
 * Usage:
 *   node build-all.js ./my-course          # builds all three outputs
 *   node build-all.js ./my-course --html   # HTML only
 *   node build-all.js ./my-course --md     # Markdown only
 *   node build-all.js ./my-course --pptx   # PPTX only
 */

const path = require("path");
const fs = require("fs");

const SKILL_ROOT = path.dirname(__dirname);
const SCRIPT_DIR = __dirname;

function resolve(...args) { return path.resolve(...args); }

// ─── Step 1: Build HTML index.html ───────────────────────────
function buildHtml(courseDir) {
  const basePath = resolve(courseDir, "_base.html");
  const footerPath = resolve(courseDir, "_footer.html");
  const modulesDir = resolve(courseDir, "modules");

  if (!fs.existsSync(basePath)) {
    throw new Error(`_base.html not found in ${courseDir}`);
  }
  if (!fs.existsSync(modulesDir)) {
    throw new Error(`modules/ directory not found in ${courseDir}`);
  }

  let base;
  try {
    base = fs.readFileSync(basePath, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read _base.html: ${e.message}`);
  }
  const footer = fs.existsSync(footerPath)
    ? fs.readFileSync(footerPath, "utf-8")
    : "";

  // Collect module files
  const moduleFiles = fs.readdirSync(modulesDir)
    .filter(f => f.endsWith(".html") && fs.statSync(resolve(modulesDir, f)).isFile())
    .sort();

  const moduleContents = moduleFiles.map(f => {
    const fp = resolve(modulesDir, f);
    if (!fs.statSync(fp).isFile()) throw new Error(`Not a file: ${fp}`);
    return fs.readFileSync(fp, "utf-8");
  });

  // Extract title from base
  const titleMatch = base.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(courseDir);

  // Replace COURSE_TITLE placeholder
  base = base.replace(/COURSE_TITLE/g, title);

  // Assemble
  let indexHtml = base + "\n" + moduleContents.join("\n") + "\n" + footer;

  // ── Inline CSS & JS → self-contained single file ──────────────
  // The browser opens index.html directly (and it is often moved away from
  // styles.css / main.js), so the external links must be inlined or the page
  // renders with no styling and no interactivity. NOTE: use replacement
  // *functions*, never replacement strings — a literal "$$"/"$&" inside
  // styles.css or main.js would otherwise be mangled by String.replace.
  const readAsset = name => {
    for (const dir of [courseDir, resolve(SCRIPT_DIR, "../references")]) {
      const fp = resolve(dir, name);
      if (fs.existsSync(fp)) return fs.readFileSync(fp, "utf-8");
    }
    return null;
  };
  const css = readAsset("styles.css");
  const js  = readAsset("main.js");

  if (css) {
    // drop the external stylesheet link, fill the INLINE_CSS placeholder
    indexHtml = indexHtml.replace(/[ \t]*<link rel="stylesheet" href="styles\.css">\n?/i, "");
    indexHtml = indexHtml.replace(/<!--\s*INLINE_CSS\s*-->/i, () => `<style>\n${css}\n</style>`);
  }
  if (js) {
    // Remove the head <script src="main.js"> + INLINE_JS placeholder, then
    // inject the script just before </body>. An inlined <script> ignores the
    // `defer` attribute, so it must live at the end of <body> to guarantee the
    // DOM exists when it runs.
    indexHtml = indexHtml.replace(/[ \t]*<script src="main\.js"[^>]*><\/script>\n?/i, "");
    indexHtml = indexHtml.replace(/<!--\s*INLINE_JS\s*-->\n?/i, "");
    indexHtml = indexHtml.replace(/<\/body>/i, () => `<script>\n${js}\n</script>\n</body>`);
  }

  const outPath = resolve(courseDir, "index.html");
  fs.writeFileSync(outPath, indexHtml, "utf-8");
  return outPath;
}

// ─── Step 2: Convert to Markdown ─────────────────────────────
function buildMarkdown(courseDir) {
  // Try to use html-to-md.js if jsdom is available
  try {
    const htmlToMdPath = resolve(SCRIPT_DIR, "html-to-md.js");
    const indexPath = resolve(courseDir, "index.html");
    const outPath = resolve(courseDir, "README.md");

    if (!fs.existsSync(indexPath)) {
      console.warn("⚠️  index.html not found — skipping Markdown generation");
      return null;
    }

    // Dynamically require html-to-md logic
    const htmlToMd = require(htmlToMdPath);

    // Use a simple regex-based conversion if no jsdom
    const indexHtml = fs.readFileSync(indexPath, "utf-8");
    const md = htmlToMarkdown(indexHtml);

    fs.writeFileSync(outPath, md, "utf-8");
    return outPath;
  } catch (e) {
    // Fallback: simple HTML→MD conversion without jsdom
    const indexPath = resolve(courseDir, "index.html");
    if (!fs.existsSync(indexPath)) return null;

    const html = fs.readFileSync(indexPath, "utf-8");
    const md = htmlToMarkdown(html);
    const outPath = resolve(courseDir, "README.md");
    fs.writeFileSync(outPath, md, "utf-8");
    return outPath;
  }
}

// ─── Simple HTML → Markdown (no jsdom dependency) ────────────
function htmlToMarkdown(html) {
  let md = html
    // Remove doctype and head
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<head>[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Headings
    .replace(/<h1[^>]*class="module-title"[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => '\n# ' + stripTags(t) + '\n')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => '\n## ' + stripTags(t) + '\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => '\n### ' + stripTags(t) + '\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => '\n#### ' + stripTags(t) + '\n')
    // Module numbers
    .replace(/<span[^>]*class="module-number"[^>]*>([\s\S]*?)<\/span>/gi, '')
    // Subtitle
    .replace(/<p[^>]*class="module-subtitle"[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => '\n_' + stripTags(t) + '_\n')
    // Screen headings
    .replace(/<h2[^>]*class="screen-heading"[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    // Paragraphs
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => {
      const s = stripTags(t).trim();
      return s ? '\n' + s + '\n' : '';
    })
    // Bold/italic
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '_$1_')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '_$1_')
    // Code
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // Lists
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, t) => t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, it) => '- ' + stripTags(it).trim() + '\n'))
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, t) => {
      let i = 0;
      return t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, it) => (++i) + '. ' + stripTags(it).trim() + '\n');
    })
    // Tables
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, t) => {
      const rows = [];
      t.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, tr) => {
        const cells = [];
        tr.replace(/<(th|td)[^>]*>([\s\S]*?)<\/(th|td)>/gi, (_, tag, c) => cells.push(stripTags(c).trim()));
        if (cells.length) rows.push(cells);
      });
      if (!rows.length) return '';
      let md = '\n';
      const colCount = rows[0].length;
      md += '| ' + rows[0].map(c => `**${c}**`).join(' | ') + ' |\n';
      md += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n';
      rows.slice(1).forEach(row => {
        md += '| ' + row.map(c => c).join(' | ') + ' |\n';
      });
      return md + '\n';
    })
    // Divs (treat as block)
    .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n')
    // Blockquotes / callouts
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
    .replace(/<div[^>]*class="callout[^-]*"[^>]*>([\s\S]*?)<\/div>/gi, (_, t) => {
      const content = stripTags(t).trim();
      return content ? '\n> ' + content.replace(/\n/g, '\n> ') + '\n' : '';
    })
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Clean entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    // Clean up
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\n+/, '')
    .trim();

  return md;
}

function stripTags(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '...')
    .trim();
}

// ─── Step 3: Generate PPTX ───────────────────────────────────
async function buildPptx(courseDir) {
  // Check if pptxgenjs is available
  let pptxgenAvailable = false;
  try {
    require("pptxgenjs");
    pptxgenAvailable = true;
  } catch (e) {
    pptxgenAvailable = false;
  }

  if (!pptxgenAvailable) {
    console.warn("⚠️  pptxgenjs not installed — skipping PPTX generation");
    console.warn("   Install with: npm install -g pptxgenjs");
    return null;
  }

  const configPath = resolve(courseDir, "slides-config.json");
  if (!fs.existsSync(configPath)) {
    console.warn(`⚠️  slides-config.json not found in ${courseDir} — skipping PPTX`);
    console.warn("   (The LLM should have generated it alongside HTML modules)");
    return null;
  }

  const outputPath = resolve(courseDir, "slides.pptx");
  const { build } = require(resolve(SCRIPT_DIR, "slides-builder.js"));

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const result = await build(config, outputPath);
  return result.fileName;
}

// ─── Step 4: Copy references (if needed) ────────────────────
function ensureReferences(courseDir) {
  const refsDir = resolve(SCRIPT_DIR, "..", "references");
  const targetRefs = resolve(courseDir, "references");

  const files = ["styles.css", "main.js", "_base.html", "_footer.html"];
  files.forEach(f => {
    const src = resolve(refsDir, f);
    const dst = resolve(courseDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  });
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  const flags = {
    html:  args.includes("--html") || !args.includes("--md") && !args.includes("--pptx"),
    md:    args.includes("--md")  || !args.includes("--html") && !args.includes("--pptx"),
    pptx:  args.includes("--pptx") || !args.includes("--html") && !args.includes("--md"),
  };

  // Get course dir (last non-flag argument)
  const nonFlags = args.filter(a => !a.startsWith("--"));
  const courseDir = nonFlags.length > 0 ? resolve(nonFlags[0]) : resolve(".");

  if (!fs.existsSync(courseDir)) {
    console.error(`❌ Directory not found: ${courseDir}`);
    process.exit(1);
  }

  const courseName = path.basename(courseDir);
  console.log(`\n📦 paper-to-course build pipeline`);
  console.log(`   Course: ${courseName}`);
  console.log(`   Output: ${courseDir}`);
  console.log(`   Steps:  HTML=${flags.html ? '✓' : '-'} MD=${flags.md ? '✓' : '-'} PPTX=${flags.pptx ? '✓' : '-'}\n`);

  const results = {};

  try {
    if (flags.html) {
      process.stdout.write("   🏗️  Building index.html... ");
      results.html = buildHtml(courseDir);
      console.log(`✓`);
    }

    if (flags.md) {
      process.stdout.write("   📝 Generating README.md... ");
      results.md = buildMarkdown(courseDir);
      if (results.md) console.log(`✓`); else console.log(`⚠ (skipped)`);
    }

    if (flags.pptx) {
      process.stdout.write("   📊 Building slides.pptx... ");
      results.pptx = await buildPptx(courseDir);
      if (results.pptx) console.log(`✓`); else console.log(`⚠ (skipped)`);
    }

    console.log(`\n✅ Build complete!\n`);
    if (results.html) console.log(`   HTML:   ${results.html}`);
    if (results.md)   console.log(`   Markdown: ${results.md}`);
    if (results.pptx) console.log(`   PPTX:   ${results.pptx}`);
    console.log();
  } catch (err) {
    console.error(`\n❌ Build failed: ${err.message}`);
    process.exit(1);
  }
}

main();

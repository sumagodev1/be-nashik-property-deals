// ESM helper that dynamically imports every *FormsConfig.js in the frontend
// and dumps each form's fields as JSON to stdout, one JSON blob per line.
// The frontend's package.json declares "type": "module", so Node picks up
// its ESM semantics automatically for the sibling imports the config files
// use (`import { REUSED_MASTER_KEYS } from './bungalowMastersConfig'`).
//
// Invoked by seed_inventory_fill_forms.js which needs the resolved field
// list to generate dummy dynamic-data.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = resolve(
  __dirname,
  '..',
  '..',
  'Frontend',
  'src',
  'admin',
  'pages',
  'Inventory',
  'dynamic',
);

// Some form-config files import from the masters index / from React contexts
// via barrel files. To stay in Node, we only walk *FormsConfig.js files and
// let Node resolve their siblings organically. If a sibling breaks (e.g. it
// imports react-hook-form), we catch that per-file and skip.

function extractDefaultExport(mod) {
  // Every FormsConfig.js file exports an array as default.
  const def = mod.default;
  if (Array.isArray(def)) return def;
  // A few files export a single form object.
  if (def && typeof def === 'object' && def.code) return [def];
  // Or they export a named FORMS array.
  for (const k of Object.keys(mod)) {
    const v = mod[k];
    if (Array.isArray(v) && v.length && v[0]?.code) return v;
  }
  return [];
}

/**
 * Node's native ESM loader does NOT auto-resolve missing `.js` extensions
 * (Vite does, but Vite isn't in the loop here). To work around it, we
 * COPY the entire dynamic/ dir into a temp folder, run a text transform
 * that appends `.js` to every relative-path bare import, then dynamically
 * import from the temp copy. Original files are never touched.
 */
function buildShimmedCopy() {
  const dst = join(tmpdir(), 'npd-form-configs-' + process.pid);
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(CONFIG_DIR, dst, { recursive: true });
  writeFileSync(join(dst, 'package.json'), JSON.stringify({ type: 'module' }));
  const files = readdirSync(dst).filter((f) => /\.js$/.test(f));
  for (const file of files) {
    const p = join(dst, file);
    let text = readFileSync(p, 'utf8');
    // Rewrite  from './fooBar'  →  from './fooBar.js'
    // Only touches strings that start with './' or '../' and don't already
    // have an extension.  Handles both `import x from '...'` and `import('...')`.
    text = text.replace(
      /from\s+(['"])(\.[^'"]+?)\1/g,
      (m, q, p2) => (/\.\w+$/.test(p2) ? m : `from ${q}${p2}.js${q}`),
    );
    writeFileSync(p, text);
  }
  return dst;
}

async function main() {
  const shimDir = buildShimmedCopy();
  const files = readdirSync(shimDir).filter((f) => /FormsConfig\.js$/.test(f));
  const emitted = [];
  for (const file of files) {
    const abs = resolve(shimDir, file);
    const url = pathToFileURL(abs).href;
    try {
      const mod = await import(url);
      const forms = extractDefaultExport(mod);
      for (const form of forms) {
        // Strip anything the seed doesn't need. Preserve the raw field
        // objects — the seed reads type / options / min / max / units.
        const compact = {
          code: form.code,
          label: form.label,
          propertyType: form.propertyType,
          transactionType: form.transactionType,
          transactionVariant: form.transactionVariant ?? '',
          sections: (form.sections || []).map((s) => ({
            title: s.title,
            kind: s.kind || 'fields',
            fields: (s.fields || []).map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type,
              options: f.options,
              units: f.units,
              masterKey: f.masterKey,
              min: f.min,
              max: f.max,
              specific: f.specific ? { type: f.specific.type, masterKey: f.specific.masterKey, options: f.specific.options } : undefined,
              any:      f.any      ? { type: f.any.type,      masterKey: f.any.masterKey,      options: f.any.options }      : undefined,
            })),
          })),
        };
        emitted.push(compact);
      }
    } catch (err) {
      console.error(`# skip ${file}: ${err.message}`);
    }
  }
  process.stdout.write(JSON.stringify(emitted));
}

main().catch((err) => { console.error(err); process.exit(1); });

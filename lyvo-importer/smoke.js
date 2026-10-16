const fs = require('fs');

let allOk = true;

// Test 1: All modules load
const modules = [
  './lib/state', './lib/sku', './lib/excel', './lib/extractor',
  './lib/searcher', './lib/normalize', './lib/fetch', './lib/images',
  './lib/worker', './lib/exporters'
];

for (const m of modules) {
  try {
    require(m);
    console.log('OK:', m);
  } catch (e) {
    allOk = false;
    console.log('FAIL:', m, '-', e.message);
  }
}

// Test 2: SKU generation with prefix preservation
try {
  const sku = require('./lib/sku');
  const parsed = sku.parseFirstSku('LYVO-000100');
  console.log('parseFirstSku("LYVO-000100") =>', JSON.stringify(parsed));
  
  const state = require('./lib/state').blankProject();
  state.sku.raw = parsed.raw;
  state.sku.prefix = parsed.prefix;
  state.sku.start = parsed.start;
  state.sku.width = parsed.width;
  state.sku.prefixSet = true;
  state.rows = [
    { rowIndex: 0, original_name: 'Test Product 1' },
    { rowIndex: 1, original_name: 'Test Product 2' },
    { rowIndex: 2, original_name: 'Test Product 3' }
  ];
  sku.assignSkus(state);
  const result = state.rows.map(r => r.sku);
  console.log('Assigned SKUs:', JSON.stringify(result));
  const expected = ['LYVO-000100', 'LYVO-000101', 'LYVO-000102'];
  console.log('Expected:', JSON.stringify(expected));
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    allOk = false;
    console.log('SKU MISMATCH!');
  }
} catch(e) {
  allOk = false;
  console.log('SKU test FAIL:', e.message);
}

// Test 3: SKU with numeric-only start (10000)
try {
  const sku = require('./lib/sku');
  const parsed = sku.parseFirstSku('10000');
  const state = require('./lib/state').blankProject();
  state.sku.raw = parsed.raw;
  state.sku.prefix = parsed.prefix;
  state.sku.start = parsed.start;
  state.sku.width = parsed.width;
  state.sku.prefixSet = true;
  state.rows = [{ rowIndex: 0, original_name: 'Test' }];
  sku.assignSkus(state);
  console.log('Numeric SKU start: ', state.rows[0].sku, '(expected: 10000)');
  if (state.rows[0].sku !== '10000') { allOk = false; console.log('Numeric SKU MISMATCH!'); }
} catch(e) {
  allOk = false;
  console.log('Numeric SKU test FAIL:', e.message);
}

// Test 4: Attribute extraction and matching
try {
  const norm = require('./lib/normalize');
  const attrs = norm.extractAttributes('LYVO Oil 50ml Black');
  console.log('extractAttributes =>', JSON.stringify(attrs));
  
  const match = norm.matchName('LYVO Oil 50ml Black', 'LYVO Oil 50ml Black');
  console.log('matchName (exact) =>', JSON.stringify(match));
  if (match.score < 0.9) { allOk = false; console.log('Match score too low!'); }
  
  const match2 = norm.matchName('LYVO Oil 50ml Black', 'Different Product 100ml Red');
  console.log('matchName (different) =>', JSON.stringify(match2));
} catch(e) {
  allOk = false;
  console.log('Normalize test FAIL:', e.message);
}

// Test 5: Price extraction
try {
  const ext = require('./lib/extractor');
  const result = ext.parsePrice('EGP 125.00');
  console.log('parsePrice("EGP 125.00") =>', JSON.stringify(result));
  if (result.price !== 125 || result.currency !== 'EGP') { allOk = false; console.log('Price parse FAIL!'); }
  
  const highRes = ext.highResUrl('https://example.com/image._AC_SL1500_.jpg');
  console.log('highResUrl =>', highRes);
} catch(e) {
  allOk = false;
  console.log('Extractor test FAIL:', e.message);
}

// Test 6: Export check
try {
  const exp = require('./lib/exporters');
  const state = require('./lib/state').blankProject();
  state.sku.assigned = true;
  state.writeSkuOnImage = true;
  state.rows = [{ rowIndex: 0, original_name: 'Test', sku: 'LYVO-000100', status: 'matched', image_filename: 'LYVO-000100.jpg' }];
  const check = exp.preExportCheck(state);
  console.log('preExportCheck =>', JSON.stringify({ ok: check.ok, matched: check.matchedCount, issues: check.issues.length }));
} catch(e) {
  allOk = false;
  console.log('Exporter test FAIL:', e.message);
}

// Test 7: Server syntax check
try {
  require('child_process').execSync('node -c server.js', { stdio: 'pipe' });
  console.log('Server syntax: OK');
} catch(e) {
  allOk = false;
  console.log('Server syntax FAIL:', e.message);
}

console.log(allOk ? '\n=== ALL MODULES OK ===' : '\n=== SOME FAILURES ===');
process.exit(allOk ? 0 : 1);



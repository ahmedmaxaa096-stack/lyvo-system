const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.scripts.test = 'node smoke.js';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
console.log('scripts =>', JSON.stringify(pkg.scripts));
console.log('deps =>', Object.keys(pkg.dependencies).join(', '));

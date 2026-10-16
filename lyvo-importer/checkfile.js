const c = require('fs').readFileSync('e2e.js', 'utf8');
const lines = c.split('\n');
console.log('lines:', lines.length);
console.log('makePngBuffer count:', (c.match(/function makePngBuffer/g) || []).length);
console.log('main count:', (c.match(/async function main/g) || []).length);
console.log('check count:', (c.match(/function check/g) || []).length);
console.log('marker:', c.includes('__PART2__'));
console.log('postForm count:', (c.match(/function postForm/g) || []).length);

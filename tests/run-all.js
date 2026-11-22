/*
 * Test runner: loads all test suites and reports results.
 */
'use strict';

const core = require('./core.test.js');
const dom = require('./dom.test.js');
const modernGf = require('./modern-gf.test.js');

(async () => {
  let coreOk = false, domOk = false, gfOk = false;
  try {
    coreOk = await core.main();
  } catch (e) {
    console.error('Core tests crashed:', e);
  }
  console.log('');
  try {
    domOk = await dom.main();
  } catch (e) {
    console.error('DOM tests crashed:', e);
  }
  console.log('');
  try {
    gfOk = await modernGf.main();
  } catch (e) {
    console.error('Modern GF tests crashed:', e);
  }

  console.log('\n=================');
  console.log('OVERALL: ' + ((coreOk && domOk && gfOk) ? 'PASS' : 'FAIL'));
  console.log('=================');
  process.exit((coreOk && domOk && gfOk) ? 0 : 1);
})();

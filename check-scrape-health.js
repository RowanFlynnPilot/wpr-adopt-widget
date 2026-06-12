/**
 * Post-scrape health gate for CI.
 *
 * Reads scrape_status from pet-data.json and exits non-zero when any shelter
 * scrape failed (0 pets) or is serving carried-forward stale data. The
 * GitHub Actions workflow runs this AFTER pushing results, so healthy
 * shelters still publish — this just turns the run red and triggers the
 * alert step so an outage can't go unnoticed for weeks.
 */
const path = require('path');

let status;
try {
  status = require(path.join(__dirname, 'pet-data.json')).scrape_status || {};
} catch (err) {
  console.error(`Could not read pet-data.json: ${err.message}`);
  process.exit(1);
}

let bad = false;
for (const [key, s] of Object.entries(status)) {
  const flag = s.status === 'ok' ? ' ' : s.status === 'low' ? '!' : 'X';
  const extra = s.staleSince ? ` (stale since ${s.staleSince})` : '';
  console.log(`${flag} ${key.padEnd(11)} ${String(s.count).padStart(3)} pets — ${s.status}${extra}`);
  if (s.status === 'failed' || s.status === 'stale') bad = true;
}

if (Object.keys(status).length === 0) {
  console.error('No scrape_status found in pet-data.json — build may have crashed before the health check.');
  process.exit(1);
}

if (bad) {
  console.error('\nOne or more shelters failed to scrape or are serving stale data. Check docs/diag-*.html snapshots.');
  process.exit(1);
}
console.log('\nAll shelter scrapes healthy.');

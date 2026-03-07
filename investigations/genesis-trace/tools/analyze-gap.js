const d = require('./output/drain-trace-1772894788524.json');
const drep = require('./output/drep-check-1772895277182.json');

const drepKeys = new Set(drep.stakeKeys.map(s => s.stakeKey));

const dests = d.results.flatMap(r => r.topDestinations || []);
const drainStakes = new Map();
for (const dest of dests) {
  const sk = dest.classification && dest.classification.stakeAddress;
  if (!sk) continue;
  if (!drainStakes.has(sk)) drainStakes.set(sk, { totalAda: 0, txCount: 0, currentAda: dest.classification.currentAda || 0 });
  drainStakes.get(sk).totalAda += dest.totalAda || 0;
  drainStakes.get(sk).txCount += dest.txCount || 0;
}

let newKeys = 0, newAda = 0, existingKeys = 0, existingAda = 0;
const newList = [];
for (const [sk, info] of drainStakes) {
  if (drepKeys.has(sk)) {
    existingKeys++;
    existingAda += info.totalAda;
  } else {
    newKeys++;
    newAda += info.totalAda;
    newList.push({ sk, ada: info.totalAda, currentAda: info.currentAda });
  }
}

console.log('=== DRAIN TRACE vs DREP-CHECK GAP ANALYSIS ===');
console.log('Total drain trace destinations with stake keys:', drainStakes.size);
console.log('Already known (in drep-check):', existingKeys, '|', existingAda.toLocaleString(), 'ADA flowed');
console.log('BRAND NEW stake keys:', newKeys, '|', newAda.toLocaleString(), 'ADA flowed');
console.log();
console.log('Top new stake keys by ADA flowed:');
newList.sort((a, b) => b.ada - a.ada);
for (const n of newList.slice(0, 20)) {
  console.log('  ', n.sk.substring(0, 50) + '...', '|', n.ada.toLocaleString(), 'ADA flowed |', n.currentAda.toLocaleString(), 'current');
}

// Also check: how many drain trace results are from the progress file (350 addresses)
// vs the completed output (which was from an earlier shorter run)
console.log();
console.log('This output file has', d.results.length, 'source addresses traced');
console.log('Progress file has 350 addresses - but this output was from an EARLIER run');

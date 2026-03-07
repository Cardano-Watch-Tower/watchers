/**
 * STATUS REPORT GENERATOR
 * Captures current progress from all running scans and generates
 * a snapshot for GitHub push updates.
 */
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, 'output');

function loadJSON(filename) {
  const fp = path.join(outputDir, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function loadLatest(prefix) {
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith(prefix) && !f.includes('progress'));
  if (files.length === 0) return null;
  const latest = files.sort().pop();
  return { data: JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8')), file: latest };
}

function main() {
  const now = new Date().toISOString();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   GENESIS TRACE STATUS REPORT                              ║');
  console.log('║   ' + now.padEnd(57) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Drain trace progress
  const drainProgress = loadJSON('drain-trace-progress.json');
  if (drainProgress) {
    const completed = drainProgress.completed ? drainProgress.completed.length : 0;
    const total = drainProgress.totalAddresses || '?';
    const results = drainProgress.results || [];
    let totalOutflow = 0;
    let totalDests = 0;
    for (const r of results) {
      totalOutflow += r.totalOutflow || 0;
      totalDests += r.destinationCount || 0;
    }
    console.log('\n  DRAIN TRACE:');
    console.log('    Progress:      ' + completed + ' / ' + total + ' addresses');
    console.log('    Total outflow: ' + totalOutflow.toLocaleString() + ' ADA');
    console.log('    Destinations:  ' + totalDests.toLocaleString());
    console.log('    Status:        ' + (completed >= total ? 'COMPLETE' : 'RUNNING'));
  }

  // Neighborhood scan progress
  const neighProgress = loadJSON('neighborhood-progress.json');
  if (neighProgress) {
    const completed = neighProgress.completed ? neighProgress.completed.length : 0;
    const total = neighProgress.totalKeys || '?';
    const results = neighProgress.results || [];
    let totalNeighbors = 0;
    for (const r of results) {
      totalNeighbors += (r.neighbors || []).length;
    }
    console.log('\n  NEIGHBORHOOD SCAN:');
    console.log('    Progress:      ' + completed + ' / ' + total + ' stake keys');
    console.log('    Neighbors:     ' + totalNeighbors);
    console.log('    Status:        ' + (completed >= total ? 'COMPLETE' : 'RUNNING'));
  }

  // Full trace progress
  const fullProgress = loadJSON('full-trace-Emurgo-progress.json');
  if (fullProgress) {
    const visited = fullProgress.visited ? fullProgress.visited.length : 0;
    const shelleyHits = fullProgress.shelleyAddresses ? fullProgress.shelleyAddresses.length : 0;
    console.log('\n  FULL TRACE (Emurgo):');
    console.log('    Visited:       ' + visited.toLocaleString() + ' addresses');
    console.log('    Shelley hits:  ' + shelleyHits.toLocaleString());
    console.log('    Status:        PAUSED (awaiting restart)');
  }

  // Completed phases
  const drepCheck = loadLatest('drep-check-');
  const deepDive = loadLatest('deep-dive-');
  const delegator = loadLatest('drep-delegator-trace-');
  const linkChain = loadLatest('link-chain-');

  console.log('\n  COMPLETED PHASES:');
  if (drepCheck) console.log('    DRep Check:        ' + drepCheck.data.stakeKeys.length + ' stake keys | ' + drepCheck.file);
  if (deepDive) console.log('    Deep Dive:         loaded | ' + deepDive.file);
  if (delegator) console.log('    DRep Delegators:   ' + delegator.data.totalDelegators + ' traced | ' + delegator.file);
  if (linkChain) console.log('    Link Chain:        ' + linkChain.data.stats.totalChains + ' chains | ' + linkChain.file);

  // Governance summary from drep-check
  if (drepCheck) {
    const keys = drepCheck.data.stakeKeys;
    let noGov = 0, abstain = 0, emurgo = 0, noConf = 0, otherDrep = 0;
    let noGovAda = 0, abstainAda = 0, emurgoAda = 0, noConfAda = 0, otherAda = 0;
    for (const k of keys) {
      if (!k.drep) { noGov++; noGovAda += k.controlledAda || 0; }
      else if (k.drep === 'drep_always_abstain') { abstain++; abstainAda += k.controlledAda || 0; }
      else if (k.drep === 'drep_always_no_confidence') { noConf++; noConfAda += k.controlledAda || 0; }
      else if (k.drep.startsWith('drep1ytvlwvy')) { emurgo++; emurgoAda += k.controlledAda || 0; }
      else { otherDrep++; otherAda += k.controlledAda || 0; }
    }
    const total = noGovAda + abstainAda + emurgoAda + noConfAda + otherAda;
    console.log('\n  GOVERNANCE SNAPSHOT:');
    console.log('    No governance:     ' + noGovAda.toLocaleString().padStart(15) + ' ADA (' + (noGovAda/total*100).toFixed(1) + '%)');
    console.log('    Abstain:           ' + abstainAda.toLocaleString().padStart(15) + ' ADA (' + (abstainAda/total*100).toFixed(1) + '%)');
    console.log('    Emurgo DRep:       ' + emurgoAda.toLocaleString().padStart(15) + ' ADA (' + (emurgoAda/total*100).toFixed(1) + '%)');
    console.log('    No confidence:     ' + noConfAda.toLocaleString().padStart(15) + ' ADA (' + (noConfAda/total*100).toFixed(1) + '%)');
    console.log('    Other DRep:        ' + otherAda.toLocaleString().padStart(15) + ' ADA (' + (otherAda/total*100).toFixed(1) + '%)');
    console.log('    Total tracked:     ' + total.toLocaleString().padStart(15) + ' ADA');
  }

  console.log('\n' + '═'.repeat(64));
  console.log('  Report generated: ' + now);
  console.log('═'.repeat(64));
}

main();

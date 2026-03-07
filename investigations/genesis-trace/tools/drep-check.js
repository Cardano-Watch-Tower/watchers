require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();

/**
 * DRep DELEGATION CHECK
 *
 * Takes the top drain destinations (the big staked Shelley addresses
 * where genesis-linked funds ended up) and checks:
 * - Do they have a stake key?
 * - Are they delegated to a pool? (staking rewards)
 * - Are they delegated to a DRep? (governance voting)
 * - If DRep, which one? (always_abstain, always_no_confidence, or actual DRep)
 * - How much ADA is controlled by that stake key?
 */

const outputDir = path.join(__dirname, 'output');

async function getAddressInfo(address) {
  try {
    return await rateLimited(() => api.addresses(address));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   DRep DELEGATION CHECK                                     ║');
  console.log('║   Do the drain destinations participate in governance?       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load drain trace results
  const drainFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('drain-trace-') && !f.includes('progress'));
  if (drainFiles.length === 0) {
    console.log('No drain trace results found. Run drain-trace.js first.');
    return;
  }

  const latestDrain = drainFiles.sort().pop();
  const drainData = JSON.parse(fs.readFileSync(path.join(outputDir, latestDrain), 'utf8'));

  // Collect unique stake keys from drain destinations
  // Group by stake key and aggregate ADA flowing to each
  const stakeKeyMap = new Map(); // stakeKey -> { totalAda, addresses[] }
  const noStakeAddrs = []; // addresses with no stake key

  for (const result of drainData.results) {
    for (const dest of result.topDestinations) {
      if (!dest.address) continue;
      const stakeAddr = dest.classification?.stakeAddress;

      if (!stakeAddr) {
        // No stake key — track separately
        noStakeAddrs.push({ address: dest.address, totalAda: dest.totalAda, label: dest.classification?.label });
        continue;
      }

      if (!stakeKeyMap.has(stakeAddr)) {
        stakeKeyMap.set(stakeAddr, {
          stakeKey: stakeAddr,
          totalAdaFlowed: 0,
          addresses: [],
          label: dest.classification?.label
        });
      }
      const k = stakeKeyMap.get(stakeAddr);
      k.totalAdaFlowed += dest.totalAda;
      k.addresses.push(dest.address);
    }
  }

  // Also build address-level map for addresses without stake keys in classification
  // (the drain trace classifyAddress might not have saved stakeAddress for all types)
  const unclassifiedAddrs = new Map();
  for (const result of drainData.results) {
    for (const dest of result.topDestinations) {
      if (!dest.address || !dest.address.startsWith('addr1')) continue;
      if (!dest.classification?.stakeAddress) {
        if (!unclassifiedAddrs.has(dest.address)) {
          unclassifiedAddrs.set(dest.address, { address: dest.address, totalAda: 0 });
        }
        unclassifiedAddrs.get(dest.address).totalAda += dest.totalAda;
      }
    }
  }

  console.log(`\nFound ${stakeKeyMap.size} unique stake keys from drain destinations`);
  console.log(`Found ${unclassifiedAddrs.size} Shelley addresses without stake key in cache (will look up)`);
  console.log(`Found ${noStakeAddrs.length} non-Shelley destinations\n`);

  // For unclassified Shelley addresses, look up their stake key
  for (const [addr, data] of unclassifiedAddrs) {
    const info = await getAddressInfo(addr);
    if (info?.stake_address) {
      if (!stakeKeyMap.has(info.stake_address)) {
        stakeKeyMap.set(info.stake_address, {
          stakeKey: info.stake_address,
          totalAdaFlowed: 0,
          addresses: []
        });
      }
      const k = stakeKeyMap.get(info.stake_address);
      k.totalAdaFlowed += data.totalAda;
      k.addresses.push(addr);
    }
  }

  console.log(`After lookups: ${stakeKeyMap.size} unique stake keys\n`);

  // Sort stake keys by ADA flowed
  const destinations = [...stakeKeyMap.values()]
    .sort((a, b) => b.totalAdaFlowed - a.totalAdaFlowed);

  console.log(`Checking DRep delegation on ${destinations.length} stake keys...\n`);

  const results = [];
  const stakeKeySeen = new Set();
  const drepStats = {
    total: 0,
    withDrep: 0,
    withPool: 0,
    alwaysAbstain: 0,
    alwaysNoConfidence: 0,
    actualDrep: 0,
    noDrep: 0,
    noStakeKey: 0,
    adaByDrepType: {
      always_abstain: 0,
      always_no_confidence: 0,
      actual_drep: 0,
      no_drep: 0,
      no_stake_key: 0
    }
  };

  // Check each stake key directly — one API call per key
  for (let i = 0; i < destinations.length; i++) {
    const dest = destinations[i];
    drepStats.total++;

    const stakeInfo = await getStakeInfo(dest.stakeKey);

    if (!stakeInfo) {
      console.log(`  [${i + 1}/${destinations.length}] ${dest.totalAdaFlowed.toLocaleString().padStart(15)} ADA | STAKE KEY NOT FOUND | ${dest.stakeKey.substring(0, 40)}...`);
      drepStats.noStakeKey++;
      drepStats.adaByDrepType.no_stake_key += dest.totalAdaFlowed;
      results.push({ ...dest, pool: null, drep: null, controlledAda: 0 });
      continue;
    }

    const pool = stakeInfo.poolId || null;
    const drep = stakeInfo.drepId || null;
    const controlledAda = stakeInfo.ada || 0;

    if (pool) drepStats.withPool++;

    let drepLabel;
    if (!drep) {
      drepLabel = 'NO DRep';
      drepStats.noDrep++;
      drepStats.adaByDrepType.no_drep += dest.totalAdaFlowed;
    } else if (drep === 'drep_always_abstain') {
      drepLabel = 'ALWAYS_ABSTAIN';
      drepStats.alwaysAbstain++;
      drepStats.withDrep++;
      drepStats.adaByDrepType.always_abstain += dest.totalAdaFlowed;
    } else if (drep === 'drep_always_no_confidence') {
      drepLabel = 'ALWAYS_NO_CONFIDENCE';
      drepStats.alwaysNoConfidence++;
      drepStats.withDrep++;
      drepStats.adaByDrepType.always_no_confidence += dest.totalAdaFlowed;
    } else {
      drepLabel = `DRep: ${drep.substring(0, 25)}...`;
      drepStats.actualDrep++;
      drepStats.withDrep++;
      drepStats.adaByDrepType.actual_drep += dest.totalAdaFlowed;
    }

    const poolLabel = pool ? pool.substring(0, 20) + '...' : 'none';
    console.log(`  [${i + 1}/${destinations.length}] ${dest.totalAdaFlowed.toLocaleString().padStart(15)} ADA | ${drepLabel.padEnd(25)} | Pool: ${poolLabel.padEnd(24)} | ${controlledAda.toLocaleString()} ADA controlled | ${dest.addresses.length} addrs | ${dest.stakeKey.substring(0, 35)}...`);

    results.push({
      ...dest,
      pool,
      drep,
      controlledAda,
      active: stakeInfo.active
    });
  }

  // Also account for no-stake destinations
  for (const ns of noStakeAddrs) {
    drepStats.noStakeKey++;
    drepStats.adaByDrepType.no_stake_key += ns.totalAda;
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('  DRep DELEGATION SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total destinations checked:    ${drepStats.total}`);
  console.log(`  With pool delegation:          ${drepStats.withPool}`);
  console.log(`  With DRep delegation:          ${drepStats.withDrep}`);
  console.log(`    - always_abstain:            ${drepStats.alwaysAbstain}`);
  console.log(`    - always_no_confidence:      ${drepStats.alwaysNoConfidence}`);
  console.log(`    - actual DRep:               ${drepStats.actualDrep}`);
  console.log(`  No DRep set:                   ${drepStats.noDrep}`);
  console.log(`  No stake key:                  ${drepStats.noStakeKey}`);

  console.log(`\n  ADA by DRep status:`);
  const totalTracked = Object.values(drepStats.adaByDrepType).reduce((a, b) => a + b, 0);
  for (const [type, ada] of Object.entries(drepStats.adaByDrepType).sort((a, b) => b[1] - a[1])) {
    const pct = ((ada / Math.max(totalTracked, 1)) * 100).toFixed(1);
    console.log(`    ${type.padEnd(25)} ${ada.toLocaleString().padStart(20)} ADA (${pct}%)`);
  }

  // Print sorted by ADA flowed
  const sortedResults = results.sort((a, b) => b.totalAdaFlowed - a.totalAdaFlowed);
  console.log(`\n  TOP STAKE KEYS BY ADA FLOWED (${sortedResults.length}):`);
  for (const k of sortedResults.slice(0, 30)) {
    const drepLabel = k.drep
      ? (k.drep === 'drep_always_abstain' ? 'ABSTAIN' :
         k.drep === 'drep_always_no_confidence' ? 'NO_CONF' :
         k.drep.substring(0, 15) + '...')
      : 'NO DRep';
    const poolLabel = k.pool ? k.pool.substring(0, 15) + '...' : 'no pool';
    console.log(`    ${k.totalAdaFlowed.toLocaleString().padStart(20)} ADA flowed | ${k.controlledAda.toLocaleString().padStart(15)} ADA held | ${drepLabel.padEnd(18)} | ${poolLabel.padEnd(19)} | ${k.addresses.length} addrs | ${k.stakeKey.substring(0, 30)}...`);
  }

  // Save
  const savePath = path.join(outputDir, `drep-check-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify({
    stakeKeys: sortedResults,
    noStakeDestinations: noStakeAddrs,
    summary: drepStats,
    adaByDrepType: drepStats.adaByDrepType
  }, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);

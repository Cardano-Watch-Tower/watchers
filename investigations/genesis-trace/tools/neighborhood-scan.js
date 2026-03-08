require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();

/**
 * STAKE KEY NEIGHBORHOOD SCANNER
 *
 * For each stake key from the DRep check:
 * 1. Get all addresses under the key
 * 2. Sample recent transactions from those addresses
 * 3. Find counterparty addresses (who they sent to / received from)
 * 4. Group counterparties by THEIR stake key
 * 5. Check current balances on related stake keys
 *
 * This builds an "entity cluster" — wallets that transact with each other
 * are likely related (same entity, employee wallets, operational partners).
 */

const outputDir = path.join(__dirname, 'output');
const progressFile = path.join(outputDir, 'neighborhood-progress.json');
const SAVE_INTERVAL = 1;  // Save after EVERY key — never lose progress
const MAX_TXS_PER_ADDRESS = 500;  // Cap per address to avoid stalling on whale keys

function loadProgress() {
  if (fs.existsSync(progressFile)) {
    return JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  }
  return null;
}

function saveProgress(state) {
  fs.writeFileSync(progressFile, JSON.stringify(state, null, 2));
}

async function getAccountAddresses(stakeAddress) {
  const addresses = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.accountsAddresses(stakeAddress, { page, count: 100 })
      );
      if (!batch || batch.length === 0) break;
      addresses.push(...batch);
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (err.status_code === 404) break;
      throw err;
    }
  }
  return addresses;
}

async function getAllAddressTxs(address) {
  const allTxs = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.addressesTransactions(address, { count: 100, page, order: 'desc' })
      );
      if (!batch || batch.length === 0) break;
      allTxs.push(...batch);
      if (allTxs.length >= MAX_TXS_PER_ADDRESS) {
        console.log(`      (capped at ${MAX_TXS_PER_ADDRESS} txs for ${address.substring(0, 30)}...)`);
        break;
      }
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (err.status_code === 404) break;
      throw err;
    }
  }
  return allTxs;
}

async function getTxUtxos(txHash) {
  try {
    return await rateLimited(() => api.txsUtxos(txHash));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

async function getAddressInfo(address) {
  try {
    return await rateLimited(() => api.addresses(address));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

/**
 * For a stake key, find all counterparty stake keys from recent transactions.
 * Returns a map of counterparty stakeKey -> { totalAda, txCount, direction, addresses }
 */
async function scanNeighborhood(stakeKey, ownAddresses) {
  const ownAddrSet = new Set(ownAddresses.map(a => a.address || a));
  const counterparties = new Map(); // stakeKey -> { totalAda, txCount, direction, sampleAddresses }
  const addrToStake = new Map(); // cache address -> stakeKey lookups
  let txsScanned = 0;

  // Check ALL addresses — no sampling
  for (const addrObj of ownAddresses) {
    const addr = addrObj.address || addrObj;
    const txs = await getAllAddressTxs(addr);

    for (const tx of txs) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;
      txsScanned++;

      // Collect all addresses in this tx that aren't ours
      const externalAddrs = new Set();
      for (const inp of utxos.inputs) {
        if (!ownAddrSet.has(inp.address)) externalAddrs.add(inp.address);
      }
      for (const out of utxos.outputs) {
        if (!ownAddrSet.has(out.address)) {
          externalAddrs.add(out.address);
        }
      }

      // Resolve each external address to its stake key
      for (const extAddr of externalAddrs) {
        // Skip Byron addresses — no stake key
        if (extAddr.startsWith('Ae2') || extAddr.startsWith('Ddz')) continue;
        // Skip script addresses (addr1w...)
        if (extAddr.startsWith('addr1w')) continue;

        let extStakeKey = addrToStake.get(extAddr);
        if (extStakeKey === undefined) {
          const info = await getAddressInfo(extAddr);
          extStakeKey = info?.stake_address || null;
          addrToStake.set(extAddr, extStakeKey);
        }

        if (!extStakeKey || extStakeKey === stakeKey) continue; // skip self

        if (!counterparties.has(extStakeKey)) {
          counterparties.set(extStakeKey, {
            stakeKey: extStakeKey,
            txCount: 0,
            sampleAddresses: new Set(),
            direction: { sent: 0, received: 0 }
          });
        }
        const cp = counterparties.get(extStakeKey);
        cp.txCount++;
        if (cp.sampleAddresses.size < 5) cp.sampleAddresses.add(extAddr);

        // Determine direction
        const weAreInput = utxos.inputs.some(i => ownAddrSet.has(i.address));
        const theyAreInput = utxos.inputs.some(i => i.address === extAddr);
        if (weAreInput && !theyAreInput) cp.direction.sent++;
        if (theyAreInput && !weAreInput) cp.direction.received++;
      }
    }
  }

  return { counterparties, txsScanned };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   STAKE KEY NEIGHBORHOOD SCANNER                            ║');
  console.log('║   Building entity clusters around drain destination keys    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load DRep check results — the stake keys we want to scan around
  const drepFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('drep-check-'));
  if (drepFiles.length === 0) {
    console.log('No DRep check results found. Run drep-check.js first.');
    return;
  }

  const latestDrep = drepFiles.sort().pop();
  const drepData = JSON.parse(fs.readFileSync(path.join(outputDir, latestDrep), 'utf8'));

  // Get stake keys sorted by ADA flowed (biggest first)
  const stakeKeys = drepData.stakeKeys
    .filter(sk => sk.stakeKey && sk.controlledAda > 0) // only keys with current ADA
    .sort((a, b) => b.totalAdaFlowed - a.totalAdaFlowed);

  console.log(`\nFound ${stakeKeys.length} stake keys with current ADA to scan`);
  console.log(`Max ${MAX_TXS_PER_ADDRESS} txs per address | Saving after every key\n`);

  // Check for resume
  const saved = loadProgress();
  const completed = new Set(saved?.completed || []);
  const allResults = saved?.results || [];
  const neighborhoodMap = saved?.neighborhoodMap || {}; // stakeKey -> neighbors[]

  let processed = completed.size;

  for (const sk of stakeKeys) {
    if (completed.has(sk.stakeKey)) continue;
    processed++;

    console.log(`\n  [${processed}/${stakeKeys.length}] Scanning neighborhood of ${sk.stakeKey.substring(0, 40)}...`);
    console.log(`    ADA flowed: ${sk.totalAdaFlowed.toLocaleString()} | Controlled: ${sk.controlledAda.toLocaleString()} ADA | ${sk.addresses.length} addrs`);

    // Get addresses under this stake key
    let addresses;
    if (sk.addresses && sk.addresses.length > 0) {
      // Use cached addresses from drep-check
      addresses = sk.addresses.map(a => ({ address: a }));
    } else {
      addresses = await getAccountAddresses(sk.stakeKey);
    }

    if (addresses.length === 0) {
      console.log('    No addresses found, skipping');
      completed.add(sk.stakeKey);
      continue;
    }

    const { counterparties, txsScanned } = await scanNeighborhood(sk.stakeKey, addresses);

    // Enrich ALL counterparties with stake info and balance
    const sorted = [...counterparties.values()]
      .sort((a, b) => b.txCount - a.txCount);

    const enriched = [];
    for (const cp of sorted) {
      const info = await getStakeInfo(cp.stakeKey);
      enriched.push({
        stakeKey: cp.stakeKey,
        txCount: cp.txCount,
        direction: cp.direction,
        sampleAddresses: [...cp.sampleAddresses],
        controlledAda: info?.ada || 0,
        pool: info?.poolId || null,
        drep: info?.drepId || null,
        active: info?.active || false
      });

      const drepLabel = info?.drepId
        ? (info.drepId === 'drep_always_abstain' ? 'ABSTAIN' :
           info.drepId === 'drep_always_no_confidence' ? 'NO_CONF' :
           info.drepId.substring(0, 15) + '...')
        : 'NO DRep';
      const dir = cp.direction.sent > cp.direction.received ? '→ SENT' :
                  cp.direction.received > cp.direction.sent ? '← RECV' : '↔ BOTH';
      console.log(`    ${dir.padEnd(8)} ${cp.txCount} txs | ${(info?.ada || 0).toLocaleString().padStart(15)} ADA | ${drepLabel.padEnd(18)} | ${cp.stakeKey.substring(0, 35)}...`);
    }

    const result = {
      stakeKey: sk.stakeKey,
      totalAdaFlowed: sk.totalAdaFlowed,
      controlledAda: sk.controlledAda,
      pool: sk.pool,
      drep: sk.drep,
      addressesChecked: addresses.length,
      txsScanned,
      neighbors: enriched,
      neighborCount: counterparties.size
    };

    allResults.push(result);
    neighborhoodMap[sk.stakeKey] = enriched;
    completed.add(sk.stakeKey);

    console.log(`    Found ${counterparties.size} unique neighbor stake keys (${txsScanned} txs scanned)`);

    if (processed % SAVE_INTERVAL === 0) {
      saveProgress({
        completed: [...completed],
        results: allResults,
        neighborhoodMap,
        timestamp: new Date().toISOString()
      });
      console.log(`  === SAVED: ${processed} stake keys scanned ===`);
    }
  }

  // Final save
  saveProgress({
    completed: [...completed],
    results: allResults,
    neighborhoodMap,
    complete: true,
    timestamp: new Date().toISOString()
  });

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('  NEIGHBORHOOD SCAN SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Stake keys scanned:     ${allResults.length}`);

  // Find most common neighbors (appear across multiple keys)
  const globalNeighbors = new Map(); // stakeKey -> { appearances, totalTxs, ada, drep }
  for (const result of allResults) {
    for (const n of result.neighbors) {
      if (!globalNeighbors.has(n.stakeKey)) {
        globalNeighbors.set(n.stakeKey, {
          stakeKey: n.stakeKey,
          appearances: 0,
          totalTxs: 0,
          controlledAda: n.controlledAda,
          drep: n.drep,
          pool: n.pool
        });
      }
      const g = globalNeighbors.get(n.stakeKey);
      g.appearances++;
      g.totalTxs += n.txCount;
    }
  }

  const commonNeighbors = [...globalNeighbors.values()]
    .sort((a, b) => b.appearances - a.appearances);

  if (commonNeighbors.length > 0) {
    console.log(`\n  MOST CONNECTED NEIGHBORS (appear across multiple genesis-linked keys):`);
    for (const n of commonNeighbors) {
      const drepLabel = n.drep
        ? (n.drep === 'drep_always_abstain' ? 'ABSTAIN' :
           n.drep === 'drep_always_no_confidence' ? 'NO_CONF' :
           n.drep.substring(0, 15) + '...')
        : 'NO DRep';
      console.log(`    ${n.appearances} keys connected | ${n.totalTxs} txs | ${n.controlledAda.toLocaleString().padStart(15)} ADA | ${drepLabel.padEnd(18)} | ${n.stakeKey.substring(0, 35)}...`);
    }
  }

  // ADA held by neighbors
  const totalNeighborAda = [...globalNeighbors.values()].reduce((sum, n) => sum + n.controlledAda, 0);
  const uniqueNeighborKeys = globalNeighbors.size;
  console.log(`\n  Total unique neighbor stake keys: ${uniqueNeighborKeys}`);
  console.log(`  Total ADA held by neighbors:      ${totalNeighborAda.toLocaleString()}`);

  // Neighbor DRep breakdown
  const neighborDrepStats = { noDrep: 0, abstain: 0, noConf: 0, actualDrep: 0 };
  const neighborAdaByDrep = { noDrep: 0, abstain: 0, noConf: 0, actualDrep: 0 };
  for (const n of globalNeighbors.values()) {
    if (!n.drep) { neighborDrepStats.noDrep++; neighborAdaByDrep.noDrep += n.controlledAda; }
    else if (n.drep === 'drep_always_abstain') { neighborDrepStats.abstain++; neighborAdaByDrep.abstain += n.controlledAda; }
    else if (n.drep === 'drep_always_no_confidence') { neighborDrepStats.noConf++; neighborAdaByDrep.noConf += n.controlledAda; }
    else { neighborDrepStats.actualDrep++; neighborAdaByDrep.actualDrep += n.controlledAda; }
  }

  console.log(`\n  Neighbor DRep breakdown:`);
  console.log(`    No DRep:              ${neighborDrepStats.noDrep} keys (${neighborAdaByDrep.noDrep.toLocaleString()} ADA)`);
  console.log(`    Always abstain:       ${neighborDrepStats.abstain} keys (${neighborAdaByDrep.abstain.toLocaleString()} ADA)`);
  console.log(`    Always no confidence: ${neighborDrepStats.noConf} keys (${neighborAdaByDrep.noConf.toLocaleString()} ADA)`);
  console.log(`    Actual DRep:          ${neighborDrepStats.actualDrep} keys (${neighborAdaByDrep.actualDrep.toLocaleString()} ADA)`);

  const savePath = path.join(outputDir, `neighborhood-scan-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify({
    results: allResults,
    commonNeighbors,
    globalNeighborCount: uniqueNeighborKeys,
    totalNeighborAda,
    neighborDrepStats,
    neighborAdaByDrep
  }, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);

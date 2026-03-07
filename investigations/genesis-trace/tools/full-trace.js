require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();

/**
 * FULL FORWARD TRACE — NO LIMITS
 *
 * Unlike the capped tracers, this one:
 * - Follows ALL outflows above MIN_ADA threshold
 * - No address cap — exhausts the full graph
 * - Saves progress every 100 addresses
 * - Can resume from saved progress
 * - Reports statistics as it goes
 */

const MIN_ADA_FLOW = 10_000; // Only follow flows >= 10k ADA
const MAX_DEPTH = 50;
const SAVE_INTERVAL = 100;
const outputDir = path.join(__dirname, 'output');

function progressPath(entity) {
  return path.join(outputDir, `full-trace-${entity}-progress.json`);
}

function loadProgress(entity) {
  const p = progressPath(entity);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return null;
}

function saveEntityProgress(entity, state) {
  fs.writeFileSync(progressPath(entity), JSON.stringify(state, null, 2));
}

async function getAddressTxs(address, count = 100, page = 1) {
  try {
    return await rateLimited(() =>
      api.addressesTransactions(address, { count, page })
    );
  } catch (err) {
    if (err.status_code === 404) return [];
    throw err;
  }
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

async function fullTrace(startAddress, entityName, genesisAda) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  FULL TRACE: ${entityName}`);
  console.log(`  Genesis: ${genesisAda.toLocaleString()} ADA`);
  console.log(`  Min flow: ${MIN_ADA_FLOW.toLocaleString()} ADA`);
  console.log(`${'='.repeat(70)}`);

  // Try to resume from saved progress
  const saved = loadProgress(entityName);
  const visited = new Set(saved?.visited || []);
  const shelleyHits = saved?.shelleyHits || [];
  const stakeKeys = new Map();
  if (saved?.stakeKeys) {
    for (const [k, v] of Object.entries(saved.stakeKeys)) {
      stakeKeys.set(k, v);
    }
  }

  // BFS queue — sorted by ADA (process biggest flows first)
  let queue = saved?.queue || [{ address: startAddress, depth: 0, ada: genesisAda }];

  if (saved) {
    console.log(`  Resuming: ${visited.size} visited, ${queue.length} in queue, ${shelleyHits.length} Shelley hits`);
  }

  let processed = visited.size;
  let totalAdaTraced = saved?.totalAdaTraced || 0;
  let lastSave = Date.now();

  while (queue.length > 0) {
    // Sort queue by ADA descending (process biggest flows first)
    queue.sort((a, b) => b.ada - a.ada);
    const current = queue.shift();

    if (visited.has(current.address) || current.depth > MAX_DEPTH) continue;
    visited.add(current.address);
    processed++;

    const isShelley = current.address.startsWith('addr1') || current.address.startsWith('addr_');

    // If Shelley — record it and check governance, but ALSO keep tracing
    if (isShelley) {
      const info = await getAddressInfo(current.address);
      const lovelace = info?.amount?.find(a => a.unit === 'lovelace');
      const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;

      const hit = {
        address: current.address,
        depth: current.depth,
        flowedAda: current.ada,
        currentBalance: ada,
        stakeAddress: info?.stake_address || null
      };

      if (info?.stake_address) {
        // Check governance
        const stakeInfo = await getStakeInfo(info.stake_address);
        if (stakeInfo) {
          hit.governance = {
            pool: stakeInfo.poolId,
            drep: stakeInfo.drepId,
            active: stakeInfo.active,
            controlledAda: stakeInfo.ada
          };

          // Track unique stake keys
          if (!stakeKeys.has(info.stake_address)) {
            stakeKeys.set(info.stake_address, {
              controlledAda: stakeInfo.ada,
              pool: stakeInfo.poolId,
              drep: stakeInfo.drepId,
              active: stakeInfo.active,
              addressCount: 1
            });
          } else {
            stakeKeys.get(info.stake_address).addressCount++;
          }
        }
      }

      shelleyHits.push(hit);
      totalAdaTraced += current.ada;

      // Liquid staking: ADA stays in address. If controlled = 0, delegation is empty/meaningless
      const stakeAda = hit.governance?.controlledAda || 0;
      const hasDelegation = !!(hit.governance?.pool || hit.governance?.drep);
      let govStatus;
      if (stakeAda > 0 && hasDelegation) {
        govStatus = 'STAKED';      // Actually staking ADA
      } else if (hasDelegation && stakeAda === 0) {
        govStatus = 'EMPTY-DELEG'; // Delegation registered but 0 ADA behind it
      } else {
        govStatus = 'NO-GOV';      // No delegation at all
      }
      const drepLabel = hit.governance?.drep ? ` | DRep: ${hit.governance.drep.substring(0, 25)}` : '';
      console.log(`  [${processed}] SHELLEY depth ${current.depth} | ${current.ada.toLocaleString()} ADA flowed | ${ada.toLocaleString()} ADA addr | ${stakeAda.toLocaleString()} ADA staked | ${govStatus}${drepLabel} | ${current.address.substring(0, 40)}...`);

      // Don't stop at Shelley — keep tracing outflows from here too
    }

    // Get transactions and follow outflows
    const txs = await getAddressTxs(current.address, 100);
    if (txs.length === 0) continue;

    // Aggregate outgoing destinations
    const destinations = new Map();
    for (const tx of txs.slice(0, 50)) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;

      for (const out of utxos.outputs) {
        if (out.address === current.address) continue;
        const lovelace = out.amount.find(a => a.unit === 'lovelace');
        const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
        if (ada < MIN_ADA_FLOW) continue;

        if (!destinations.has(out.address)) {
          destinations.set(out.address, { address: out.address, totalAda: 0 });
        }
        destinations.get(out.address).totalAda += ada;
      }
    }

    // Add ALL destinations above threshold to queue
    for (const [addr, data] of destinations) {
      if (!visited.has(addr)) {
        queue.push({ address: addr, depth: current.depth + 1, ada: data.totalAda });
      }
    }

    // Periodic logging
    if (processed % 25 === 0) {
      const shelleyPct = shelleyHits.length > 0 ? ((totalAdaTraced / genesisAda) * 100).toFixed(2) : '0.00';
      console.log(`  --- ${entityName}: ${processed} processed, ${queue.length} queued, ${shelleyHits.length} Shelley, ${shelleyPct}% ADA coverage ---`);
    }

    // Save progress periodically
    if (processed % SAVE_INTERVAL === 0 || Date.now() - lastSave > 60000) {
      const state = {
        entityName,
        genesisAda,
        visited: [...visited],
        queue: queue.slice(0, 10000), // cap queue serialization
        shelleyHits,
        stakeKeys: Object.fromEntries(stakeKeys),
        totalAdaTraced,
        timestamp: new Date().toISOString()
      };
      saveEntityProgress(entityName, state);
      lastSave = Date.now();
      console.log(`  === SAVED: ${processed} addresses, ${shelleyHits.length} Shelley hits, ${stakeKeys.size} stake keys ===`);
    }
  }

  // Final save
  const finalState = {
    entityName,
    genesisAda,
    visited: [...visited],
    queue: [],
    shelleyHits,
    stakeKeys: Object.fromEntries(stakeKeys),
    totalAdaTraced,
    complete: true,
    timestamp: new Date().toISOString()
  };
  saveEntityProgress(entityName, finalState);

  return {
    entityName,
    addressesProcessed: visited.size,
    shelleyHits: shelleyHits.length,
    stakeKeysFound: stakeKeys.size,
    totalAdaTraced,
    coveragePct: ((totalAdaTraced / genesisAda) * 100).toFixed(2)
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   FULL FORWARD TRACE — NO LIMITS                            ║');
  console.log('║   Exhausting the complete UTXO graph from genesis           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load first trace results to get starting addresses
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('genesis-trace-'));
  const latest = files.sort().pop();
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));

  const entities = [
    { key: 'emurgo', ada: 2_074_165_644 },
    { key: 'cardanoFoundation', ada: 648_176_761 },
    { key: 'iohk', ada: 2_463_071_701 }
  ];

  for (const entity of entities) {
    const traceData = report.entities[entity.key];
    if (!traceData?.topDestinations?.length) continue;

    const primaryDest = traceData.topDestinations[0];
    const result = await fullTrace(primaryDest.address, traceData.name, entity.ada);

    console.log(`\n  ${entity.key} complete:`);
    console.log(`    Addresses: ${result.addressesProcessed}`);
    console.log(`    Shelley:   ${result.shelleyHits}`);
    console.log(`    Stake keys: ${result.stakeKeysFound}`);
    console.log(`    Coverage:  ${result.coveragePct}%`);
  }
}

main().catch(console.error);

require('dotenv').config();
const fs = require('fs');
const path = require('path');

/**
 * LINK CHAIN AGGREGATOR
 *
 * Stitches ALL data sources together into a single chain-of-custody view.
 *
 * Structure:
 *   GENESIS LOCK → [link hops: txs, wallets, ada amounts] → DESTINATION LOCK
 *
 * A "lock" is a verified anchor point:
 *   - START LOCK: Genesis address (known Emurgo/IOHK/CF allocation)
 *   - END LOCK: Current wallet with known governance status
 *
 * Links in between are the intermediate hops where funds mix, split, merge.
 * Each chain gets a confidence score based on:
 *   - Number of linked txs connecting start to end
 *   - Number of intermediate wallets
 *   - Whether the connection is direct or via neighbors
 *
 * Data sources stitched:
 *   1. drep-check-*.json — Stake keys, DRep status, ADA flowed
 *   2. neighborhood-scan-*.json — Entity clusters, neighbor connections
 *   3. drep-delegator-trace-*.json — Emurgo DRep delegator genesis links
 *   4. deep-dive-*.json — Treasury, hub wallet, no-conf whale details
 */

const outputDir = path.join(__dirname, 'output');

function loadLatest(prefix) {
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith(prefix));
  if (files.length === 0) return null;
  const latest = files.sort().pop();
  return JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   LINK CHAIN AGGREGATOR                                    ║');
  console.log('║   Stitching genesis → destination chains                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load all data sources
  const drepCheck = loadLatest('drep-check-');
  const neighborScan = loadLatest('neighborhood-scan-');
  const delegatorTrace = loadLatest('drep-delegator-trace-');
  const deepDive = loadLatest('deep-dive-');

  if (!drepCheck) { console.log('ERROR: No drep-check data found'); return; }
  if (!neighborScan) { console.log('ERROR: No neighborhood-scan data found'); return; }

  console.log(`\nData sources loaded:`);
  console.log(`  DRep check:       ${drepCheck.stakeKeys.length} stake keys`);
  console.log(`  Neighborhood:     ${neighborScan.results.length} keys scanned, ${neighborScan.globalNeighborCount} neighbors`);
  console.log(`  Delegator trace:  ${delegatorTrace ? delegatorTrace.totalDelegators + ' delegators' : 'NOT YET AVAILABLE'}`);
  console.log(`  Deep dive:        ${deepDive ? 'loaded' : 'NOT YET AVAILABLE'}`);

  // === BUILD THE MASTER REGISTRY ===
  // Every stake key, DRep ID, and their relationships
  const registry = {
    stakeKeys: new Map(),   // stakeKey -> full info
    drepIds: new Map(),     // drepId -> { delegators, totalAda, votes }
    chains: [],             // Array of link chains
    stats: {}
  };

  // 1. Register all genesis-linked stake keys (START LOCKS)
  for (const sk of drepCheck.stakeKeys) {
    registry.stakeKeys.set(sk.stakeKey, {
      stakeKey: sk.stakeKey,
      role: 'GENESIS_DESTINATION',
      totalAdaFlowed: sk.totalAdaFlowed,
      controlledAda: sk.controlledAda,
      pool: sk.pool,
      drep: sk.drep,
      label: sk.label,
      active: sk.active,
      addresses: sk.addresses,
      neighbors: [],
      chainIds: []
    });
  }

  // 2. Register all neighbors (INTERMEDIATE NODES)
  if (neighborScan.results) {
    for (const result of neighborScan.results) {
      for (const n of result.neighbors) {
        if (!registry.stakeKeys.has(n.stakeKey)) {
          registry.stakeKeys.set(n.stakeKey, {
            stakeKey: n.stakeKey,
            role: 'NEIGHBOR',
            totalAdaFlowed: 0,
            controlledAda: n.controlledAda,
            pool: n.pool,
            drep: n.drep,
            active: n.active,
            neighbors: [],
            chainIds: [],
            connectedGenesisKeys: []
          });
        }
        const entry = registry.stakeKeys.get(n.stakeKey);
        if (!entry.connectedGenesisKeys) entry.connectedGenesisKeys = [];
        entry.connectedGenesisKeys.push({
          genesisKey: result.stakeKey,
          txCount: n.txCount,
          direction: n.direction
        });
      }
    }
  }

  // 3. Register DRep delegators if available
  if (delegatorTrace && delegatorTrace.results) {
    for (const d of delegatorTrace.results) {
      if (!registry.stakeKeys.has(d.stakeKey)) {
        registry.stakeKeys.set(d.stakeKey, {
          stakeKey: d.stakeKey,
          role: 'DREP_DELEGATOR',
          totalAdaFlowed: 0,
          controlledAda: d.ada,
          drep: delegatorTrace.drepId,
          chainIds: []
        });
      }
      const entry = registry.stakeKeys.get(d.stakeKey);
      entry.delegatorMatch = d.match;
      entry.delegatorAda = d.ada;
    }
  }

  // 4. Register the key entities from deep dive
  const keyEntities = {
    'stake1u9zjr6e37w53a474puhx606ayr3rz2l6jljrmzvlzkk3cmg0m2zw0': {
      label: 'TREASURY_1.89B',
      description: 'Treasury splitting 32M ADA chunks to abstain keys',
      controlledAda: 1889254096
    },
    'stake1u89hxtuxvfdqda90w2aw2mluxcsgyctfe2lz52n986lrc2cumssr9': {
      label: 'HUB_WALLET',
      description: 'Routing wallet connecting 7 genesis-linked keys',
      controlledAda: 59865
    },
    'stake1u9phffdh79gc8lrlk3vmxjgtedrhcfnrhc8u6wpz3zrlkxqvehgsq': {
      label: 'NO_CONF_WHALE',
      description: 'Largest genesis receiver, votes no-confidence',
      controlledAda: 7235577
    }
  };

  for (const [sk, info] of Object.entries(keyEntities)) {
    if (registry.stakeKeys.has(sk)) {
      const entry = registry.stakeKeys.get(sk);
      entry.entityLabel = info.label;
      entry.entityDescription = info.description;
    }
  }

  // === BUILD LINK CHAINS ===
  // Each chain: genesis allocation → intermediate hops → current destination
  let chainId = 0;

  // Chain Type 1: DIRECT GENESIS → Governance
  for (const sk of drepCheck.stakeKeys) {
    if (sk.controlledAda <= 0) continue;

    const chain = {
      id: chainId++,
      type: 'DIRECT',
      confidence: 'HIGH',
      startLock: {
        type: 'GENESIS',
        entity: 'EMURGO', // We've traced Emurgo so far
        adaAllocated: sk.totalAdaFlowed
      },
      links: [], // intermediate hops would go here
      endLock: {
        type: 'CURRENT_HOLDER',
        stakeKey: sk.stakeKey,
        controlledAda: sk.controlledAda,
        pool: sk.pool,
        drep: sk.drep,
        active: sk.active
      },
      totalAdaFlowed: sk.totalAdaFlowed,
      currentAda: sk.controlledAda,
      governanceStatus: classifyGovernance(sk.drep),
      hops: 0
    };

    registry.chains.push(chain);
  }

  // Chain Type 2: GENESIS → Neighbor → DRep Delegator
  if (delegatorTrace && delegatorTrace.results) {
    for (const d of delegatorTrace.results) {
      if (d.match === 'NO_GENESIS_LINK') continue;

      const chain = {
        id: chainId++,
        type: d.match,
        confidence: d.match === 'DIRECT_GENESIS' ? 'HIGH'
                  : d.match === 'NEIGHBOR' ? 'MEDIUM'
                  : d.match.startsWith('TX_LINK') ? 'MEDIUM'
                  : 'LOW',
        startLock: {
          type: 'GENESIS',
          entity: 'EMURGO',
          linkedGenesisKey: d.linkedGenesisKey || d.match === 'DIRECT_GENESIS' ? d.stakeKey : null
        },
        links: [],
        endLock: {
          type: 'DREP_DELEGATOR',
          stakeKey: d.stakeKey,
          controlledAda: d.ada,
          drep: 'drep1ytvlwvyjmzfyn56n0zz4f6lj94wxhmsl5zky6knnzrf4jygpyahug',
          drepName: 'EMURGO'
        },
        totalAdaFlowed: d.genesisAdaFlowed || 0,
        currentAda: d.ada,
        governanceStatus: 'DELEGATED_TO_EMURGO_DREP',
        hops: d.match === 'DIRECT_GENESIS' ? 0
            : d.match === 'NEIGHBOR' ? 1
            : 2
      };

      // Add intermediate link if it's a neighbor or tx-link
      if (d.match === 'TX_LINK_TO_GENESIS' && d.linkedGenesisKey) {
        chain.links.push({
          type: 'TX_CONNECTION',
          stakeKey: d.linkedGenesisKey,
          txHash: d.viaTxHash
        });
      }
      if (d.match === 'TX_LINK_TO_NEIGHBOR' && d.linkedNeighborKey) {
        chain.links.push({
          type: 'NEIGHBOR_CONNECTION',
          stakeKey: d.linkedNeighborKey,
          txHash: d.viaTxHash
        });
      }

      registry.chains.push(chain);
    }
  }

  // Chain Type 3: Treasury → Abstain split wallets
  if (deepDive && deepDive.treasury) {
    for (const dest of deepDive.treasury.destinations) {
      if (dest.stakeKey === 'ENTERPRISE' || dest.stakeKey === 'BYRON' || dest.stakeKey === 'SCRIPT') continue;

      const chain = {
        id: chainId++,
        type: 'TREASURY_SPLIT',
        confidence: 'HIGH',
        startLock: {
          type: 'GENESIS',
          entity: 'EMURGO',
          viaKey: 'stake1u9zjr6e37w53a474puhx606ayr3rz2l6jljrmzvlzkk3cmg0m2zw0'
        },
        links: [{
          type: 'TREASURY_DISTRIBUTION',
          stakeKey: 'stake1u9zjr6e37w53a474puhx606ayr3rz2l6jljrmzvlzkk3cmg0m2zw0',
          label: 'TREASURY_1.89B',
          ada: dest.totalAda,
          txCount: dest.txCount
        }],
        endLock: {
          type: 'SPLIT_DESTINATION',
          stakeKey: dest.stakeKey,
          controlledAda: dest.controlledAda || 0,
          drep: dest.drep,
          pool: dest.pool
        },
        totalAdaFlowed: dest.totalAda,
        currentAda: dest.controlledAda || 0,
        governanceStatus: classifyGovernance(dest.drep),
        hops: 1
      };

      registry.chains.push(chain);
    }
  }

  // === COMPUTE STATS ===
  const stats = {
    totalChains: registry.chains.length,
    totalStakeKeys: registry.stakeKeys.size,
    chainsByType: {},
    chainsByGovernance: {},
    chainsByConfidence: {},
    totalAdaTracked: 0,
    totalCurrentAda: 0,
    genesisToGovernance: {
      noGovernance: { chains: 0, ada: 0 },
      abstain: { chains: 0, ada: 0 },
      noConfidence: { chains: 0, ada: 0 },
      actualDrep: { chains: 0, ada: 0 },
      emurgoDrep: { chains: 0, ada: 0 }
    }
  };

  for (const chain of registry.chains) {
    // By type
    stats.chainsByType[chain.type] = (stats.chainsByType[chain.type] || 0) + 1;
    // By governance
    stats.chainsByGovernance[chain.governanceStatus] = (stats.chainsByGovernance[chain.governanceStatus] || 0) + 1;
    // By confidence
    stats.chainsByConfidence[chain.confidence] = (stats.chainsByConfidence[chain.confidence] || 0) + 1;
    // ADA
    stats.totalAdaTracked += chain.totalAdaFlowed || 0;
    stats.totalCurrentAda += chain.currentAda || 0;
    // Governance breakdown
    const gov = chain.governanceStatus;
    if (gov === 'NO_GOVERNANCE' || gov === 'NO_DREP') stats.genesisToGovernance.noGovernance.chains++, stats.genesisToGovernance.noGovernance.ada += chain.currentAda || 0;
    if (gov === 'ABSTAIN') stats.genesisToGovernance.abstain.chains++, stats.genesisToGovernance.abstain.ada += chain.currentAda || 0;
    if (gov === 'NO_CONFIDENCE') stats.genesisToGovernance.noConfidence.chains++, stats.genesisToGovernance.noConfidence.ada += chain.currentAda || 0;
    if (gov === 'DELEGATED_TO_EMURGO_DREP') stats.genesisToGovernance.emurgoDrep.chains++, stats.genesisToGovernance.emurgoDrep.ada += chain.currentAda || 0;
    if (gov === 'ACTUAL_DREP' && gov !== 'DELEGATED_TO_EMURGO_DREP') stats.genesisToGovernance.actualDrep.chains++, stats.genesisToGovernance.actualDrep.ada += chain.currentAda || 0;
  }

  registry.stats = stats;

  // === PRINT SUMMARY ===
  console.log('\n' + '═'.repeat(70));
  console.log('  LINK CHAIN SUMMARY');
  console.log('═'.repeat(70));
  console.log(`\n  Total chains built:     ${stats.totalChains}`);
  console.log(`  Total stake keys:       ${stats.totalStakeKeys}`);
  console.log(`  Total ADA tracked:      ${stats.totalAdaTracked.toLocaleString()}`);
  console.log(`  Current ADA in chains:  ${stats.totalCurrentAda.toLocaleString()}`);

  console.log('\n  CHAINS BY TYPE:');
  for (const [type, count] of Object.entries(stats.chainsByType)) {
    console.log(`    ${type.padEnd(25)} ${count}`);
  }

  console.log('\n  CHAINS BY CONFIDENCE:');
  for (const [conf, count] of Object.entries(stats.chainsByConfidence)) {
    console.log(`    ${conf.padEnd(10)} ${count}`);
  }

  console.log('\n  CHAINS BY GOVERNANCE:');
  for (const [gov, count] of Object.entries(stats.chainsByGovernance)) {
    console.log(`    ${gov.padEnd(30)} ${count}`);
  }

  console.log('\n  GENESIS → GOVERNANCE FLOW:');
  const gog = stats.genesisToGovernance;
  console.log(`    No governance:         ${gog.noGovernance.chains} chains | ${gog.noGovernance.ada.toLocaleString()} ADA`);
  console.log(`    Abstain:               ${gog.abstain.chains} chains | ${gog.abstain.ada.toLocaleString()} ADA`);
  console.log(`    No confidence:         ${gog.noConfidence.chains} chains | ${gog.noConfidence.ada.toLocaleString()} ADA`);
  console.log(`    Emurgo DRep:           ${gog.emurgoDrep.chains} chains | ${gog.emurgoDrep.ada.toLocaleString()} ADA`);
  console.log(`    Other actual DRep:     ${gog.actualDrep.chains} chains | ${gog.actualDrep.ada.toLocaleString()} ADA`);

  // === DRep REGISTRY ===
  console.log('\n  DREP REGISTRY:');
  const drepCounts = new Map();
  for (const chain of registry.chains) {
    const drep = chain.endLock?.drep;
    if (drep && drep !== 'drep_always_abstain' && drep !== 'drep_always_no_confidence') {
      if (!drepCounts.has(drep)) drepCounts.set(drep, { count: 0, ada: 0 });
      drepCounts.get(drep).count++;
      drepCounts.get(drep).ada += chain.currentAda || 0;
    }
  }
  for (const [drep, info] of drepCounts) {
    const label = drep.startsWith('drep1ytvlwvy') ? 'EMURGO' : drep.substring(0, 30) + '...';
    console.log(`    ${label.padEnd(35)} ${info.count} chains | ${info.ada.toLocaleString()} ADA`);
  }

  // Save
  const savePath = path.join(outputDir, `link-chain-${Date.now()}.json`);
  const serializable = {
    stats: registry.stats,
    chains: registry.chains,
    stakeKeys: Object.fromEntries(registry.stakeKeys),
    keyEntities,
    drepRegistry: Object.fromEntries(drepCounts),
    metadata: {
      generated: new Date().toISOString(),
      dataSources: {
        drepCheck: !!drepCheck,
        neighborScan: !!neighborScan,
        delegatorTrace: !!delegatorTrace,
        deepDive: !!deepDive
      }
    }
  };

  fs.writeFileSync(savePath, JSON.stringify(serializable, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

function classifyGovernance(drep) {
  if (!drep) return 'NO_DREP';
  if (drep === 'drep_always_abstain') return 'ABSTAIN';
  if (drep === 'drep_always_no_confidence') return 'NO_CONFIDENCE';
  if (drep === 'drep1ytvlwvyjmzfyn56n0zz4f6lj94wxhmsl5zky6knnzrf4jygpyahug') return 'DELEGATED_TO_EMURGO_DREP';
  return 'ACTUAL_DREP';
}

main();

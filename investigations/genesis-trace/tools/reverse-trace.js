require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();

/**
 * REVERSE TRACER
 *
 * Instead of tracing FORWARD from genesis (which hits exponential Byron branching),
 * we start from known large Shelley wallets TODAY and trace BACKWARDS through their
 * transaction inputs, looking for connections to known genesis/Byron addresses.
 *
 * This helps us "meet in the middle" — forward trace maps genesis -> Byron chains,
 * reverse trace maps Shelley wallets -> their funding sources.
 */

const KNOWN_GENESIS_PREFIXES = [
  'Ae2tdPwUPEZGcVv9qJ3K',  // Emurgo genesis
  'Ae2tdPwUPEZ9dH9VC4iV',  // CF genesis
  'DdzFFzCqrhsytyf2oUxq',  // IOHK genesis TX output
  'DdzFFzCqrhsi4ogKm',      // Emurgo hop-1
  'DdzFFzCqrhsgwQmeWNBTs',  // CF operational
  'DdzFFzCqrht3wEZNURs9U5', // IOHK hop-1
];

const outputDir = path.join(__dirname, 'output');
const progressFile = path.join(outputDir, 'reverse-trace-progress.json');

function loadProgress() {
  if (fs.existsSync(progressFile)) {
    return JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  }
  return { visited: [], queue: [], findings: [], stats: {} };
}

function saveProgress(state) {
  fs.writeFileSync(progressFile, JSON.stringify(state, null, 2));
}

async function getAddressTxs(address, count = 100, page = 1, order = 'desc') {
  try {
    return await rateLimited(() =>
      api.addressesTransactions(address, { count, page, order })
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
    const info = await rateLimited(() => api.addresses(address));
    return {
      type: info.type,
      stakeAddress: info.stake_address,
      balance: info.amount
    };
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

function isKnownGenesis(address) {
  return KNOWN_GENESIS_PREFIXES.some(p => address.startsWith(p));
}

function isByron(address) {
  return address.startsWith('Ae2') || address.startsWith('Ddz');
}

async function reverseTrace(startAddresses, label, maxAddresses = 0) {
  const visited = new Set();
  const queue = []; // { address, depth, reason }
  const findings = [];
  const genesisConnections = [];
  let addressesProcessed = 0;

  // Seed the queue with start addresses
  for (const addr of startAddresses) {
    queue.push({ address: addr, depth: 0, reason: 'seed' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  REVERSE TRACE: ${label}`);
  console.log(`  Starting addresses: ${startAddresses.length}`);
  console.log(`  Max addresses: ${maxAddresses || 'unlimited'}`);
  console.log(`${'='.repeat(70)}`);

  while (queue.length > 0) {
    if (maxAddresses > 0 && addressesProcessed >= maxAddresses) {
      console.log(`\n  [!] Hit address limit (${maxAddresses}). Saving progress.`);
      break;
    }

    const current = queue.shift();
    if (visited.has(current.address)) continue;
    visited.add(current.address);
    addressesProcessed++;

    const indent = '  '.repeat(Math.min(current.depth, 6));
    const addrShort = current.address.substring(0, 45);

    // Get transaction history (oldest first for reverse tracing)
    const txs = await getAddressTxs(current.address, 100, 1, 'asc');
    if (txs.length === 0) {
      if (addressesProcessed % 25 === 0) {
        console.log(`  [${addressesProcessed}] ${addrShort}... | 0 txs | depth ${current.depth}`);
      }
      continue;
    }

    // Look at transaction INPUTS to find where money came FROM
    const fundingSources = new Map(); // address -> { totalAda, txCount, firstSeen }

    for (const tx of txs.slice(0, 50)) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;

      // Check inputs — where did the money come from?
      for (const inp of utxos.inputs) {
        if (inp.address === current.address) continue; // skip self-spend

        const lovelace = inp.amount.find(a => a.unit === 'lovelace');
        const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
        if (ada < 100) continue;

        if (!fundingSources.has(inp.address)) {
          fundingSources.set(inp.address, {
            address: inp.address,
            totalAda: 0,
            txCount: 0,
            txHash: tx.tx_hash
          });
        }
        const src = fundingSources.get(inp.address);
        src.totalAda += ada;
        src.txCount++;
      }

      // Also check — did any output go TO a known genesis address?
      for (const out of utxos.outputs) {
        if (isKnownGenesis(out.address)) {
          genesisConnections.push({
            fromAddress: current.address,
            toGenesis: out.address,
            txHash: tx.tx_hash,
            depth: current.depth
          });
          console.log(`\n  *** GENESIS CONNECTION at depth ${current.depth}! ***`);
          console.log(`      ${current.address.substring(0, 50)}...`);
          console.log(`      -> ${out.address.substring(0, 50)}...`);
          console.log(`      TX: ${tx.tx_hash}`);
        }
      }
    }

    // Check inputs for genesis connections
    for (const [srcAddr, srcData] of fundingSources) {
      if (isKnownGenesis(srcAddr)) {
        genesisConnections.push({
          fromGenesis: srcAddr,
          toAddress: current.address,
          totalAda: srcData.totalAda,
          txHash: srcData.txHash,
          depth: current.depth
        });
        console.log(`\n  *** FUNDED BY GENESIS at depth ${current.depth}! ***`);
        console.log(`      Genesis: ${srcAddr.substring(0, 50)}...`);
        console.log(`      -> ${current.address.substring(0, 50)}...`);
        console.log(`      Amount: ${srcData.totalAda.toLocaleString()} ADA`);
      }
    }

    // Sort funding sources by amount (biggest funders first)
    const sorted = [...fundingSources.values()].sort((a, b) => b.totalAda - a.totalAda);

    // Log periodically
    if (addressesProcessed % 10 === 0 || current.depth <= 2) {
      const topFunder = sorted[0];
      const byronCount = sorted.filter(s => isByron(s.address)).length;
      console.log(`  [${addressesProcessed}] depth ${current.depth} | ${txs.length} txs | ${sorted.length} funding sources (${byronCount} Byron) | ${addrShort}...`);
      if (topFunder) {
        console.log(`         top funder: ${topFunder.totalAda.toLocaleString()} ADA from ${topFunder.address.substring(0, 40)}...`);
      }
    }

    // Record findings for Byron funding sources (these lead back toward genesis)
    for (const src of sorted) {
      if (isByron(src.address) && src.totalAda >= 1000) {
        findings.push({
          shelleyAddress: current.address,
          byronFunder: src.address,
          ada: src.totalAda,
          depth: current.depth,
          txHash: src.txHash
        });
      }

      // Add significant funding sources to the queue for further reverse tracing
      if (src.totalAda >= 10000 && !visited.has(src.address) && current.depth < 20) {
        queue.push({
          address: src.address,
          depth: current.depth + 1,
          reason: `funded ${current.address.substring(0, 20)}... with ${src.totalAda.toLocaleString()} ADA`
        });
      }
    }

    // Save progress every 50 addresses
    if (addressesProcessed % 50 === 0) {
      const state = {
        label,
        addressesProcessed,
        visited: [...visited],
        queueSize: queue.length,
        findings: findings.length,
        genesisConnections,
        timestamp: new Date().toISOString()
      };
      saveProgress(state);
      console.log(`  --- Progress saved (${addressesProcessed} addresses, ${findings.length} Byron links, ${genesisConnections.length} genesis connections) ---`);
    }
  }

  return {
    label,
    addressesProcessed,
    visitedCount: visited.size,
    queueRemaining: queue.length,
    findings,
    genesisConnections,
    byronFundersFound: findings.length,
    uniqueByronFunders: new Set(findings.map(f => f.byronFunder)).size
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   REVERSE GENESIS TRACE                                     ║');
  console.log('║   Tracing backwards from large Shelley wallets to genesis   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load stake analysis to get the big addresses
  const stakeFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('stake-analysis-'));
  if (stakeFiles.length === 0) {
    console.log('No stake analysis found. Run stake-trace.js first.');
    return;
  }

  const latestStake = stakeFiles.sort().pop();
  const stakeData = JSON.parse(fs.readFileSync(path.join(outputDir, latestStake), 'utf8'));

  // Collect starting addresses from the biggest stake keys
  const startAddresses = [];
  for (const key of stakeData.stakeKeys) {
    if (key.topAddresses) {
      for (const addr of key.topAddresses) {
        if (addr.ada >= 100) { // only trace addresses with meaningful balance
          startAddresses.push(addr.address);
        }
      }
    }
  }

  // Also add any Shelley addresses from stake keys with large controlled amounts
  // but no top addresses listed (the 500-address keys)
  for (const key of stakeData.stakeKeys) {
    if (key.controlledAda >= 10000 && (!key.topAddresses || key.topAddresses.length === 0)) {
      // We need to pull addresses from this stake key directly
      try {
        const addrs = await rateLimited(() =>
          api.accountsAddresses(key.stakeAddress, { count: 20, page: 1 })
        );
        if (addrs) {
          for (const a of addrs) {
            const info = await getAddressInfo(a.address);
            const lovelace = info?.balance?.find(b => b.unit === 'lovelace');
            const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
            if (ada >= 1000) {
              startAddresses.push(a.address);
            }
          }
        }
      } catch (err) {
        console.log(`  Could not expand stake key ${key.stakeAddress}: ${err.message}`);
      }
    }
  }

  console.log(`\nStarting reverse trace from ${startAddresses.length} Shelley addresses\n`);

  // Run the reverse trace — no cap, let it ride
  const results = await reverseTrace(startAddresses, 'Genesis-linked Shelley wallets', 0);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  REVERSE TRACE SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Addresses processed:    ${results.addressesProcessed}`);
  console.log(`  Queue remaining:        ${results.queueRemaining}`);
  console.log(`  Byron funders found:    ${results.byronFundersFound}`);
  console.log(`  Unique Byron funders:   ${results.uniqueByronFunders}`);
  console.log(`  Genesis connections:    ${results.genesisConnections.length}`);

  if (results.genesisConnections.length > 0) {
    console.log('\n  GENESIS CONNECTIONS:');
    for (const gc of results.genesisConnections) {
      console.log(`    ${gc.fromGenesis?.substring(0, 40) || gc.fromAddress?.substring(0, 40)}... <-> ${gc.toAddress?.substring(0, 40) || gc.toGenesis?.substring(0, 40)}...`);
      console.log(`    ADA: ${gc.totalAda?.toLocaleString() || 'N/A'} | TX: ${gc.txHash}`);
    }
  }

  if (results.findings.length > 0) {
    console.log('\n  TOP BYRON FUNDING SOURCES:');
    const byronAgg = new Map();
    for (const f of results.findings) {
      if (!byronAgg.has(f.byronFunder)) {
        byronAgg.set(f.byronFunder, { address: f.byronFunder, totalAda: 0, count: 0 });
      }
      const b = byronAgg.get(f.byronFunder);
      b.totalAda += f.ada;
      b.count++;
    }

    const topByron = [...byronAgg.values()].sort((a, b) => b.totalAda - a.totalAda).slice(0, 20);
    for (const b of topByron) {
      console.log(`    ${b.totalAda.toLocaleString().padStart(20)} ADA | ${b.count} links | ${b.address.substring(0, 50)}...`);
    }
  }

  // Save final results
  const savePath = path.join(outputDir, `reverse-trace-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify(results, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);

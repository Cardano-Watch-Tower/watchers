require('dotenv').config();
const { getAddressBalance, getAddressInfo, getAddressTransactions, getTxUtxos } = require('./src/tracer');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

// Follow the largest fund flow until we hit Shelley addresses or max depth
async function deepTrace(startAddress, entityName, maxDepth = 15) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  DEEP TRACE: ${entityName}`);
  console.log(`  Starting: ${startAddress}`);
  console.log(`${'='.repeat(70)}`);

  const visited = new Set();
  const shelleyHits = []; // Addresses where we found Shelley-era
  const traceLog = [];

  async function traceHop(address, depth, parentAda) {
    if (depth > maxDepth || visited.has(address)) return;
    visited.add(address);

    const indent = '  '.repeat(depth);
    const balance = await getAddressBalance(address);
    const info = await getAddressInfo(address);
    const isShelley = address.startsWith('addr1') || address.startsWith('addr_');
    const addrType = isShelley ? 'SHELLEY' : 'Byron';

    console.log(`${indent}[Hop ${depth}] ${addrType} | Balance: ${balance.ada.toLocaleString()} ADA | ${address.substring(0, 50)}...`);

    const logEntry = {
      depth,
      address,
      type: addrType,
      currentBalance: balance.ada,
      stakeAddress: info?.stakeAddress || null,
      flowedAda: parentAda
    };

    // If we found a Shelley address, check governance and stop
    if (isShelley && info?.stakeAddress) {
      console.log(`${indent}  → SHELLEY HIT! Stake: ${info.stakeAddress}`);

      const stakeInfo = await getStakeInfo(info.stakeAddress);
      if (stakeInfo) {
        logEntry.governance = {
          pool: stakeInfo.poolId,
          drep: stakeInfo.drepId,
          active: stakeInfo.active,
          controlledAda: stakeInfo.ada
        };
        console.log(`${indent}  → Pool: ${stakeInfo.poolId || 'none'}`);
        console.log(`${indent}  → DRep: ${stakeInfo.drepId || 'none'}`);
        console.log(`${indent}  → Controlled: ${stakeInfo.ada.toLocaleString()} ADA`);
      }

      shelleyHits.push(logEntry);
      traceLog.push(logEntry);
      return;
    }

    traceLog.push(logEntry);

    // Get transactions and follow the money
    const txs = await getAddressTransactions(address, 5);
    if (txs.length === 0) {
      console.log(`${indent}  → Dead end (no transactions)`);
      return;
    }

    console.log(`${indent}  → ${txs.length} transactions`);

    // Build outgoing destinations
    const destinations = new Map();
    for (const tx of txs.slice(0, 30)) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;

      for (const out of utxos.outputs) {
        if (out.address === address) continue;
        const lovelace = out.amount.find(a => a.unit === 'lovelace');
        const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
        if (ada < 100) continue; // skip dust

        if (!destinations.has(out.address)) {
          destinations.set(out.address, { address: out.address, totalAda: 0, txCount: 0 });
        }
        const d = destinations.get(out.address);
        d.totalAda += ada;
        d.txCount++;
      }
    }

    // Sort by ADA amount and follow top destinations
    const sorted = [...destinations.values()].sort((a, b) => b.totalAda - a.totalAda);

    // Follow the top 3 largest flows (or all if < 3)
    const toFollow = sorted.slice(0, 3);
    for (const dest of toFollow) {
      if (dest.totalAda < 1000) continue; // skip small flows
      await traceHop(dest.address, depth + 1, dest.totalAda);
    }
  }

  await traceHop(startAddress, 0, 0);

  console.log(`\n  --- ${entityName} Deep Trace Summary ---`);
  console.log(`  Total addresses visited: ${visited.size}`);
  console.log(`  Shelley addresses found: ${shelleyHits.length}`);

  if (shelleyHits.length > 0) {
    console.log(`\n  Shelley destinations:`);
    let govCount = 0;
    let totalGovAda = 0;
    let totalNonGovAda = 0;

    for (const hit of shelleyHits) {
      const govStatus = hit.governance?.pool || hit.governance?.drep ? 'GOV-ACTIVE' : 'NO-GOV';
      if (govStatus === 'GOV-ACTIVE') {
        govCount++;
        totalGovAda += hit.currentBalance;
      } else {
        totalNonGovAda += hit.currentBalance;
      }
      console.log(`    ${hit.currentBalance.toLocaleString().padStart(20)} ADA | ${govStatus.padEnd(10)} | ${hit.address.substring(0, 50)}...`);
    }

    console.log(`\n  Governance: ${govCount}/${shelleyHits.length} addresses active`);
    console.log(`  ADA in governance: ${totalGovAda.toLocaleString()}`);
    console.log(`  ADA NOT in governance: ${totalNonGovAda.toLocaleString()}`);
  }

  return { entityName, visited: visited.size, shelleyHits, traceLog };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   DEEP GENESIS FUND TRACE                          ║');
  console.log('║   Following Byron → Shelley migration paths        ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Load first trace results to get hop-1 addresses
  const outputDir = path.join(__dirname, 'output');
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('genesis-trace-'));
  const latest = files.sort().pop();
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));

  const results = {};
  const entities = ['emurgo', 'cardanoFoundation', 'iohk'];

  for (const key of entities) {
    const traceData = report.entities[key];
    if (!traceData?.topDestinations?.length) continue;

    const primaryDest = traceData.topDestinations[0];
    results[key] = await deepTrace(primaryDest.address, traceData.name);
  }

  // Save deep trace results
  const deepPath = path.join(outputDir, `deep-trace-${Date.now()}.json`);
  fs.writeFileSync(deepPath, JSON.stringify(results, null, 2));
  console.log(`\nDeep trace saved: ${deepPath}`);
}

main().catch(console.error);

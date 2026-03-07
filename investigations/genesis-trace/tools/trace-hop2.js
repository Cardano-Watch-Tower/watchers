require('dotenv').config();
const { getAddressBalance, getAddressInfo, getAddressTransactions, getTxUtxos } = require('./src/tracer');

// Second-hop addresses from the first trace
const HOP1_DESTINATIONS = {
  emurgo: {
    name: 'Emurgo (hop 1)',
    address: 'DdzFFzCqrhsi4ogKmCFQwBUWqtS18UBL3SrdDoNu',
    ada: 2_074_165_643
  },
  cf: {
    name: 'Cardano Foundation (hop 1)',
    address: 'DdzFFzCqrht1RAzCsYyTHZJymt4qj65bV41Tyufb',
    ada: 648_176_763
  },
  iohk: {
    name: 'IOHK (hop 1)',
    address: 'DdzFFzCqrht3wEZNURs9U5Qp7HnLoi9Cpao2YzTh',
    ada: 2_463_070_700
  }
};

async function main() {
  // First, we need the full addresses from the output report
  const fs = require('fs');
  const path = require('path');
  const outputDir = path.join(__dirname, 'output');
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('genesis-trace-'));
  const latest = files.sort().pop();
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));

  console.log('=== SECOND HOP TRACE ===\n');
  console.log('Following founding entity funds through intermediate addresses...\n');

  // Get full addresses from the report
  const entities = [
    { key: 'emurgo', name: 'Emurgo' },
    { key: 'cardanoFoundation', name: 'Cardano Foundation' },
    { key: 'iohk', name: 'IOHK' }
  ];

  for (const entity of entities) {
    const traceData = report.entities[entity.key];
    if (!traceData?.topDestinations?.length) {
      console.log(`\n--- ${entity.name}: No destinations to trace ---`);
      continue;
    }

    // Get the primary destination (largest ADA flow)
    const primaryDest = traceData.topDestinations[0];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${entity.name}`);
    console.log(`  Hop 1 address: ${primaryDest.address}`);
    console.log(`  Amount: ${primaryDest.ada.toLocaleString()} ADA`);
    console.log(`${'='.repeat(60)}`);

    // Get balance and info
    const balance = await getAddressBalance(primaryDest.address);
    console.log(`  Current balance: ${balance.ada.toLocaleString()} ADA`);

    const info = await getAddressInfo(primaryDest.address);
    console.log(`  Type: ${info?.type || 'unknown'}`);
    console.log(`  Stake key: ${info?.stakeAddress || 'none (Byron)'}`);

    // Get transaction history
    const txs = await getAddressTransactions(primaryDest.address, 30);
    console.log(`  Total transactions: ${txs.length}`);

    if (txs.length === 0) {
      console.log(`  [!] No outgoing transactions — funds still here or address unreachable`);
      continue;
    }

    // Analyze where funds went from here
    const destinations = new Map();
    let txAnalyzed = 0;

    for (const tx of txs.slice(0, 100)) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;
      txAnalyzed++;

      for (const out of utxos.outputs) {
        if (out.address === primaryDest.address) continue; // skip self
        const lovelace = out.amount.find(a => a.unit === 'lovelace');
        const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
        if (ada === 0) continue;

        if (!destinations.has(out.address)) {
          destinations.set(out.address, { address: out.address, totalAda: 0, txCount: 0 });
        }
        const d = destinations.get(out.address);
        d.totalAda += ada;
        d.txCount++;
      }

      if (txAnalyzed % 10 === 0) {
        process.stdout.write(`  Analyzed ${txAnalyzed}/${Math.min(txs.length, 100)} txs...\r`);
      }
    }

    const sorted = [...destinations.values()].sort((a, b) => b.totalAda - a.totalAda);
    console.log(`\n  Unique hop-2 destinations: ${sorted.length}`);
    console.log(`\n  Top 15 hop-2 destinations:`);

    let totalTraced = 0;
    for (let i = 0; i < Math.min(sorted.length, 15); i++) {
      const d = sorted[i];
      totalTraced += d.totalAda;

      // Check if it's a Shelley address (has stake key)
      const destInfo = await getAddressInfo(d.address);
      const addrType = d.address.startsWith('addr1') ? 'Shelley'
        : d.address.startsWith('Ddz') ? 'Byron/Ddz'
        : d.address.startsWith('Ae2') ? 'Byron/Ae2'
        : 'Unknown';

      const stakeLabel = destInfo?.stakeAddress
        ? `stake:${destInfo.stakeAddress.substring(0, 20)}...`
        : 'no-stake';

      console.log(`    ${(i + 1).toString().padStart(2)}. ${d.totalAda.toLocaleString().padStart(20)} ADA → ${addrType.padEnd(10)} ${d.address.substring(0, 45)}... (${d.txCount} txs) [${stakeLabel}]`);
    }

    console.log(`\n  Total traced (top 15): ${totalTraced.toLocaleString()} ADA`);
    console.log(`  Remaining in other addresses: ${(primaryDest.ada - totalTraced).toLocaleString()} ADA`);
  }
}

main().catch(console.error);

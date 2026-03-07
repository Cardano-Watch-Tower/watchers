require('dotenv').config();
const path = require('path');
const { parseGenesisFile, printGenesisSummary } = require('./src/genesis-parser');
const { traceAllEntities, findIohkAddress, getTxUtxos } = require('./src/tracer');
const { analyzeGovernance } = require('./src/governance');
const { classifyDestinations } = require('./src/cex-detector');
const { generateReport } = require('./src/report');
const { GENESIS_TX, FOUNDING_ENTITIES } = require('./src/known-addresses');

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   CARDANO GENESIS FUND TRACER v0.1.0        ║');
  console.log('║   Tracing founding entity fund flows        ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Phase 1: Parse genesis file
  const genesisPath = path.join(__dirname, 'mainnet-byron-genesis.json');
  let genesisData = null;
  try {
    genesisData = parseGenesisFile(genesisPath);
    printGenesisSummary(genesisData);
  } catch (err) {
    console.log('\n[!] Genesis file not found or invalid, skipping genesis analysis');
  }

  // Phase 2: Trace founding entities
  console.log('\n\n=== PHASE 2: TRACING FOUNDING ENTITY ADDRESSES ===');
  const traceResults = await traceAllEntities();

  // Phase 3: Governance analysis
  console.log('\n\n=== PHASE 3: GOVERNANCE PARTICIPATION ===');
  const governanceResults = await analyzeGovernance(traceResults);

  // Phase 4: CEX detection on top destinations
  console.log('\n\n=== PHASE 4: EXCHANGE DETECTION ===');
  const cexResults = {};
  for (const [key, trace] of Object.entries(traceResults)) {
    if (trace?.firstHopDestinations?.length > 0) {
      cexResults[key] = await classifyDestinations(
        trace.firstHopDestinations.slice(0, 20)
      );
    }
  }

  // Phase 5: Generate report
  console.log('\n\n=== PHASE 5: GENERATING REPORT ===');
  const report = generateReport(traceResults, governanceResults, cexResults, genesisData);

  console.log('\n\nDone! Check the output/ directory for the full report.');
}

// Quick mode: just look up specific addresses without full trace
async function quickLookup() {
  console.log('=== QUICK LOOKUP MODE ===\n');

  // First, check the genesis TX to find all founding addresses
  console.log('Looking up genesis distribution transaction...');
  const utxos = await getTxUtxos(GENESIS_TX);

  if (utxos) {
    console.log(`\nGenesis TX: ${GENESIS_TX}`);
    console.log(`Inputs: ${utxos.inputs.length}`);
    console.log(`Outputs: ${utxos.outputs.length}\n`);

    for (const out of utxos.outputs) {
      const lovelace = out.amount.find(a => a.unit === 'lovelace');
      const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
      console.log(`  ${ada.toLocaleString().padStart(20)} ADA → ${out.address}`);
    }
  } else {
    console.log('Genesis TX not found, trying known addresses directly...');
  }

  // Quick check known addresses
  const { getAddressBalance, getAddressInfo } = require('./src/tracer');

  for (const [key, entity] of Object.entries(FOUNDING_ENTITIES)) {
    for (const addr of entity.byronAddresses) {
      console.log(`\n--- ${entity.name} ---`);
      console.log(`Address: ${addr}`);
      const balance = await getAddressBalance(addr);
      const info = await getAddressInfo(addr);
      console.log(`Balance: ${balance.ada.toLocaleString()} ADA`);
      console.log(`Type: ${info?.type || 'unknown'}`);
      console.log(`Stake: ${info?.stakeAddress || 'none'}`);
    }
  }
}

// Run based on command line arg
const mode = process.argv[2] || 'quick';
if (mode === 'full') {
  main().catch(console.error);
} else {
  quickLookup().catch(console.error);
}

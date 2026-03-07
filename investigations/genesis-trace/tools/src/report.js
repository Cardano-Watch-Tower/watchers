const fs = require('fs');
const path = require('path');
const { GENESIS_STATS } = require('./known-addresses');

function generateReport(traceResults, governanceResults, cexResults, genesisData) {
  const timestamp = new Date().toISOString();
  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const report = {
    meta: {
      generatedAt: timestamp,
      tool: 'Cardano Genesis Fund Tracer',
      version: '0.1.0',
      genesisStats: GENESIS_STATS
    },
    genesis: genesisData ? {
      avvmEntries: genesisData.totalEntries,
      avvmTotalAda: genesisData.totalAda,
      topAvvmEntries: genesisData.topEntries.slice(0, 5)
    } : null,
    entities: {},
    summary: {
      totalGenesisDevPool: GENESIS_STATS.devPool,
      tracedEntities: 0,
      totalCurrentBalance: 0,
      totalMovedToExchanges: 0,
      totalInGovernance: 0,
      totalNotInGovernance: 0
    }
  };

  // Build per-entity reports
  for (const [key, trace] of Object.entries(traceResults)) {
    if (!trace || trace.status === 'unknown_address') continue;
    report.summary.tracedEntities++;

    const entityReport = {
      name: trace.entity,
      genesisAllocation: getEntityAllocation(key),
      currentBalance: trace.balance?.ada || 0,
      totalTransactions: trace.transactions || 0,
      topDestinations: (trace.firstHopDestinations || []).slice(0, 20).map(d => ({
        address: d.address,
        ada: d.totalAda,
        txCount: d.txCount,
        governance: d.governance || null,
        cexAnalysis: d.cexAnalysis || null
      }))
    };

    // Add governance summary if available
    if (governanceResults?.[key]) {
      entityReport.governance = governanceResults[key].summary;
    }

    // Add CEX classification if available
    if (cexResults?.[key]) {
      entityReport.cexClassification = {
        toCex: cexResults[key].totalToCex,
        toSelfCustody: cexResults[key].totalToSelfCustody,
        unknown: cexResults[key].totalUnknown
      };
      report.summary.totalMovedToExchanges += cexResults[key].totalToCex;
    }

    if (governanceResults?.[key]?.summary) {
      report.summary.totalInGovernance += governanceResults[key].summary.adaInGovernance;
      report.summary.totalNotInGovernance += governanceResults[key].summary.adaNotInGovernance;
    }

    report.summary.totalCurrentBalance += entityReport.currentBalance;
    report.entities[key] = entityReport;
  }

  // Write JSON report
  const jsonPath = path.join(outputDir, `genesis-trace-${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nJSON report saved: ${jsonPath}`);

  // Print summary
  printSummary(report);

  return report;
}

function getEntityAllocation(key) {
  const map = {
    emurgo: GENESIS_STATS.devPool * 0.4,     // 40%
    cardanoFoundation: GENESIS_STATS.devPool * 0.12, // 12%
    iohk: GENESIS_STATS.devPool * 0.48        // 48%
  };
  return map[key] || 0;
}

function printSummary(report) {
  console.log('\n' + '='.repeat(60));
  console.log('  CARDANO GENESIS FUND TRACE — SUMMARY REPORT');
  console.log('='.repeat(60));
  console.log(`  Generated: ${report.meta.generatedAt}`);
  console.log(`  Total Genesis Supply: ${GENESIS_STATS.totalAtLaunch.toLocaleString()} ADA`);
  console.log(`  Dev Pool (IOHK+Emurgo+CF): ${GENESIS_STATS.devPool.toLocaleString()} ADA`);
  console.log('');

  for (const [key, entity] of Object.entries(report.entities)) {
    console.log(`  --- ${entity.name} ---`);
    console.log(`  Genesis Allocation: ${entity.genesisAllocation.toLocaleString()} ADA`);
    console.log(`  Current Balance:    ${entity.currentBalance.toLocaleString()} ADA`);
    console.log(`  Transactions:       ${entity.totalTransactions}`);

    if (entity.governance) {
      console.log(`  Governance Active:  ${entity.governance.governanceRate}`);
      console.log(`  ADA in Governance:  ${entity.governance.adaInGovernance.toLocaleString()}`);
    }

    if (entity.cexClassification) {
      console.log(`  Sent to CEX:        ${entity.cexClassification.toCex.toLocaleString()} ADA`);
      console.log(`  Self-Custody:       ${entity.cexClassification.toSelfCustody.toLocaleString()} ADA`);
    }

    console.log('');
  }

  console.log('  --- TOTALS ---');
  console.log(`  Currently Held:    ${report.summary.totalCurrentBalance.toLocaleString()} ADA`);
  console.log(`  In Governance:     ${report.summary.totalInGovernance.toLocaleString()} ADA`);
  console.log(`  Not in Governance: ${report.summary.totalNotInGovernance.toLocaleString()} ADA`);
  console.log(`  Moved to CEX:      ${report.summary.totalMovedToExchanges.toLocaleString()} ADA`);
  console.log('='.repeat(60));
}

module.exports = { generateReport };

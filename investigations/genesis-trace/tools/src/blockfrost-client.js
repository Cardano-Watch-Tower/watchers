const { BlockFrostAPI } = require('@blockfrost/blockfrost-js');
require('dotenv').config();

const RATE_LIMIT_MS = 105; // ~9.5 req/s, safe under 10/s limit
let lastCall = 0;

function createClient() {
  return new BlockFrostAPI({
    projectId: process.env.BLOCKFROST_PROJECT_ID,
    network: 'mainnet'
  });
}

async function rateLimited(fn) {
  const now = Date.now();
  const wait = RATE_LIMIT_MS - (now - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

// Paginate through all results for an endpoint
async function fetchAll(api, method, ...args) {
  const results = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api[method](...args, { page, count: 100 })
      );
      if (!batch || batch.length === 0) break;
      results.push(...batch);
      if (batch.length < 100) break;
      page++;
      if (page > 50) break; // safety cap
    } catch (err) {
      if (err.status_code === 404) break;
      throw err;
    }
  }
  return results;
}

module.exports = { createClient, rateLimited, fetchAll };

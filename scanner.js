const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS = 60 * 1000;
const alerted = new Set();

async function sendTelegram(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }
    );
    console.log('Alert sent to Telegram');
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

async function getMigratedTokens() {
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=solana',
      { timeout: 10000 }
    );
    const pairs = res.data.pairs || [];
    return pairs.filter(p => {
      if (p.chainId !== 'solana') return false;
      if (!['raydium', 'orca'].includes(p.dexId)) return false;
      const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
      return age >= 2 && age <= 60; // widened from 5-25 to 2-60 mins
    });
  } catch (err) {
    console.error('Fetch error:', err.message);
    return [];
  }
}

function scoreToken(pair) {
  let passed = 0;
  const checks = [];
  const age = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 999;
  const mc = pair.fdv || 0;
  const vol1h = pair.volume?.h1 || 0;
  const vol5m = pair.volume?.m5 || 0;
  const vol24h = pair.volume?.h24 || 0;
  const txBuys = pair.txns?.m5?.buys || 0;
  const txSells = pair.txns?.m5?.sells || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const dipFromPeak = priceChange1h < 0 ? Math.abs(priceChange1h) : 0;
  const vmcRatio = mc > 0 ? vol1h / mc : 0;
  const volRatio = txSells > 0 ? txBuys / txSells : 99;

  const add = (label, pass, value) => {
    if (pass) passed++;
    checks.push(`${pass ? '✅' : '❌'} ${label}: ${value}`);
  };

  // Loosened filters
  add('Age 2-60min', age >= 2 && age <= 60, `${age.toFixed(1)}m`);
  add('Dip 20%+', dipFromPeak >= 20, `${dipFromPeak.toFixed(1)}%`);
  add('Buys happening', txBuys >= 1, `${txBuys} buys`);
  add('More buys than sells', volRatio >= 0.8, `ratio ${volRatio.toFixed(2)}`);
  add('MC $10K-$100K', mc >= 10000 && mc <= 100000, `$${mc.toLocaleString()}`);
  add('V/MC ratio ok', vmcRatio >= 0.2 && vmcRatio < 10, `${vmcRatio.toFixed(2)}x`);
  add('Liquidity $10K+', liquidity >= 10000, `$${liquidity.toLocaleString()}`);
  add('Fee activity real', vol5m > 0, `5m vol $${vol5m.toLocaleString()}`);
  add('Not pumped 50%+', priceChange1h < 50, `${priceChange1h.toFixed(1)}%`);
  add('V/MC(24h) <10x', mc > 0 && (vol24h / mc) < 10, `${(vol24h / mc).toFixed(2)}x`);

  return { passed, checks, mc, age, vol24h, liquidity, dipFromPeak };
}

async function scan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }
  const tokens = await getMigratedTokens();
  console.log(`Found ${tokens.length} tokens in age window`);

  const candidates = tokens
    .map(p => ({ pair: p, ...scoreToken(p) }))
    .filter(t => t.passed >= 6 && !alerted.has(t.pair.baseToken?.address))
    .sort((a, b) => b.passed - a.passed)
    .slice(0, 3); // max 3 alerts per scan

  for (const { pair, passed, checks, mc, age, vol24h, liquidity, dipFromPeak } of candidates) {
    const ca = pair.baseToken?.address;
    const symbol = pair.baseToken?.symbol || '?';
    const name = pair.baseToken?.name || 'Unknown';

    // Score label
    let label = '🟡 WATCH';
    if (passed >= 9) label = '🟢 STRONG BUY CANDIDATE';
    else if (passed >= 7) label = '🟢 BUY CANDIDATE';
    else if (passed >= 6) label = '🟡 WATCH';

    const msg =
`${label}
<b>${symbol} (${name})</b>
Score: ${passed}/10

📊 MC: $${mc.toLocaleString()} | Age: ${age.toFixed(1)}m
Dip: ${dipFromPeak.toFixed(1)}% | Vol 24h: $${vol24h.toLocaleString()}
Liquidity: $${liquidity.toLocaleString()}

📋 <b>CHECKLIST:</b>
${checks.join('\n')}

⚠️ <b>CHECK ON AXIOM BEFORE BUYING:</b>
• Bundles &lt;20% on Bubble Maps
• Dev Tokens = 1-3
• RSI &lt;30 on 1s chart
• Score 6-7 = WATCH only
• Score 8+ = consider entry

🔗 <a href="${pair.url}">DexScreener</a>
CA: <code>${ca}</code>`;

    await sendTelegram(msg);
    alerted.add(ca);
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!candidates.length) console.log('No candidates this scan.');
}

async function main() {
  console.log('🚀 Pulse Scanner starting...');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }
  await sendTelegram('🟢 <b>Pulse Scanner v2 started!</b>\nNow alerting on scores 6+ (was 8+)\nScanning every 60 seconds...');
  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

main();

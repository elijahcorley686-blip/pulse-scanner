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
      return age >= 5 && age <= 25;
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

  const add = (label, pass, value) => { if (pass) passed++; checks.push(`${pass ? '✅' : '❌'} ${label}: ${value}`); };

  add('Age 5-25min', age >= 5 && age <= 25, `${age.toFixed(1)}m`);
  add('Dip 40-65%', dipFromPeak >= 40 && dipFromPeak <= 65, `${dipFromPeak.toFixed(1)}%`);
  add('Buys happening', txBuys >= 3, `${txBuys} buys`);
  add('Net vol positive', volRatio >= 1.0, `ratio ${volRatio.toFixed(2)}`);
  add('MC $25K-$60K', mc >= 25000 && mc <= 60000, `$${mc.toLocaleString()}`);
  add('V/MC 0.5-8x', vmcRatio >= 0.5 && vmcRatio < 8, `${vmcRatio.toFixed(2)}x`);
  add('Liquidity $20K+', liquidity >= 20000, `$${liquidity.toLocaleString()}`);
  add('Fee activity real', vol5m > 0 && (vol5m / mc) > 0.0005, `5m vol $${vol5m.toLocaleString()}`);
  add('Not pumped 30%+', priceChange1h < 30, `${priceChange1h.toFixed(1)}%`);
  add('V/MC(24h) <8x', mc > 0 && (vol24h / mc) < 8, `${(vol24h/mc).toFixed(2)}x`);

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
    .filter(t => t.passed >= 8 && !alerted.has(t.pair.baseToken?.address))
    .sort((a, b) => b.passed - a.passed);

  for (const { pair, passed, checks, mc, age, vol24h, liquidity, dipFromPeak } of candidates) {
    const ca = pair.baseToken?.address;
    const symbol = pair.baseToken?.symbol || '?';
    const name = pair.baseToken?.name || 'Unknown';
    const msg = `🚨 <b>PULSE ALERT — ${symbol} (${name})</b>\nPassed ${passed}/10 auto-checks\n\n📊 MC: $${mc.toLocaleString()} | Age: ${age.toFixed(1)}m | Dip: ${dipFromPeak.toFixed(1)}%\nVol 24h: $${vol24h.toLocaleString()} | Liq: $${liquidity.toLocaleString()}\n\n📋 <b>CHECKLIST:</b>\n${checks.join('\n')}\n\n⚠️ <b>MANUAL CHECKS ON AXIOM:</b>\n• Bundles &lt;20% on Bubble Maps\n• Dev Tokens = 1-3\n• RSI &lt;30 on 1s chart\n\n🔗 <a href="${pair.url}">DexScreener</a>\nCA: <code>${ca}</code>`;
    await sendTelegram(msg);
    alerted.add(ca);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!candidates.length) console.log('No candidates this scan.');
}

async function main() {
  console.log('🚀 Pulse Scanner starting...');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }
  await sendTelegram('🟢 <b>Pulse Scanner started!</b>\nScanning every 60 seconds...');
  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

main();

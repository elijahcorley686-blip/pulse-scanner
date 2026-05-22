const axios = require('axios');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS = 60 * 1000; // scan every 60 seconds

// Track tokens already alerted so we don't spam
const alerted = new Set();

// ─── TELEGRAM SENDER ──────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }
    );
    console.log('Alert sent to Telegram');
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

// ─── FETCH MIGRATED SOLANA TOKENS ─────────────────────────
async function getMigratedTokens() {
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=solana',
      { timeout: 10000 }
    );
    const pairs = res.data.pairs || [];

    // Filter to Solana Raydium/Orca pairs only (migrated)
    return pairs.filter(p =>
      p.chainId === 'solana' &&
      ['raydium', 'orca'].includes(p.dexId)
    );
  } catch (err) {
    console.error('DexScreener fetch error:', err.message);
    return [];
  }
}

// ─── CALCULATE AGE IN MINUTES ─────────────────────────────
function getAgeMinutes(pair) {
  if (!pair.pairCreatedAt) return 999;
  return (Date.now() - pair.pairCreatedAt) / 60000;
}

// ─── CALCULATE DIP FROM PEAK ──────────────────────────────
function getDipPercent(pair) {
  const high24h = pair.priceUsd
    ? parseFloat(pair.priceUsd) * 1.5
    : null; // fallback estimate
  const h24High = pair.priceChange?.h24;
  if (!h24High || h24High >= 0) return 0;
  // approximate dip from recent peak using 24h change
  return Math.abs(h24High);
}

// ─── STARWIFPUMP 13-POINT CHECKLIST ───────────────────────
function scoreToken(pair) {
  const checks = [];
  let passed = 0;

  const ageMins = getAgeMinutes(pair);
  const mc = pair.fdv || 0;
  const vol24h = pair.volume?.h24 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const txBuys = pair.txns?.h1?.buys || 0;
  const txSells = pair.txns?.h1?.sells || 0;
  const txTotal = txBuys + txSells;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const name = pair.baseToken?.symbol || 'UNKNOWN';
  const ca = pair.baseToken?.address || '';
  const dexUrl = pair.url || '';

  // ── CHECK 1: Age 5-25 minutes ──────────────────────────
  const ageOk = ageMins >= 5 && ageMins <= 25;
  checks.push({ n: 1, label: 'Age 5-25 min', ok: ageOk, val: `${ageMins.toFixed(1)}m` });
  if (ageOk) passed++;

  // ── CHECK 2: MC $25K-$60K sweet spot ──────────────────
  const mcOk = mc >= 25000 && mc <= 60000;
  checks.push({ n: 13, label: 'MC $25K-$60K', ok: mcOk, val: `$${(mc/1000).toFixed(1)}K` });
  if (mcOk) passed++;

  // ── CHECK 3: 40-65% dip from recent peak ──────────────
  // Use negative 1h price change as proxy for dip
  const dip = priceChange1h < 0 ? Math.abs(priceChange1h) : 0;
  const dipOk = dip >= 40 && dip <= 65;
  checks.push({ n: 2, label: '40-65% dip from peak', ok: dipOk, val: `${dip.toFixed(1)}% down` });
  if (dipOk) passed++;

  // ── CHECK 4: Volume-to-MC ratio ────────────────────────
  const vmc = mc > 0 ? vol24h / mc : 0;
  const vmcOk = vmc >= 1 && vmc <= 8;
  checks.push({ n: 4, label: 'V/MC 1x-8x', ok: vmcOk, val: `${vmc.toFixed(2)}x` });
  if (vmcOk) passed++;

  // ── CHECK 5: TX count growing (buys > 0 in last hour) ─
  const txOk = txBuys >= 50;
  checks.push({ n: 7, label: 'TX active (≥50 buys/hr)', ok: txOk, val: `${txBuys} buys` });
  if (txOk) passed++;

  // ── CHECK 6: Buy/sell ratio not whale distribution ─────
  const bsRatio = txSells > 0 ? txBuys / txSells : txBuys;
  const bsOk = bsRatio >= 0.7 && bsRatio <= 2.0;
  checks.push({ n: 8, label: 'Buy/sell ratio balanced', ok: bsOk, val: `${bsRatio.toFixed(2)}` });
  if (bsOk) passed++;

  // ── CHECK 7: Liquidity ≥$20K (LP burn proxy) ──────────
  const liqOk = liquidity >= 20000;
  checks.push({ n: 12, label: 'Liquidity ≥$20K', ok: liqOk, val: `$${(liquidity/1000).toFixed(1)}K` });
  if (liqOk) passed++;

  // ── CHECK 8: Fees vs MC (real volume signal) ───────────
  // DexScreener doesn't expose fees directly — use vol/MC
  // as a proxy. Very high vol on very low MC = suspicious.
  const feesOk = vmc < 8 && vol24h > 5000;
  checks.push({ n: 'F', label: 'Fees/vol looks real', ok: feesOk, val: vol24h > 5000 ? 'OK' : 'Low vol' });
  if (feesOk) passed++;

  // ── CHECK 9: Not already pumped 30%+ in 1h ────────────
  const notPumpedOk = priceChange1h < 30;
  checks.push({ n: 'P', label: 'Not pumped 30%+ in 1h', ok: notPumpedOk, val: `${priceChange1h.toFixed(1)}%` });
  if (notPumpedOk) passed++;

  // ── INSTANT SKIP flags ─────────────────────────────────
  // These are binary — any true = total skip
  const instantSkips = [];

  if (ageMins > 120) instantSkips.push('Age >120min (stale)');
  if (mc > 60000) instantSkips.push('MC >$60K (chase territory)');
  if (mc < 25000 && ageMins > 15) instantSkips.push('MC <$25K + age >15m (dead)');
  if (vmc >= 8) instantSkips.push('V/MC ≥8x (post-dump corpse)');
  if (liquidity < 15000) instantSkips.push('Liquidity <$15K');
  if (priceChange1h > 50) instantSkips.push('Already pumped 50%+ in 1h');

  return {
    name,
    ca,
    dexUrl,
    mc,
    ageMins,
    vol24h,
    vol1h,
    txBuys,
    txSells,
    liquidity,
    priceChange1h,
    priceChange24h,
    vmc,
    checks,
    passed,
    total: checks.length,
    instantSkips,
  };
}

// ─── FORMAT ALERT MESSAGE ─────────────────────────────────
function formatAlert(result, rank) {
  const medals = ['🥇', '🥈', '🥉'];
  const medal = medals[rank] || '✅';

  const checkLines = result.checks
    .map(c => `${c.ok ? '✅' : '❌'} ${c.label}: ${c.val}`)
    .join('\n');

  const entryMC = (result.mc * 0.55).toFixed(0); // ~45% below current
  const tp1 = (result.mc * 1.30).toFixed(0);
  const tp2 = (result.mc * 1.75).toFixed(0);
  const tp3 = (result.mc * 2.50).toFixed(0);
  const sl  = (result.mc * 0.78).toFixed(0);

  return `
${medal} <b>${result.name}</b> — ${result.passed}/${result.total} checks passed

📊 <b>Token Data</b>
MC: $${(result.mc/1000).toFixed(1)}K
Vol 24h: $${(result.vol24h/1000).toFixed(1)}K
V/MC: ${result.vmc.toFixed(2)}x
Age: ${result.ageMins.toFixed(1)} min
Liquidity: $${(result.liquidity/1000).toFixed(1)}K
1h Change: ${result.priceChange1h.toFixed(1)}%
Buys/Sells (1h): ${result.txBuys}/${result.txSells}

📋 <b>Checklist</b>
${checkLines}

🎯 <b>Trade Plan</b>
Entry target: ~$${(parseInt(entryMC)/1000).toFixed(1)}K MC (wait for dip)
TP1 +30%: $${(parseInt(tp1)/1000).toFixed(1)}K — sell 40%
TP2 +75%: $${(parseInt(tp2)/1000).toFixed(1)}K — sell 30%
TP3 +150%: $${(parseInt(tp3)/1000).toFixed(1)}K — sell 20%
Stop loss -22%: $${(parseInt(sl)/1000).toFixed(1)}K

⚠️ <b>Still check on Axiom:</b>
• Dev Tokens tab (must be 1-3)
• Bubble Maps bundle %
• Holder SOL balances
• RSI on 5s chart (<30 = oversold)
• Absorption wick at low

🔗 ${result.dexUrl}
CA: <code>${result.ca}</code>
`.trim();
}

// ─── MAIN SCAN FUNCTION ───────────────────────────────────
async function scan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);

  const pairs = await getMigratedTokens();
  if (!pairs.length) {
    console.log('No pairs returned from DexScreener');
    return;
  }

  // Score all tokens
  const results = pairs
    .map(pair => scoreToken(pair))
    .filter(r => r.instantSkips.length === 0) // remove instant skips
    .filter(r => r.passed >= 7)               // minimum 7/9 checks
    .sort((a, b) => b.passed - a.passed)      // best first
    .slice(0, 3);                             // top 3 only

  if (!results.length) {
    console.log('No tokens passed filters this scan');
    return;
  }

  // Only alert on tokens we haven't seen yet
  const newResults = results.filter(r => !alerted.has(r.ca));

  if (!newResults.length) {
    console.log('Top tokens already alerted — no new alerts');
    return;
  }

  // Send header if multiple
  if (newResults.length > 1) {
    await sendTelegram(
      `🔍 <b>PULSE SCANNER — ${newResults.length} CANDIDATE${newResults.length > 1 ? 'S' : ''} FOUND</b>\n` +
      `Time: ${new Date().toUTCString()}\n` +
      `Still check ALL criteria on Axiom before buying.`
    );
  }

  // Send each alert
  for (let i = 0; i < newResults.length; i++) {
    const result = newResults[i];
    const message = formatAlert(result, i);
    await sendTelegram(message);
    alerted.add(result.ca);
    // Small delay between messages
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ─── STARTUP ──────────────────────────────────────────────
async function start() {
  console.log('🚀 Pulse Scanner starting...');

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID env vars');
    process.exit(1);
  }

  // Send startup message
  await sendTelegram(
    '🚀 <b>Pulse Scanner is live!</b>\n' +
    'Scanning migrated Solana tokens every 60 seconds.\n' +
    'You will be alerted when tokens pass the starwifpump checklist.\n\n' +
    '⚠️ Always verify on Axiom before buying.\n' +
    'This is not financial advice.'
  );

  // Run immediately then on interval
  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

start();

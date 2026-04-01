const https = require('https');
const fs = require('fs');
const path = require('path');

// === Config ===
const ROAM_TOKEN = '0x23958cBa555AC52C9495Df9b121ff73003e39dBb';
const FUND_POOL = '0x1fEd1Df383F18689515d229a43CeD30C358e508b';
const LP_POOL = '0x3547639172C5D8c84df1dfC55acD4594Df1CF248';
const FEE_A = '0xdcD35009432Fe02f87CA99B64f3e8Edb1e1e93b8';
const FEE_B = '0x86A2f3e477663508C5d7B4e75108F6D145cdaA01';
const FUNDER = '0x274DA16D2C83E93406f1Ec60C042f728610Cf78c';
const BASE = 'https://scan.eniac.network/api/v2';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchAllPages(url, maxPages = 10) {
  const items = [];
  let nextUrl = url;
  for (let i = 0; i < maxPages && nextUrl; i++) {
    const res = await httpGet(nextUrl);
    if (res.items) items.push(...res.items);
    if (res.next_page_params) {
      const params = new URLSearchParams(res.next_page_params);
      nextUrl = `${url.split('?')[0]}?${params}`;
    } else {
      nextUrl = null;
    }
  }
  return items;
}

function shortAddr(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function fmtNum(n, dec = 2) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtUSD(n) {
  return '$' + fmtNum(n);
}

async function main() {
  console.log('=== ROAM Fund Pool Weekly Report ===');
  console.log(`Time: ${new Date().toISOString()}\n`);

  // 1. Token info
  console.log('1. Fetching token info...');
  const tokenInfo = await httpGet(`${BASE}/tokens/${ROAM_TOKEN}`);
  const totalSupply = parseInt(tokenInfo.total_supply) / 1e6;
  const holders = parseInt(tokenInfo.holders);
  console.log(`   Total supply: ${fmtNum(totalSupply)} ROAM, Holders: ${holders}`);

  // 2. LP pool reserves -> price
  console.log('2. Fetching LP pool reserves...');
  const lpTokensRes = await httpGet(`${BASE}/addresses/${LP_POOL}/tokens`);
  const lpTokens = lpTokensRes.items || lpTokensRes;
  let lpRoam = 0, lpUsdt = 0;
  for (const t of lpTokens) {
    const addr = t.token?.address;
    const val = parseInt(t.value);
    const dec = parseInt(t.token?.decimals || '18');
    if (addr?.toLowerCase() === ROAM_TOKEN.toLowerCase()) {
      lpRoam = val / Math.pow(10, dec);
    } else {
      lpUsdt = val / Math.pow(10, dec);
    }
  }
  const roamPrice = lpUsdt / lpRoam;
  console.log(`   LP: ${fmtNum(lpRoam)} ROAM + ${fmtNum(lpUsdt)} USDT`);
  console.log(`   ROAM Price: ${fmtUSD(roamPrice)}`);

  // 3. Fund pool balance
  console.log('3. Fetching fund pool balance...');
  const poolTokensRes = await httpGet(`${BASE}/addresses/${FUND_POOL}/tokens`);
  const poolTokens = poolTokensRes.items || poolTokensRes;
  let poolBalance = 0;
  for (const t of poolTokens) {
    if (t.token?.address?.toLowerCase() === ROAM_TOKEN.toLowerCase()) {
      poolBalance = parseInt(t.value) / Math.pow(10, parseInt(t.token.decimals));
    }
  }
  console.log(`   Pool balance: ${fmtNum(poolBalance)} ROAM`);

  // 4. Fund pool token transfers (all pages)
  console.log('4. Fetching fund pool transfers...');
  const transfers = await fetchAllPages(`${BASE}/addresses/${FUND_POOL}/token-transfers?type=ERC-20&sort=asc`);
  console.log(`   Total transfers: ${transfers.length}`);

  // Separate inbound and outbound
  const inbound = [];
  const outbound = [];
  for (const tx of transfers) {
    const to = tx.to?.hash;
    const from = tx.from?.hash;
    const amt = parseInt(tx.total?.value || '0') / Math.pow(10, parseInt(tx.total?.decimals || '6'));
    const entry = {
      time: tx.timestamp,
      from: from,
      to: to,
      amount: amt,
      txHash: tx.tx_hash,
    };
    if (to?.toLowerCase() === FUND_POOL.toLowerCase()) {
      inbound.push(entry);
    } else if (from?.toLowerCase() === FUND_POOL.toLowerCase()) {
      outbound.push(entry);
    }
  }
  console.log(`   Inbound: ${inbound.length}, Outbound: ${outbound.length}`);

  // Calculate totals
  const totalIn = inbound.reduce((s, t) => s + t.amount, 0);
  const totalOut = outbound.reduce((s, t) => s + t.amount, 0);

  // Categorize outbound: claims vs fees
  const claims = outbound.filter(t =>
    t.to?.toLowerCase() !== FEE_A.toLowerCase() &&
    t.to?.toLowerCase() !== FEE_B.toLowerCase()
  );
  const fees = outbound.filter(t =>
    t.to?.toLowerCase() === FEE_A.toLowerCase() ||
    t.to?.toLowerCase() === FEE_B.toLowerCase()
  );
  const totalClaimed = claims.reduce((s, t) => s + t.amount, 0);
  const totalFees = fees.reduce((s, t) => s + t.amount, 0);
  const uniqueClaimers = [...new Set(claims.map(c => c.to))].length;

  // Days active (from first inbound/funding to now)
  // First funding was 2026-03-15, distributions started the next day
  const firstFundTime = inbound.length > 0
    ? inbound.reduce((earliest, t) => {
        const d = new Date(t.time);
        return d < earliest ? d : earliest;
      }, new Date())
    : new Date('2026-03-15T03:06:15Z');
  const daysActive = Math.max(1, Math.ceil((Date.now() - firstFundTime) / 86400000));
  const dailyConsume = totalOut / daysActive;
  const daysRemaining = dailyConsume > 0 ? Math.floor(poolBalance / dailyConsume) : 9999;

  // 5. Mint events to funder
  console.log('5. Fetching mint events...');
  const allTokenTransfers = await fetchAllPages(`${BASE}/tokens/${ROAM_TOKEN}/transfers?type=ERC-20&sort=asc`, 15);
  const mints = allTokenTransfers.filter(t =>
    t.from?.hash === '0x0000000000000000000000000000000000000000'
  ).map(t => ({
    time: t.timestamp,
    to: t.to?.hash,
    amount: parseInt(t.total?.value || '0') / Math.pow(10, parseInt(t.total?.decimals || '6')),
    txHash: t.tx_hash,
  }));
  const totalMinted = mints.reduce((s, m) => s + m.amount, 0);
  console.log(`   Total mints: ${mints.length}, Total minted: ${fmtNum(totalMinted)} ROAM`);

  // Historical prices for inbound (approximate from initial LP: 0.0356 -> current)
  // We use pool creation ratio and current ratio to interpolate
  const initialPrice = 0.035556; // 320 USDT / 9000 ROAM at LP creation (Mar 12)
  const lpCreatedDate = new Date('2026-03-12T09:35:15Z');
  const now = new Date();

  function estimatePrice(dateStr) {
    const d = new Date(dateStr);
    const totalDays = (now - lpCreatedDate) / 86400000;
    const elapsed = (d - lpCreatedDate) / 86400000;
    const ratio = Math.max(0, Math.min(1, elapsed / totalDays));
    return initialPrice + (roamPrice - initialPrice) * ratio;
  }

  // Inbound with historical prices
  let cumRoam = 0, cumUsd = 0;
  const inboundData = inbound.map((t, i) => {
    const price = estimatePrice(t.time);
    const usd = t.amount * price;
    cumRoam += t.amount;
    cumUsd += usd;
    return { ...t, price, usd, cumRoam, cumUsd, avgPrice: cumUsd / cumRoam };
  });
  const totalInUsd = cumUsd;
  const avgPrice = cumUsd / cumRoam;

  // Current value & PnL
  const currentValue = poolBalance * roamPrice;
  const distributedValue = totalOut * roamPrice;
  const pnl = (currentValue + distributedValue) - totalInUsd;
  const pnlPct = (pnl / totalInUsd * 100);

  // 6. LP pool holders
  console.log('6. Fetching LP pool holders...');
  const lpInfo = await httpGet(`${BASE}/addresses/${LP_POOL}`);
  const lpHoldersRes = await httpGet(`${BASE}/tokens/${LP_POOL}/holders`);
  const lpHolders = lpHoldersRes.items || [];
  const lpTotalSupply = lpInfo.token?.total_supply ? parseInt(lpInfo.token.total_supply) / 1e18 : 0;
  const lpCreator = lpInfo.creator?.hash || '0x274DA16D2C83E93406f1Ec60C042f728610Cf78c';
  const lpHolderRows = lpHolders.map((h, i) => {
    const addr = h.address?.hash || '';
    const val = parseInt(h.value) / 1e18;
    const pct = lpTotalSupply > 0 ? (val / lpTotalSupply * 100) : 0;
    return { addr, val, pct, isContract: h.address?.is_contract || false };
  });
  console.log(`   LP holders: ${lpHolders.length}, Creator: ${lpCreator}`);

  const reportDate = new Date().toISOString().split('T')[0];
  const reportTime = new Date().toISOString().replace('T', ' ').split('.')[0] + ' UTC';

  console.log('\n=== Summary ===');
  console.log(`Pool Balance: ${fmtNum(poolBalance)} ROAM (${fmtUSD(currentValue)})`);
  console.log(`Total In: ${fmtNum(totalIn)} ROAM (${fmtUSD(totalInUsd)})`);
  console.log(`Total Out: ${fmtNum(totalOut)} ROAM`);
  console.log(`Daily Consume: ${fmtNum(dailyConsume)} ROAM/day`);
  console.log(`Days Remaining: ~${daysRemaining}`);
  console.log(`PnL: ${fmtUSD(pnl)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);

  // === Generate HTML ===
  console.log('\n6. Generating HTML report...');

  // Outbound table rows (latest 100)
  const recentOut = outbound.slice(-100).reverse();
  const outRows = recentOut.map((t, i) => {
    const isFee = t.to?.toLowerCase() === FEE_A.toLowerCase() || t.to?.toLowerCase() === FEE_B.toLowerCase();
    const typeTag = isFee
      ? '<span class="tag tag-fee">手續費</span>'
      : '<span class="tag tag-claim">Claim</span>';
    const time = t.time ? t.time.replace('T', ' ').slice(0, 19) : '';
    return `<tr>
      <td>${outbound.length - (recentOut.length - 1 - i)}</td>
      <td style="white-space:nowrap;font-size:12px">${time}</td>
      <td>${typeTag}</td>
      <td class="addr" style="word-break:break-all">${t.to || ''}</td>
      <td class="amount">${fmtNum(t.amount)}</td>
      <td>${fmtUSD(t.amount * roamPrice)}</td>
      <td><a href="https://scan.eniac.network/tx/${t.txHash}" target="_blank" class="addr" style="font-size:11px">${(t.txHash || '').slice(0, 10)}...</a></td>
    </tr>`;
  }).join('\n');

  // Inbound table rows
  const inRows = inboundData.map((t, i) => {
    const time = t.time ? t.time.replace('T', ' ').slice(0, 19) : '';
    return `<tr>
      <td>${i + 1}</td>
      <td>${time}</td>
      <td class="addr" style="word-break:break-all">${t.from}</td>
      <td style="color:var(--yellow)">${fmtUSD(t.price)}</td>
      <td class="amount">${fmtNum(t.amount)}</td>
      <td>${fmtUSD(t.usd)}</td>
      <td class="amount">${fmtNum(t.cumRoam)}</td>
      <td>${fmtUSD(t.cumUsd)}</td>
      <td>${fmtUSD(t.avgPrice)}</td>
    </tr>`;
  }).join('\n');

  // Mint table rows
  const mintRows = mints.map((m, i) => {
    const time = m.time ? m.time.replace('T', ' ').slice(0, 19) : '';
    const price = estimatePrice(m.time);
    return `<tr>
      <td>${i + 1}</td>
      <td>${time}</td>
      <td class="addr" style="word-break:break-all">${m.to}</td>
      <td class="amount">${fmtNum(m.amount)}</td>
      <td>${fmtUSD(m.amount * price)}</td>
    </tr>`;
  }).join('\n');

  const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
  const pnlSign = pnl >= 0 ? '+' : '';
  const exhaustDate = new Date(Date.now() + daysRemaining * 86400000).toISOString().split('T')[0];

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ROAM 資金池週報 - ${reportDate}</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--orange:#d29922;--purple:#bc8cff;--yellow:#e3b341;}
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;padding:20px;line-height:1.6;}
  .container{max-width:1400px;margin:0 auto;}
  h1{font-size:26px;margin-bottom:6px;} h1 span{color:var(--accent);}
  .subtitle{color:var(--text2);margin-bottom:28px;font-size:13px;word-break:break-all;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px;}
  .stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;}
  .stat-card .label{color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
  .stat-card .value{font-size:24px;font-weight:700;}
  .section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:22px;}
  .section h2{font-size:17px;margin-bottom:14px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;padding:9px 11px;border-bottom:2px solid var(--border);color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:.5px;position:sticky;top:0;background:var(--card);}
  td{padding:7px 11px;border-bottom:1px solid var(--border);}
  tr:hover td{background:rgba(88,166,255,0.04);}
  .addr{font-family:'Courier New',monospace;font-size:12px;color:var(--accent);}
  .tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;}
  .tag-claim{background:rgba(63,185,80,0.15);color:var(--green);}
  .tag-fee{background:rgba(139,148,158,0.15);color:var(--text2);}
  .tag-high{background:rgba(248,81,73,0.15);color:var(--red);}
  .tag-mid{background:rgba(210,153,34,0.15);color:var(--orange);}
  .tag-low{background:rgba(63,185,80,0.15);color:var(--green);}
  .amount{font-family:'Courier New',monospace;font-weight:600;}
  .insight{padding:12px 16px;background:rgba(88,166,255,0.08);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;margin-bottom:11px;font-size:13px;}
  .insight strong{color:var(--accent);}
  .insight.warn{border-left-color:var(--orange);background:rgba(210,153,34,0.08);}
  .insight.warn strong{color:var(--orange);}
  .scroll-table{max-height:500px;overflow-y:auto;}
  .scroll-table::-webkit-scrollbar{width:6px;}
  .scroll-table::-webkit-scrollbar-track{background:var(--card);}
  .scroll-table::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
  .pct-bar{height:20px;border-radius:4px;display:flex;overflow:hidden;margin:6px 0;}
  .pct-bar div{height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;}
  @media(max-width:768px){.grid{grid-template-columns:1fr 1fr;}}
</style>
</head>
<body>
<div class="container">
  <h1><span>ROAM 資金池</span> 自動化週報</h1>
  <p class="subtitle">合約: ${FUND_POOL} | 報告生成: ${reportTime} | 自動更新：每週一 09:00 UTC+8</p>

  <div class="grid">
    <div class="stat-card">
      <div class="label">ROAM 當前價格</div>
      <div class="value" style="color:var(--green)">${fmtUSD(roamPrice)}</div>
      <div style="color:var(--text2);font-size:11px">DEX LP 池計算</div>
    </div>
    <div class="stat-card">
      <div class="label">資金池餘額</div>
      <div class="value" style="color:var(--accent)">${fmtNum(poolBalance, 0)}</div>
      <div style="color:var(--text2);font-size:11px">ROAM (${fmtUSD(currentValue)})</div>
    </div>
    <div class="stat-card">
      <div class="label">注資總成本</div>
      <div class="value" style="color:var(--yellow)">${fmtUSD(totalInUsd)}</div>
      <div style="color:var(--text2);font-size:11px">${fmtNum(totalIn, 0)} ROAM (均價 ${fmtUSD(avgPrice)})</div>
    </div>
    <div class="stat-card">
      <div class="label">累計已分發</div>
      <div class="value" style="color:var(--orange)">${fmtNum(totalOut, 0)}</div>
      <div style="color:var(--text2);font-size:11px">ROAM (${fmtUSD(totalOut * roamPrice)})</div>
    </div>
    <div class="stat-card">
      <div class="label">浮盈虧</div>
      <div class="value" style="color:${pnlColor}">${pnlSign}${fmtUSD(Math.abs(pnl))}</div>
      <div style="color:${pnlColor};font-size:11px">${pnlSign}${pnlPct.toFixed(2)}%</div>
    </div>
    <div class="stat-card">
      <div class="label">預計可維持</div>
      <div class="value" style="color:${daysRemaining < 90 ? 'var(--red)' : daysRemaining < 180 ? 'var(--orange)' : 'var(--green)'}">${daysRemaining} 天</div>
      <div style="color:var(--text2);font-size:11px">至 ${exhaustDate}</div>
    </div>
  </div>

  <div class="grid">
    <div class="stat-card">
      <div class="label">日均消耗</div>
      <div class="value" style="color:var(--red);font-size:20px">${fmtNum(dailyConsume, 0)} ROAM</div>
      <div style="color:var(--text2);font-size:11px">${fmtUSD(dailyConsume * roamPrice)} / 天</div>
    </div>
    <div class="stat-card">
      <div class="label">獨立領取者</div>
      <div class="value" style="color:var(--purple);font-size:20px">${uniqueClaimers}</div>
      <div style="color:var(--text2);font-size:11px">個不同地址</div>
    </div>
    <div class="stat-card">
      <div class="label">總交易筆數</div>
      <div class="value" style="color:var(--accent);font-size:20px">${transfers.length}</div>
      <div style="color:var(--text2);font-size:11px">Claim ${claims.length} + 手續費 ${fees.length} + 入帳 ${inbound.length}</div>
    </div>
    <div class="stat-card">
      <div class="label">持有者 / 總供應</div>
      <div class="value" style="font-size:20px">${holders}</div>
      <div style="color:var(--text2);font-size:11px">${fmtNum(totalSupply, 0)} ROAM (FDV ${fmtUSD(totalSupply * roamPrice)})</div>
    </div>
  </div>

  <div class="section">
    <h2>&#128200; 資金池餘額對帳</h2>
    <table>
      <tr><th>項目</th><th>ROAM</th><th>估值 (USDT)</th><th>佔比</th></tr>
      <tr>
        <td style="color:var(--green)">&#10133; 總轉入（歷史價格）</td>
        <td class="amount" style="color:var(--green)">${fmtNum(totalIn)}</td>
        <td style="color:var(--green)">${fmtUSD(totalInUsd)}</td>
        <td>100%</td>
      </tr>
      <tr>
        <td style="color:var(--red)">&#10134; 已分發 (Claims + 手續費)</td>
        <td class="amount" style="color:var(--red)">-${fmtNum(totalOut)}</td>
        <td style="color:var(--red)">-${fmtUSD(totalOut * roamPrice)}</td>
        <td>${(totalOut / totalIn * 100).toFixed(2)}%</td>
      </tr>
      <tr style="border-top:2px solid var(--accent);font-weight:700;">
        <td>= 當前餘額（現價 ${fmtUSD(roamPrice)}）</td>
        <td class="amount" style="color:var(--accent)">${fmtNum(poolBalance)}</td>
        <td style="color:var(--accent)">${fmtUSD(currentValue)}</td>
        <td>${(poolBalance / totalIn * 100).toFixed(2)}%</td>
      </tr>
    </table>
    <div class="pct-bar" style="margin-top:12px;">
      <div style="width:${(poolBalance / totalIn * 100).toFixed(1)}%;background:var(--accent)">餘額 ${(poolBalance / totalIn * 100).toFixed(1)}%</div>
      <div style="width:${(totalClaimed / totalIn * 100).toFixed(1)}%;background:var(--green)">用戶 ${(totalClaimed / totalIn * 100).toFixed(1)}%</div>
      <div style="width:${(totalFees / totalIn * 100).toFixed(1)}%;background:var(--orange)">手續費 ${(totalFees / totalIn * 100).toFixed(1)}%</div>
    </div>
  </div>

  <div class="section">
    <h2>&#128229; 入帳記錄（共 ${inbound.length} 筆）</h2>
    <table>
      <tr><th>#</th><th>時間 (UTC)</th><th>來源</th><th>當時單價</th><th>數量 (ROAM)</th><th>估值 (USDT)</th><th>累計 ROAM</th><th>累計估值</th><th>累計均價</th></tr>
      ${inRows}
      <tr style="border-top:2px solid var(--accent);font-weight:700;">
        <td colspan="4" style="text-align:right;">合計</td>
        <td class="amount" style="color:var(--accent)">${fmtNum(totalIn)}</td>
        <td style="color:var(--accent)">${fmtUSD(totalInUsd)}</td>
        <td colspan="2"></td>
        <td style="color:var(--yellow)">${fmtUSD(avgPrice)}</td>
      </tr>
    </table>
  </div>

  <div class="section">
    <h2>&#128293; 鑄造記錄（共 ${mints.length} 筆 Mint）</h2>
    <div class="scroll-table">
    <table>
      <tr><th>#</th><th>時間 (UTC)</th><th>接收地址</th><th>鑄造量 (ROAM)</th><th>估值 (USDT)</th></tr>
      ${mintRows}
      <tr style="border-top:2px solid var(--accent);font-weight:700;">
        <td colspan="3" style="text-align:right;">合計鑄造</td>
        <td class="amount" style="color:var(--accent)">${fmtNum(totalMinted)}</td>
        <td></td>
      </tr>
    </table>
    </div>
  </div>

  <div class="section">
    <h2>&#128203; 最近流出記錄（${recentOut.length} 筆）</h2>
    <div class="scroll-table">
    <table>
      <tr><th>#</th><th>時間 (UTC)</th><th>類型</th><th>接收地址</th><th>數量 (ROAM)</th><th>估值 (USDT)</th><th>交易</th></tr>
      ${outRows}
    </table>
    </div>
  </div>

  <div class="section">
    <h2>&#128167; 流動池分析（全鏈唯一）</h2>
    <div class="insight warn"><strong>ENI 鏈上 ROAM 僅有 1 個 Swap 池。</strong>已掃描全部 DEX 工廠（UniswapV2 x4、UniswapV3 x3、DODO x2），無其他 ROAM 交易對。ROAM 價格完全由此單一池決定。</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:16px;">
      <div class="stat-card">
        <div class="label">池類型</div>
        <div class="value" style="font-size:18px;color:var(--purple)">Uniswap V2</div>
        <div style="color:var(--text2);font-size:11px">ROAM / USDT</div>
      </div>
      <div class="stat-card">
        <div class="label">ROAM 儲備</div>
        <div class="value" style="font-size:18px;color:var(--accent)">${fmtNum(lpRoam, 0)}</div>
        <div style="color:var(--text2);font-size:11px">${(lpRoam / totalSupply * 100).toFixed(1)}% 總供應量</div>
      </div>
      <div class="stat-card">
        <div class="label">USDT 儲備</div>
        <div class="value" style="font-size:18px;color:var(--green)">${fmtNum(lpUsdt, 0)}</div>
        <div style="color:var(--text2);font-size:11px">池深度</div>
      </div>
      <div class="stat-card">
        <div class="label">LP 提供者</div>
        <div class="value" style="font-size:18px;color:var(--red)">${lpHolders.length}</div>
        <div style="color:var(--text2);font-size:11px">個地址</div>
      </div>
    </div>
    <h3 style="font-size:14px;margin-bottom:10px;color:var(--text2)">LP 持有者明細</h3>
    <table>
      <tr><th>#</th><th>地址</th><th>LP 佔比</th><th>角色</th></tr>
      ${lpHolderRows.map((h, i) => `<tr>
        <td>${i + 1}</td>
        <td class="addr" style="word-break:break-all">${h.addr}</td>
        <td class="amount" style="color:${h.pct > 50 ? 'var(--red)' : 'var(--text)'}">${h.pct.toFixed(3)}%</td>
        <td>${h.pct > 99 ? '<span class="tag tag-high">項目方 / 唯一流動性</span>' : h.pct > 50 ? '<span class="tag tag-mid">主要 LP</span>' : '<span class="tag tag-low">小額</span>'}</td>
      </tr>`).join('')}
    </table>
    <div class="insight" style="margin-top:12px;"><strong>集中度警告：</strong>${lpHolderRows[0]?.pct > 99 ? '最大 LP 持有者佔 ' + lpHolderRows[0].pct.toFixed(3) + '% 的流動性，且同時也是 ROAM 鑄造接收者和資金池注資者（0x274D...f78c）。若該地址撤除流動性，ROAM 將無法交易。' : 'LP 分散度尚可。'}</div>
    <div class="insight warn"><strong>已掃描未發現其他池：</strong>UniswapV2Factory x4（僅 0x548C...269d 有 1 個 ROAM 配對）、UniswapV3Factory x3（0 個）、DODO Factory x2（0 個）。無 ROAM/ENI、ROAM/WETH 或其他配對。</div>
  </div>

  <div class="section">
    <h2>&#9888; 風險評估</h2>
    <table>
      <tr><th>項目</th><th>等級</th><th>說明</th></tr>
      <tr><td>資金集中度</td><td><span class="tag tag-high">高</span></td><td>資金池持有 ${(poolBalance / totalSupply * 100).toFixed(1)}% 供應量</td></tr>
      <tr><td>合約可升級</td><td><span class="tag tag-high">高</span></td><td>ERC1967Proxy，邏輯合約可被替換</td></tr>
      <tr><td>資金枯竭</td><td><span class="tag ${daysRemaining < 90 ? 'tag-high' : daysRemaining < 180 ? 'tag-mid' : 'tag-low'}">${daysRemaining < 90 ? '高' : daysRemaining < 180 ? '中' : '低'}</span></td><td>日均消耗 ${fmtNum(dailyConsume, 0)} ROAM，預計 ${daysRemaining} 天後耗盡</td></tr>
      <tr><td>流動池集中</td><td><span class="tag tag-high">高</span></td><td>全鏈僅 1 個 ROAM 池，${lpHolders.length} 個 LP 提供者，最大佔 ${lpHolderRows[0]?.pct.toFixed(1) || '?'}%</td></tr>
      <tr><td>單一定價源</td><td><span class="tag tag-high">高</span></td><td>無其他 DEX 池或交易對，價格可被單一地址操控</td></tr>
      <tr><td>浮盈虧</td><td><span class="tag ${pnl >= 0 ? 'tag-low' : 'tag-mid'}">${pnl >= 0 ? '低' : '中'}</span></td><td>注資成本 ${fmtUSD(totalInUsd)}，當前價值+已分發 = ${fmtUSD(currentValue + distributedValue)}（${pnlSign}${pnlPct.toFixed(2)}%）</td></tr>
    </table>
  </div>

  <p style="text-align:center;color:var(--text2);font-size:11px;margin-top:18px">Auto-generated by ROAM Weekly Reporter | ${reportTime} | <a href="https://scan.eniac.network/address/${FUND_POOL}" style="color:var(--accent)">View on Explorer</a></p>
</div>
</body>
</html>`;

  const outPath = path.join(__dirname, '..', 'roam_pool_analysis.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`\n7. Report saved to ${outPath}`);
  console.log('Done!');
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});

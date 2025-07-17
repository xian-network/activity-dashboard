/* main.js – Xian Monthly Competition (May 1 → June 1)
   ------------------------------------------------------------------
   Rewards real activity while blocking end‑of‑epoch wash loops.
   Scoring formula  (per wallet):
     points = fixedXNS
            + f( netSwapUSDC )

   where netSwap is the **signed net‑flow** in the xUSDC/XIAN pool
   weighted by how long the value stays on‑chain (0 – 24 h ramp‑up).
   A buy that is reverted within 24 h earns almost zero credit.
   ------------------------------------------------------------------*/

/* ──────────────────────────────────────────────────────────────────
 * 1. Force HTTPS in production
 * ─────────────────────────────────────────────────────────────────*/
if (window.location.protocol === 'http:') {
  window.location.href = window.location.href.replace('http:', 'https:');
}

/* ──────────────────────────────────────────────────────────────────
 * 2. DATE RANGE: fixed May 1 → June 1 of current year (UTC)
 * ─────────────────────────────────────────────────────────────────*/
function getMayJuneRange() {
  const yr = new Date().getUTCFullYear();
  return {
    thisMonthStartISO: new Date(Date.UTC(yr, 4, 1)).toISOString(), // May 1 00:00
    nextMonthStartISO: new Date(Date.UTC(yr, 5, 1)).toISOString()  // Jun 1 00:00
  };
}

function isDoublePointsPeriod(dateStr) {
  // Double points during the first 5 days: May 1 → May 6 00:00 UTC
  const txTime    = new Date(dateStr);
  const doubleEnd = new Date(Date.UTC(txTime.getUTCFullYear(), 4, 6));
  return txTime < doubleEnd;
}

/* ──────────────────────────────────────────────────────────────────
 * 3. SCORING CONSTANTS (only swaps + fixed)
 * ─────────────────────────────────────────────────────────────────*/
const SWAP_POINTS_PER_USDC = 10;  // 1 pt per 10 USDC net
const SWAP_CAP             = 5000; // max 5 000 pts (50 000 USDC net)
const MIN_SWAP_USDC        = 10;   // ignore dust

const FIXED_ACTIONS = {
  'con_name_service_final|mint_name': 5,
};

/* ──────────────────────────────────────────────────────────────────
 * 4. HOLD‑WEIGHT PARAMETERS (anti‑boundary‑snipe)
 * ─────────────────────────────────────────────────────────────────*/
const { thisMonthStartISO, nextMonthStartISO } = getMayJuneRange();
const HOLD_MS     = 24 * 60 * 60 * 1000;                    // 24 h
const CONTEST_END = new Date(nextMonthStartISO).getTime();  // Jun 1 00:00 UTC

function holdWeight(txMillis) {
  return Math.max(0, Math.min(1, (CONTEST_END - txMillis) / HOLD_MS));
}

/* ──────────────────────────────────────────────────────────────────
 * 5. HELPERS
 * ─────────────────────────────────────────────────────────────────*/
function toUsdcFromCurrency(xianAmt) {
  // 1 XIAN ≈ 0.0129 USDC (calibration point)
  return xianAmt * 0.0129;
}

function pointsForSwap(usdc) {
  if (usdc < MIN_SWAP_USDC) return 0;
  return Math.min(Math.floor(usdc / SWAP_POINTS_PER_USDC), SWAP_CAP);
}

function usdcEquivalent(usd0, xian1) {
  return usd0 + toUsdcFromCurrency(xian1);
}

function netUsdDelta(evt) {
  const i0 = parseFloat(evt.data?.amount0In  ?? '0');
  const o0 = parseFloat(evt.data?.amount0Out ?? '0');
  const i1 = parseFloat(evt.data?.amount1In  ?? '0');
  const o1 = parseFloat(evt.data?.amount1Out ?? '0');
  return usdcEquivalent(i0, o1) - usdcEquivalent(o0, i1);
}

/* ──────────────────────────────────────────────────────────────────
 * 6. GRAPHQL QUERY (May 1 → June 1)
 * ─────────────────────────────────────────────────────────────────*/
const query = `
query MonthlyTransactions {
  allTransactions(
    filter: {
      created: { greaterThanOrEqualTo: "${thisMonthStartISO}", lessThan: "${nextMonthStartISO}" }
    }
  ) {
    edges {
      node {
        function
        sender
        success
        contract
        created
        jsonContent
      }
    }
  }
}`;

fetch('https://node.xian.org/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
})
  .then((res) => res.json())
  .then(({ data }) => buildLeaderboard(data.allTransactions.edges))
  .catch(showError);

/* ──────────────────────────────────────────────────────────────────
 * 7. MAIN AGGREGATOR (swaps only)
 * ─────────────────────────────────────────────────────────────────*/
function buildLeaderboard(edges) {
  // wallet → { fixed, netSwapUSD }
  const wallets = {};

  edges.forEach(({ node }) => {
    if (!node.success) return;

    const tsMillis = new Date(node.created).getTime();
    const boost    = isDoublePointsPeriod(node.created) ? 2 : 1;
    const wFactor  = holdWeight(tsMillis);

    // ── fixed actions (XNS mint) ──
    const fixedKey = `${node.contract}|${node.function}`;
    if (FIXED_ACTIONS[fixedKey]) {
      const pts = FIXED_ACTIONS[fixedKey] * boost;
      if (pts) {
        const w = (wallets[node.sender] ||= { fixed: 0, netSwap: 0 });
        w.fixed += pts;
      }
      return;
    }

    // ── swaps (pair 1) ──
    (node.jsonContent?.tx_result?.events || []).forEach((evt) => {
      if (
        evt.contract !== 'con_pairs' ||
        evt.event !== 'Swap' ||
        evt.data_indexed?.pair !== '1'
      )
        return;

      const delta = netUsdDelta(evt) * boost * wFactor; // signed
      if (!delta) return;

      const w = (wallets[evt.signer] ||= { fixed: 0, netSwap: 0 });
      w.netSwap += delta; // can be negative
    });
  });

  // ── convert to points ──
  const totals = Object.entries(wallets).map(([addr, { fixed, netSwap }]) => {
    const swapPts = pointsForSwap(
      Math.min(Math.max(netSwap, 0), SWAP_CAP * SWAP_POINTS_PER_USDC)
    );
    return [addr, fixed + swapPts];
  });

  renderTable(totals.sort((a, b) => b[1] - a[1]));
}

/* ──────────────────────────────────────────────────────────────────
 * 8. RENDERING + ERROR UI
 * ─────────────────────────────────────────────────────────────────*/
function renderTable(sorted) {
  const tbody = document.querySelector('#leaderboard tbody');
  tbody.innerHTML = '';
  sorted.forEach(([addr, pts], idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${idx + 1}</td><td>${addr}</td><td>${pts}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('status').classList.remove('d-flex');
  document.getElementById('status').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
}

function showError(err) {
  console.error(err);
  const status = document.getElementById('status');
  status.className = 'alert alert-danger text-center';
  status.textContent = 'Error loading data. Check console.';
}

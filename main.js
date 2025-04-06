/****************************************************
 * 1) GraphQL Query
 ****************************************************/
const query = `
query Transactions {
  allTransactions {
    edges {
      node {
        function
        sender
        success
        contract
        jsonContent
      }
    }
  }
}
`;

/****************************************************
 * 2) Conversion and Caps
 ****************************************************/
// We'll treat 1 currency = 0.01 USDC
function currencyToUsdc(amount) {
  return amount * 0.01;
}

// Bridging: 1 point / 100 USDC minted, up to 5
const BRIDGE_POINTS_PER = 100;
const BRIDGE_CAP = 5;

// Swap: 1 point / 10 USDC eq, up to 50
const SWAP_RATIO = 10;
const SWAP_CAP = 50;
const MIN_SWAP_USDC = 10; // must swap >= 10 USDC eq

// Final Liquidity: 1 point / 10 USDC eq net, up to 100
const LIQ_RATIO = 10;
const LIQ_CAP   = 100;
const MIN_LIQ_USDC = 10; // must have at least 10 net eq to get points

/****************************************************
 * 3) Fixed-Point Tasks
 ****************************************************/
const FIXED_ACTIONS = {
  'con_pixel_frames|create_thing': 5,   // NFT Mint
  'con_pixel_frames|buy_thing': 3,      // NFT Purchase
  'con_name_service_final|mint_name': 2,// XNS Mint
  'currency|transfer': 1                // Xian Token Transfer
};

/****************************************************
 * 4) "Immediate" Points for Bridging & Fixed
 ****************************************************/
function getTopLevelPoints(node) {
  const { contract, function: funcName, sender, jsonContent } = node;
  let points = 0;
  let awardAddress = sender;

  // 4.1 Bridging: con_usdc.mint
  if (contract === 'con_usdc' && funcName === 'mint') {
    const kwargs = jsonContent?.payload?.kwargs || {};
    const minted = parseFloat(kwargs.amount ?? '0');
    const toAddr = kwargs.to;

    if (minted > 0) {
      // 1 point / 100 USDC minted, capped 5
      const rawPts = Math.floor(minted / BRIDGE_POINTS_PER);
      points = Math.min(rawPts, BRIDGE_CAP);
      awardAddress = toAddr;
    }
    return { points, address: awardAddress };
  }

  // 4.2 Fixed tasks
  const key = `${contract}|${funcName}`;
  if (key in FIXED_ACTIONS) {
    points = FIXED_ACTIONS[key];
    // e.g. Xian Transfer => must be >=1
    if (key === 'currency|transfer') {
      const kwargs = jsonContent?.payload?.kwargs || {};
      const amt = parseFloat(kwargs.amount ?? '0');
      if (amt < 1) points = 0;
    }
    return { points, address: awardAddress };
  }

  return { points: 0, address: sender };
}

/****************************************************
 * 5) We'll track net minted vs burned for liquidity
 ****************************************************/
// user => total minted USDC eq
const mintedVolume = {};
// user => total burned USDC eq
const burnedVolume = {};

/****************************************************
 * 6) MAIN
 ****************************************************/
fetch('https://node.xian.org/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
})
.then(res => res.json())
.then(response => {
  const edges = response.data.allTransactions.edges;
  // scoreboard => immediate points from bridging, swaps, fixed
  const scoreboard = {};

  edges.forEach(({ node }) => {
    if (!node.success) return;

    // 6.1 Immediate bridging/fixed points
    const { points, address } = getTopLevelPoints(node);
    if (points > 0 && address) {
      scoreboard[address] = (scoreboard[address] || 0) + points;
    }

    // 6.2 Parse con_pairs events for Swaps, Mints, Burns
    const events = node.jsonContent?.tx_result?.events || [];
    events.forEach(evt => {
      if (evt.contract !== 'con_pairs') return;

      // We only track pair=1
      const pairId = evt.data_indexed?.pair;
      if (pairId !== "1") return;

      const user = evt.signer;
      if (!user) return;

      // 6.2.1: Check if it's a Swap
      if (evt.event === 'Swap') {
        const data = evt.data || {};
        const amount0In = parseFloat(data.amount0In ?? '0');
        const amount1In = parseFloat(data.amount1In ?? '0');

        let usdcEq = 0;
        // token0=con_usdc
        if (amount0In > 0) usdcEq += amount0In;
        // token1=currency => *0.01
        if (amount1In > 0) usdcEq += currencyToUsdc(amount1In);

        if (usdcEq >= MIN_SWAP_USDC) {
          const rawPts = Math.floor(usdcEq / SWAP_RATIO);
          const swapPts = Math.min(rawPts, SWAP_CAP);
          scoreboard[user] = (scoreboard[user] || 0) + swapPts;
        }
      }
      // 6.2.2: Check if it's a Mint or Burn
      else if (evt.event === 'Mint') {
        // user minted liquidity
        const data = evt.data || {};
        const amount0 = parseFloat(data.amount0 ?? '0');
        const amount1 = parseFloat(data.amount1 ?? '0');

        let usdcEq = 0;
        if (amount0 > 0) usdcEq += amount0;
        if (amount1 > 0) usdcEq += currencyToUsdc(amount1);

        if (!mintedVolume[user]) mintedVolume[user] = 0;
        mintedVolume[user] += usdcEq;
      }
      else if (evt.event === 'Burn') {
        // user removed liquidity
        const data = evt.data || {};
        const amount0 = parseFloat(data.amount0 ?? '0');
        const amount1 = parseFloat(data.amount1 ?? '0');

        let usdcEq = 0;
        if (amount0 > 0) usdcEq += amount0;
        if (amount1 > 0) usdcEq += currencyToUsdc(amount1);

        if (!burnedVolume[user]) burnedVolume[user] = 0;
        burnedVolume[user] += usdcEq;
      }
    });
  });

  /****************************************************
   * 7) Final Step: Compute net liquidity points
   ****************************************************/
  Object.keys(mintedVolume).forEach(user => {
    const minted = mintedVolume[user] || 0;
    const burned = burnedVolume[user] || 0;
    const net = minted - burned; // net USDC eq

    if (net >= MIN_LIQ_USDC) {
      // e.g. 1 point / 10 USDC eq, capped at 100
      const rawPts = Math.floor(net / LIQ_RATIO);
      const finalPts = Math.min(rawPts, LIQ_CAP);

      // add to scoreboard
      scoreboard[user] = (scoreboard[user] || 0) + finalPts;
    }
  });

  // 8) Sort scoreboard
  const sorted = Object.entries(scoreboard).sort((a,b) => b[1] - a[1]);

  // 9) Build table
  const tbody = document.querySelector('#leaderboard tbody');
  sorted.forEach(([addr, pts], i) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${addr}</td>
      <td>${pts}</td>
    `;
    tbody.appendChild(row);
  });

  // Show final
  document.getElementById('status').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
})
.catch(err => {
  console.error(err);
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'alert alert-danger text-center';
  statusDiv.innerText = 'Error loading data. Check console.';
});

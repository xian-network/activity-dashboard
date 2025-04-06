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

// Mint (liquidity): 1 point / 10 USDC eq, up to 100
const MINT_RATIO = 10;
const MINT_CAP = 100;
const MIN_MINT_USDC = 10; // must add >= 10 USDC eq

/****************************************************
 * 3) Fixed-Point Tasks
 ****************************************************/
const FIXED_ACTIONS = {
  'con_pixel_frames|create_thing': 5, // NFT Mint
  'con_pixel_frames|buy_thing': 3,    // NFT Purchase
  'con_name_service_final|mint_name': 2, // XNS Mint
  'currency|transfer': 1              // Xian Token Transfer
};

/****************************************************
 * 4) Determine Points from "Top-Level" Action
 *    - Bridging (con_usdc.mint)
 *    - Or the fixed tasks (NFT, XNS, Transfer)
 ****************************************************/
function getTopLevelPoints(node) {
  const { contract, function: funcName, sender, jsonContent } = node;
  let points = 0;
  let awardAddress = sender; // default

  // 4.1 Bridging: con_usdc.mint
  if (contract === 'con_usdc' && funcName === 'mint') {
    const kwargs = jsonContent?.payload?.kwargs || {};
    const minted = parseFloat(kwargs.amount ?? '0');
    const toAddr = kwargs.to;

    if (minted > 0) {
      // 1 point / 100 USDC minted, capped at 5
      const rawPts = Math.floor(minted / BRIDGE_POINTS_PER);
      points = (rawPts > BRIDGE_CAP) ? BRIDGE_CAP : rawPts;
      awardAddress = toAddr;
    }
    return { points, address: awardAddress };
  }

  // 4.2 Fixed tasks
  const key = `${contract}|${funcName}`;
  if (key in FIXED_ACTIONS) {
    points = FIXED_ACTIONS[key];
    if (points > 0) {
      // For Xian Transfer, must have at least 1 token
      if (key === 'currency|transfer') {
        const kwargs = jsonContent?.payload?.kwargs || {};
        const amount = parseFloat(kwargs.amount ?? '0');
        if (amount < 1) {
          points = 0;
        }
      }
    }
    return { points, address: awardAddress };
  }

  // 4.3 Otherwise, 0
  return { points: 0, address: sender };
}

/****************************************************
 * 5) MAIN FETCH LOGIC
 ****************************************************/
fetch('https://node.xian.org/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
})
.then(res => res.json())
.then(response => {
  const edges = response.data.allTransactions.edges;
  const scoreboard = {}; // { [address]: totalPoints }

  edges.forEach(({ node }) => {
    if (!node.success) return; // skip failed

    // 5.1 Award bridging/fixed tasks from top-level
    const { points, address } = getTopLevelPoints(node);
    if (points > 0 && address) {
      if (!scoreboard[address]) scoreboard[address] = 0;
      scoreboard[address] += points;
    }

    // 5.2 Parse con_pairs events for Swap/Mint volume
    const events = node.jsonContent?.tx_result?.events || [];
    events.forEach(evt => {
      // We only care about con_pairs
      if (evt.contract !== 'con_pairs') return;

      const user = evt.signer; // potentially the user
      if (!user) return;

      // Check event type
      if (evt.event === 'Swap') {
        // data => { amount0In, amount1In, ... }
        const data = evt.data || {};
        const amount0In = parseFloat(data.amount0In ?? '0');
        const amount1In = parseFloat(data.amount1In ?? '0');

        let usdcEq = 0;
        // If user spent currency, convert
        if (amount1In > 0) {
          usdcEq += currencyToUsdc(amount1In);
        }
        // If user spent some token0 (assuming it's USDC), add directly
        if (amount0In > 0) {
          usdcEq += amount0In;
        }

        // Must meet min swap
        if (usdcEq >= MIN_SWAP_USDC) {
          const rawPts = Math.floor(usdcEq / SWAP_RATIO);
          const swapPts = (rawPts > SWAP_CAP) ? SWAP_CAP : rawPts;
          if (!scoreboard[user]) scoreboard[user] = 0;
          scoreboard[user] += swapPts;
        }
      }
      else if (evt.event === 'Mint') {
        // data => { amount0, amount1, to, ... }
        const data = evt.data || {};
        const amount0 = parseFloat(data.amount0 ?? '0');
        const amount1 = parseFloat(data.amount1 ?? '0');

        let usdcEq = 0;
        // assume amount1 is currency
        if (amount1 > 0) {
          usdcEq += currencyToUsdc(amount1);
        }
        // assume amount0 is USDC
        if (amount0 > 0) {
          usdcEq += amount0;
        }

        // Must meet min 10 USDC eq
        if (usdcEq >= MIN_MINT_USDC) {
          const rawPts = Math.floor(usdcEq / MINT_RATIO);
          const mintPts = (rawPts > MINT_CAP) ? MINT_CAP : rawPts;
          if (!scoreboard[user]) scoreboard[user] = 0;
          scoreboard[user] += mintPts;
        }
      }
    });
  });

  // Sort scoreboard descending
  const sorted = Object.entries(scoreboard).sort((a,b) => b[1] - a[1]);

  // Build table
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

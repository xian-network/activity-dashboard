/****************************************************
 * 1) GRAPHQL QUERY
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
 * 2) USDC Conversion, Caps, Ratios
 ****************************************************/
// We'll treat 'currency' as 0.01 USDC each
function toUsdEquivalent(token, amount) {
  if (token === 'con_usdc') return amount;
  if (token === 'currency') return amount * 0.01;
  // for other tokens, we ignore in this example
  return 0;
}

// Bridging
const BRIDGE_RATIO = 10;   // 1 pt per 10 USDC
const BRIDGE_CAP   = 100;  // max bridging pts
// Swapping
const SWAP_RATIO = 10;     // 1 pt per 10 USDC eq
const SWAP_CAP   = 50;     // max swap pts
// Add Liquidity
const LIQ_RATIO = 10;      // 1 pt per 10 USDC eq
const LIQ_CAP   = 100;     // max liq pts

// We'll require at least 10 USDC eq for bridging/swap/liq to avoid trivial amounts
const MIN_USD_VOL = 10;

/****************************************************
 * 3) FIXED-POINT ACTIONS
 ****************************************************/
const FIXED_ACTIONS = {
  // NFT Mint
  'con_pixel_frames|create_thing': 5,
  // NFT Purchase
  'con_pixel_frames|buy_thing': 3,
  // XNS Mint
  'con_name_service_final|mint_name': 2,
  // Xian Token Transfer
  'currency|transfer': 1,
  // Contract Deployment
  'submission|submit_contract': 15
};

/****************************************************
 * 4) HELPER: getPointsAndAddress
 ****************************************************/
const uniqueContractCodes = new Set();

function getPointsAndAddress(node) {
  const { contract, function: funcName, sender, jsonContent } = node;
  const kwargs = jsonContent?.payload?.kwargs || {};

  // Default awarding address = sender
  let awardAddress = sender;
  let points = 0;

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // 4.1 BRIDGING: con_usdc / mint
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  if (contract === 'con_usdc' && funcName === 'mint') {
    awardAddress = kwargs.to; // bridging goes to the minted address
    const minted = parseFloat(kwargs.amount ?? '0');
    if (minted < MIN_USD_VOL) return { points: 0, awardAddress };

    // 1 point per 10 USDC, capped
    const rawPoints = Math.floor(minted / BRIDGE_RATIO);
    points = Math.min(rawPoints, BRIDGE_CAP);
    return { points, awardAddress };
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // 4.2 SWAP: con_dex_v2 / swapExactTokenForTokenSupportingFeeOnTransferTokens
  // only if src is con_usdc or currency
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  if (contract === 'con_dex_v2' && funcName === 'swapExactTokenForTokenSupportingFeeOnTransferTokens') {
    const srcToken = kwargs.src;
    const amountIn = parseFloat(kwargs.amountIn ?? '0');
    if (amountIn <= 0) return { points: 0, awardAddress };

    // convert to USDC eq
    const usdEq = toUsdEquivalent(srcToken, amountIn);
    if (usdEq < MIN_USD_VOL) return { points: 0, awardAddress };

    // 1 point per 10 USDC eq, capped at 50
    const rawPoints = Math.floor(usdEq / SWAP_RATIO);
    points = Math.min(rawPoints, SWAP_CAP);
    return { points, awardAddress };
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // 4.3 ADD LIQUIDITY: con_dex_v2 / addLiquidity
  // only if tokenA,tokenB in {con_usdc, currency}
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  if (contract === 'con_dex_v2' && funcName === 'addLiquidity') {
    const tokenA = kwargs.tokenA;
    const tokenB = kwargs.tokenB;
    const aDesired = parseFloat(kwargs.amountADesired ?? '0');
    const bDesired = parseFloat(kwargs.amountBDesired ?? '0');

    // ensure both tokens are con_usdc or currency
    if (!['con_usdc','currency'].includes(tokenA) ||
        !['con_usdc','currency'].includes(tokenB)) {
      return { points: 0, awardAddress };
    }

    // convert each side to USDC eq
    const usdEqA = toUsdEquivalent(tokenA, aDesired);
    const usdEqB = toUsdEquivalent(tokenB, bDesired);
    const totalUsdEq = usdEqA + usdEqB;
    if (totalUsdEq < MIN_USD_VOL) return { points: 0, awardAddress };

    // 1 point per 10 USDC eq, capped at 100
    const rawPoints = Math.floor(totalUsdEq / LIQ_RATIO);
    points = Math.min(rawPoints, LIQ_CAP);
    return { points, awardAddress };
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // 4.4 FIXED ACTIONS (NFT, XNS, Xian Transfer, etc.)
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  const key = `${contract}|${funcName}`;
  if (key in FIXED_ACTIONS) {
    points = FIXED_ACTIONS[key];

    // synergy checks
    // - Xian Transfer: must be at least 1
    if (key === 'currency|transfer') {
      const amount = parseFloat(kwargs.amount ?? '0');
      if (amount < 1) {
        points = 0;
      }
    }

    // - Unique contract code
    if (key === 'submission|submit_contract') {
      const code = kwargs.code ?? '';
      if (!code || uniqueContractCodes.has(code)) {
        points = 0;
      } else {
        uniqueContractCodes.add(code);
      }
    }

    return { points, awardAddress };
  }

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  // 4.5 Anything else => 0 points
  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  return { points: 0, awardAddress };
}

/****************************************************
 * 5) MAIN: Fetch Data, Build Leaderboard
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
    if (!node.success) return; // skip failed tx

    const { points, awardAddress } = getPointsAndAddress(node);
    if (points > 0 && awardAddress) {
      if (!scoreboard[awardAddress]) {
        scoreboard[awardAddress] = 0;
      }
      scoreboard[awardAddress] += points;
    }
  });

  // Sort by descending points
  const sorted = Object.entries(scoreboard).sort((a,b) => b[1] - a[1]);

  // Build HTML table
  const tbody = document.querySelector('#leaderboard tbody');
  sorted.forEach(([address, pts], index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${address}</td>
      <td>${pts}</td>
    `;
    tbody.appendChild(row);
  });

  // Show the results, hide "Loading..."
  document.getElementById('status').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
})
.catch(err => {
  console.error(err);
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'alert alert-danger text-center';
  statusDiv.innerText = 'Error loading data. Check console.';
});

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
 * 2) Volume-Based & Fixed Points
 ****************************************************/
// For bridging & swapping, we apply a volume-based formula:
//   bridging => 1 pt / 10 USDC, capped at 100
//   swapping => 1 pt / 10 tokens swapped, capped at 50
// For other actions, we keep a fixed point system:
const FIXED_ACTIONS = {
  'con_dex_v2|addLiquidity': 10,
  'con_pixel_frames|create_thing': 5,
  'con_pixel_frames|buy_thing': 3,
  'con_name_service_final|mint_name': 2,
  'currency|transfer': 1,
  'submission|submit_contract': 15
};

// Volume-based constants
const SWAP_RATIO   = 10; // 1 point per 10 tokens swapped
const SWAP_CAP     = 50; // max 50 points per swap
const BRIDGE_RATIO = 10; // 1 point per 10 USDC minted
const BRIDGE_CAP   = 100; // max 100 points per bridging tx

/****************************************************
 * 3) Sybil Thresholds & Unique Contract Check
 ****************************************************/
const MIN_SWAP_AMOUNT     = 10;   // must swap >=10 tokens to earn points
const MIN_TRANSFER_AMOUNT = 1;    // must transfer >=1 token
const MIN_LIQUIDITY_A     = 5;    // must add >=5 tokens for addLiquidity
const MIN_LIQUIDITY_B     = 100;  // must add >=100 tokens for addLiquidity
const MIN_BRIDGE_AMOUNT   = 10;   // must mint >=10 USDC for bridging

// Unique code check
const uniqueContractCodes = new Set();

/****************************************************
 * 4) Helper: Decide how many points + which address
 ****************************************************/
function getPointsAndAddress(node) {
  const { contract, function: funcName, sender, jsonContent } = node;
  const kwargs = jsonContent?.payload?.kwargs || {};

  // Default awarding address is the sender
  let awardAddress = sender;
  let points = 0;

  // 4.1 - TRADING (Swap) volume-based
  if (contract === 'con_dex_v2' && funcName === 'swapExactTokenForTokenSupportingFeeOnTransferTokens') {
    const amountIn = parseFloat(kwargs.amountIn ?? '0');
    // Must meet threshold
    if (amountIn >= MIN_SWAP_AMOUNT) {
      // 1 point per SWAP_RATIO tokens, capped
      const rawPoints = Math.floor(amountIn / SWAP_RATIO);
      points = Math.min(rawPoints, SWAP_CAP);
    }
    return { points, awardAddress };
  }

  // 4.2 - BRIDGING (con_usdc / mint) volume-based
  if (contract === 'con_usdc' && funcName === 'mint') {
    // For bridging, the to-address is the rightful owner of points
    awardAddress = kwargs.to;
    const mintedAmt = parseFloat(kwargs.amount ?? '0');
    if (mintedAmt >= MIN_BRIDGE_AMOUNT) {
      const rawPoints = Math.floor(mintedAmt / BRIDGE_RATIO);
      points = Math.min(rawPoints, BRIDGE_CAP);
    }
    return { points, awardAddress };
  }

  // 4.3 - FIXED ACTIONS
  const actionKey = `${contract}|${funcName}`;
  if (actionKey in FIXED_ACTIONS) {
    points = FIXED_ACTIONS[actionKey];

    // Additional checks for thresholds
    if (actionKey === 'con_dex_v2|addLiquidity') {
      // Must add at least MIN_LIQUIDITY_A + MIN_LIQUIDITY_B
      const aDesired = parseFloat(kwargs.amountADesired ?? '0');
      const bDesired = parseFloat(kwargs.amountBDesired ?? '0');
      if (aDesired < MIN_LIQUIDITY_A || bDesired < MIN_LIQUIDITY_B) {
        points = 0;
      }
    }

    if (actionKey === 'currency|transfer') {
      // Must transfer >= MIN_TRANSFER_AMOUNT
      const amount = parseFloat(kwargs.amount ?? '0');
      if (amount < MIN_TRANSFER_AMOUNT) {
        points = 0;
      }
    }

    if (actionKey === 'submission|submit_contract') {
      // unique code check
      const code = kwargs.code ?? '';
      if (!code || uniqueContractCodes.has(code)) {
        points = 0;
      } else {
        uniqueContractCodes.add(code);
      }
    }

    return { points, awardAddress };
  }

  // 4.4 - No recognized action => 0 points
  return { points: 0, awardAddress };
}

/****************************************************
 * 5) Main: Fetch data, accumulate, display
 ****************************************************/
fetch('https://node.xian.org/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
})
.then((res) => res.json())
.then((response) => {
  const edges = response.data.allTransactions.edges;
  const scoreboard = {}; // { [address]: totalPoints }

  // Evaluate each transaction
  edges.forEach(({ node }) => {
    if (!node.success) return; // skip failed

    const { points, awardAddress } = getPointsAndAddress(node);
    if (points > 0 && awardAddress) {
      scoreboard[awardAddress] = (scoreboard[awardAddress] || 0) + points;
    }
  });

  // Sort scoreboard by descending points
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1] - a[1]);

  // Build leaderboard
  const tbody = document.querySelector('#leaderboard tbody');
  sorted.forEach(([address, totalPoints], idx) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${idx + 1}</td>
      <td>${address}</td>
      <td>${totalPoints}</td>
    `;
    tbody.appendChild(row);
  });

  // Reveal table, hide loading
  document.getElementById('status').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
})
.catch((err) => {
  console.error(err);
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'alert alert-danger text-center';
  statusDiv.innerText = 'Error loading data. Check console.';
});

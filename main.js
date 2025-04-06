/**************************************************
 * 1. GraphQL Query
 **************************************************/
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

/**************************************************
 * 2. Scoring Rules
 **************************************************/
// Each action has a base point value
// Add bridging scenario: (con_usdc, mint) => +5
const pointsForAction = [
  { contract: 'con_dex_v2', functionName: 'swapExactTokenForTokenSupportingFeeOnTransferTokens', points: 5 },
  { contract: 'con_dex_v2', functionName: 'addLiquidity',                                        points: 10 },
  { contract: 'con_pixel_frames', functionName: 'create_thing',                                  points: 5 },
  { contract: 'con_pixel_frames', functionName: 'buy_thing',                                     points: 3 },
  { contract: 'con_name_service_final', functionName: 'mint_name',                               points: 2 },
  { contract: 'currency', functionName: 'transfer',                                              points: 1 },
  { contract: 'submission', functionName: 'submit_contract',                                     points: 15 },
  { contract: 'con_usdc', functionName: 'mint',                                                  points: 5 } // bridging
];

/**************************************************
 * 3. Sybil Resistance Thresholds
 **************************************************/
const MIN_SWAP_AMOUNT     = 10;   // e.g., need >10 tokens swapped
const MIN_TRANSFER_AMOUNT = 1;    // e.g., need >1 token transferred
const MIN_LIQUIDITY_A     = 5;    // e.g., need >5 tokens for addLiquidity tokenA
const MIN_LIQUIDITY_B     = 100;  // e.g., need >100 tokens for addLiquidity tokenB
const MIN_BRIDGE_AMOUNT   = 10;   // e.g., bridging must be >=10 USDC

// track unique contract codes
const uniqueContractCodes = new Set();

/**************************************************
 * 4. Helper: getPointsAndAddress
 *    Decide how many points to award & to which address
 **************************************************/
function getPointsAndAddress(node) {
  const { contract, function: funcName, sender, jsonContent } = node;

  // Find matching scoring rule
  const rule = pointsForAction.find(r => r.contract === contract && r.functionName === funcName);
  if (!rule) return { points: 0, awardAddress: sender };

  let basePoints = rule.points;
  let awardAddress = sender; // default to the node's sender
  const kwargs = jsonContent?.payload?.kwargs || {};

  // -----------------------------------------------
  // Bridging: if con_usdc + mint => give points to kwargs.to
  // Also check bridging threshold
  // -----------------------------------------------
  if (contract === 'con_usdc' && funcName === 'mint') {
    awardAddress = kwargs.to; // the bridged user
    const amountMinted = parseFloat(kwargs.amount ?? '0');
    if (amountMinted < MIN_BRIDGE_AMOUNT) {
      return { points: 0, awardAddress };
    }
  }

  // -----------------------------------------------
  // Dex Swap threshold
  // -----------------------------------------------
  if (contract === 'con_dex_v2' && funcName === 'swapExactTokenForTokenSupportingFeeOnTransferTokens') {
    const amountIn = parseFloat(kwargs.amountIn ?? '0');
    if (amountIn < MIN_SWAP_AMOUNT) {
      return { points: 0, awardAddress };
    }
  }

  // -----------------------------------------------
  // Transfer threshold
  // -----------------------------------------------
  if (contract === 'currency' && funcName === 'transfer') {
    const amount = parseFloat(kwargs.amount ?? '0');
    if (amount < MIN_TRANSFER_AMOUNT) {
      return { points: 0, awardAddress };
    }
  }

  // -----------------------------------------------
  // Add Liquidity threshold
  // -----------------------------------------------
  if (contract === 'con_dex_v2' && funcName === 'addLiquidity') {
    const aDesired = parseFloat(kwargs.amountADesired ?? '0');
    const bDesired = parseFloat(kwargs.amountBDesired ?? '0');
    if (aDesired < MIN_LIQUIDITY_A || bDesired < MIN_LIQUIDITY_B) {
      return { points: 0, awardAddress };
    }
  }

  // -----------------------------------------------
  // Unique contract code check
  // -----------------------------------------------
  if (contract === 'submission' && funcName === 'submit_contract') {
    const code = kwargs.code ?? '';
    if (!code || uniqueContractCodes.has(code)) {
      return { points: 0, awardAddress };
    }
    uniqueContractCodes.add(code);
  }

  // If all checks pass, return the base points
  return { points: basePoints, awardAddress };
}

/**************************************************
 * 5. Main: Fetch, Accumulate, and Display
 **************************************************/
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
    if (!node.success) return; // skip failed transactions

    const { points, awardAddress } = getPointsAndAddress(node);
    if (points > 0 && awardAddress) {
      if (!scoreboard[awardAddress]) {
        scoreboard[awardAddress] = 0;
      }
      scoreboard[awardAddress] += points;
    }
  });

  // Sort scoreboard by descending points
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1] - a[1]);

  // Build leaderboard table
  const tbody = document.querySelector('#leaderboard tbody');
  sorted.forEach(([address, totalPoints], index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${address}</td>
      <td>${totalPoints}</td>
    `;
    tbody.appendChild(row);
  });

  // Update UI
  document.getElementById('status').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
})
.catch(err => {
  console.error(err);
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'alert alert-danger text-center';
  statusDiv.innerText = 'Error loading data. Check console.';
});

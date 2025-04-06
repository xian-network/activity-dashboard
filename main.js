/*****************************************
 * 1. GRAPHQL QUERY
 *****************************************/
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

/*****************************************
 * 2. SCORING RULES
 *****************************************/
// Same base scoring as before
const pointsForAction = [
  { contract: 'con_dex_v2',            functionName: 'swapExactTokenForTokenSupportingFeeOnTransferTokens', points: 5 },
  { contract: 'con_dex_v2',            functionName: 'addLiquidity',                                        points: 10 },
  { contract: 'con_pixel_frames',      functionName: 'create_thing',                                        points: 5 },
  { contract: 'con_pixel_frames',      functionName: 'buy_thing',                                           points: 3 },
  { contract: 'con_name_service_final',functionName: 'mint_name',                                           points: 2 },
  { contract: 'currency',              functionName: 'transfer',                                            points: 1 },
  { contract: 'submission',            functionName: 'submit_contract',                                     points: 15 }
];

/*****************************************
 * 3. SYBIL-RESISTANCE THRESHOLDS
 *****************************************/
// Adjust these to your preferred minimums
const MIN_SWAP_AMOUNT = 10;      // e.g., require at least 10 tokens in a swap
const MIN_TRANSFER_AMOUNT = 1;   // e.g., require at least 1 token in a transfer
const MIN_LIQUIDITY_A = 5;       // e.g., require at least 5 tokens for addLiquidity amountA
const MIN_LIQUIDITY_B = 100;     // e.g., require at least 100 tokens for addLiquidity amountB

// We also track unique contract codes to prevent spammy repeated submissions
// If the exact same code is submitted multiple times, only the first gets points
const uniqueContractCodes = new Set();


/*****************************************
 * 4. HELPER FUNCTION TO EVALUATE POINTS
 *****************************************/
function getPoints(node) {
  const { contract, function: funcName, jsonContent } = node;
  
  // 4.1 Look up a matching (contract, functionName) in the scoring table
  const rule = pointsForAction.find(
    (r) => r.contract === contract && r.functionName === funcName
  );
  if (!rule) return 0; // Not a tracked action => 0 points

  let basePoints = rule.points;

  // 4.2 Extract payload data to enforce thresholds
  const kwargs = jsonContent?.payload?.kwargs || {};

  // ---------------------------------------------------
  // SWAP THRESHOLD CHECK
  // ---------------------------------------------------
  if (contract === 'con_dex_v2' && funcName === 'swapExactTokenForTokenSupportingFeeOnTransferTokens') {
    const amountIn = parseFloat(kwargs.amountIn ?? '0');
    if (isNaN(amountIn) || amountIn < MIN_SWAP_AMOUNT) {
      return 0; // Below threshold => 0 points
    }
  }

  // ---------------------------------------------------
  // TRANSFER THRESHOLD CHECK
  // ---------------------------------------------------
  if (contract === 'currency' && funcName === 'transfer') {
    const amount = parseFloat(kwargs.amount ?? '0');
    if (isNaN(amount) || amount < MIN_TRANSFER_AMOUNT) {
      return 0;
    }
  }

  // ---------------------------------------------------
  // ADD LIQUIDITY THRESHOLD CHECK
  // ---------------------------------------------------
  if (contract === 'con_dex_v2' && funcName === 'addLiquidity') {
    const amountADesired = parseFloat(kwargs.amountADesired ?? '0');
    const amountBDesired = parseFloat(kwargs.amountBDesired ?? '0');
    if (
      isNaN(amountADesired) || amountADesired < MIN_LIQUIDITY_A ||
      isNaN(amountBDesired) || amountBDesired < MIN_LIQUIDITY_B
    ) {
      return 0;
    }
  }

  // ---------------------------------------------------
  // UNIQUE CONTRACT CODE CHECK
  // ---------------------------------------------------
  if (contract === 'submission' && funcName === 'submit_contract') {
    const submittedCode = kwargs.code ?? '';
    // If code is empty or we've seen it before, award 0
    if (!submittedCode || uniqueContractCodes.has(submittedCode)) {
      return 0;
    } else {
      // Mark this code as seen
      uniqueContractCodes.add(submittedCode);
    }
  }

  // If we pass all checks, return the base points
  return basePoints;
}

/*****************************************
 * 5. MAIN LOGIC: FETCH, AGGREGATE, DISPLAY
 *****************************************/
fetch('https://node.xian.org/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
})
.then((res) => res.json())
.then((response) => {
  // 5.1 Collect all transactions
  const edges = response.data.allTransactions.edges;
  const scoreboard = {}; // { [senderAddress]: totalPoints }

  // 5.2 Evaluate each transaction
  edges.forEach(({ node }) => {
    const { sender, success } = node;
    if (!success) return; // Only count successful transactions

    const pts = getPoints(node);
    if (pts > 0) {
      scoreboard[sender] = (scoreboard[sender] || 0) + pts;
    }
  });

  // 5.3 Sort addresses by descending points
  const sorted = Object.entries(scoreboard)
    .sort((a, b) => b[1] - a[1]);

  // 5.4 Populate the leaderboard table
  const tableBody = document.querySelector('#leaderboard tbody');
  sorted.forEach(([address, points], index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${address}</td>
      <td>${points}</td>
    `;
    tableBody.appendChild(row);
  });

  // 5.5 Show the results, hide loading
  document.getElementById('status').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
})
.catch((err) => {
  console.error(err);
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'alert alert-danger text-center';
  statusDiv.innerText = 'Error loading data. Check console.';
});

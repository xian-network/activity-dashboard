/* main.js – Xian Monthly Competition (May 1 → June 1)
   -----------------------------------------------------
   Tracks:  
     • Bridging (con_usdc.mint)  
     • Swaps on pair 1 (xUSDC/XIAN)  
     • XNS name mint (+5)
   -----------------------------------------------------*/

if (window.location.protocol === "http:") {
  window.location.href = window.location.href.replace("http:", "https:");
}

/* ----------------------------------------------------
 * DATE RANGE: fixed May 1 → June 1 of current year
 * -------------------------------------------------- */
function getMayJuneRange() {
  const yr = new Date().getUTCFullYear();
  return {
    thisMonthStartISO: new Date(Date.UTC(yr, 4, 1)).toISOString(), // May 1 00:00 UTC
    nextMonthStartISO: new Date(Date.UTC(yr, 5, 1)).toISOString()  // June 1 00:00 UTC
  };
}

function isDoublePointsPeriod(dateStr) {
  const txTime = new Date(dateStr);
  const doubleEnd = new Date(Date.UTC(txTime.getUTCFullYear(), 4, 6)); // May 6, 00:00 UTC
  return txTime < doubleEnd;
}

/* ----------------------------------------------------
 * SCORING CONSTANTS
 * -------------------------------------------------- */
const BRIDGE_POINTS_PER_USDC = 10;
const BRIDGE_CAP = 50;

const SWAP_POINTS_PER_USDC = 10;
const SWAP_CAP = 50;
const MIN_SWAP_USDC = 10;

const FIXED_ACTIONS = {
  "con_name_service_final|mint_name": 5
};

/* ----------------------------------------------------
 * POINT HELPERS
 * -------------------------------------------------- */
function toUsdcFromCurrency(currencyAmount) {
  return currencyAmount * 0.01;
}

function pointsForBridge(mintedUsdc) {
  return Math.min(Math.floor(mintedUsdc / BRIDGE_POINTS_PER_USDC), BRIDGE_CAP);
}

function pointsForSwap(usdcEq) {
  if (usdcEq < MIN_SWAP_USDC) return 0;
  return Math.min(Math.floor(usdcEq / SWAP_POINTS_PER_USDC), SWAP_CAP);
}

/* ----------------------------------------------------
 * BUILD & FIRE THE GRAPHQL QUERY
 * -------------------------------------------------- */
const { thisMonthStartISO, nextMonthStartISO } = getMayJuneRange();

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

fetch("https://node.xian.org/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query })
})
  .then(res => res.json())
  .then(({ data }) => buildLeaderboard(data.allTransactions.edges))
  .catch(showError);

/* ----------------------------------------------------
 * MAIN PROCESSOR
 * -------------------------------------------------- */
function buildLeaderboard(edges) {
  const scores = {};

  edges.forEach(({ node }) => {
    if (!node.success) return;

    const { contract, function: fn, sender, jsonContent } = node;
    const doubleBoost = isDoublePointsPeriod(node.created) ? 2 : 1;

    // Fixed-point actions (XNS mint)
    const fixedKey = `${contract}|${fn}`;
    if (fixedKey in FIXED_ACTIONS) {
      const points = FIXED_ACTIONS[fixedKey] * doubleBoost;
      if (points > 0) {
        scores[sender] = (scores[sender] || 0) + points;
      }
      return;
    }

    // Bridging (con_usdc.mint)
    /*if (contract === "con_usdc" && fn === "mint") {
      const minted = parseFloat(jsonContent?.payload?.kwargs?.amount ?? "0");
      const toAddr = jsonContent?.payload?.kwargs?.to;
      if (minted > 0 && toAddr) {
        const cappedMinted = Math.min(minted, BRIDGE_CAP * BRIDGE_POINTS_PER_USDC);
        const points = pointsForBridge(cappedMinted) * doubleBoost;
        if (points > 0) {
          scores[toAddr] = (scores[toAddr] || 0) + points;
        }
      }
      return;
    }*/

    // Swap events inside con_pairs (pair 1 only)
    (jsonContent?.tx_result?.events || []).forEach(evt => {
      if (
        evt.contract !== "con_pairs" ||
        evt.data_indexed?.pair !== "1" ||
        evt.event !== "Swap"
      ) return;

      const amount0In = parseFloat(evt.data?.amount0In ?? "0");
      const amount1In = parseFloat(evt.data?.amount1In ?? "0");
      const usdcEq = amount0In + toUsdcFromCurrency(amount1In);

      if (usdcEq > 0) {
        const signer = evt.signer;
        const cappedUsdcEq = Math.min(usdcEq, SWAP_CAP * SWAP_POINTS_PER_USDC);
        const points = pointsForSwap(cappedUsdcEq) * doubleBoost;
        if (points > 0) {
          scores[signer] = (scores[signer] || 0) + points;
        }
      }
    });
  });

  renderTable(sortScores(scores));
}

/* ----------------------------------------------------
 * RENDERING
 * -------------------------------------------------- */
function sortScores(obj) {
  return Object.entries(obj).sort(([, aPts], [, bPts]) => bPts - aPts);
}

function renderTable(sorted) {
  const tbody = document.querySelector("#leaderboard tbody");
  tbody.innerHTML = "";
  sorted.forEach(([addr, pts], idx) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${idx + 1}</td><td>${addr}</td><td>${pts}</td>`;
    tbody.appendChild(row);
  });
  document.getElementById("status").classList.remove("d-flex");
  document.getElementById("status").style.display = "none";
  document.getElementById("leaderboard-container").style.display = "block";
}

function showError(err) {
  console.error(err);
  const status = document.getElementById("status");
  status.className = "alert alert-danger text-center";
  status.textContent = "Error loading data. Check console.";
}

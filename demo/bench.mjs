// Gas benchmark on the production bytecode, one transaction per action.
//
//   fe build && (cd demo && npm ci && npm run bench)
//
// Unlike the gas tests in `fe test`, which run in a single transaction
// where storage stays warm, every number here is a real transaction with
// cold storage and the 21,000 intrinsic gas.
import { parseEther } from "viem";
import { Chain, artifact } from "./chain.mjs";

const HOUR = 3600n;
const LOT = 10n ** 18n;
const gavelArtifact = artifact("Gavel");
const tokenArtifact = artifact("LotToken");

async function market(chain, seller, supply) {
  const token = await chain.deploy(seller, tokenArtifact, [supply * LOT]);
  const gavel = await chain.deploy(seller, gavelArtifact, [
    seller.address, token.address, LOT, supply, 1n, 1n, 0n, HOUR, HOUR,
  ]);
  await chain.send(seller, token, "approve", [gavel.address, supply * LOT]);
  await chain.send(seller, gavel, "fund");
  return gavel;
}

// The commitment is checked on reveal, so the bench asks the contract for it.
async function commit(chain, gavel, bidder, price, quantity, salt) {
  const c = await chain.call(gavel, "commitmentOf", [bidder.address, price, quantity, salt]);
  const tx = await chain.send(bidder, gavel, "commit", [c], { value: price * quantity });
  return tx.returned;
}

const rows = [];
const row = (operation, n, gas) => {
  rows.push({ operation, n, gas });
  process.stdout.write(".");
};

// 1. A reveal into a book of n bids. Falling prices make every new bid the
//    worst so far, so it sifts all the way to the root: the deepest path.
{
  const chain = await Chain.create();
  const seller = await chain.account("seller");
  const bidder = await chain.account("bidder", 10_000n);
  const n = 128n;
  const gavel = await market(chain, seller, n);
  for (let i = 0n; i < n; i++) await commit(chain, gavel, bidder, 1000n - i, 1n, i);
  chain.warp(HOUR);
  const sizes = new Set([0n, 1n, 3n, 7n, 15n, 31n, 63n, 127n]);
  for (let i = 0n; i < n; i++) {
    const tx = await chain.send(bidder, gavel, "reveal", [i, 1000n - i, 1n, i]);
    if (sizes.has(i)) row("reveal into a book of N bids", i, tx.gasUsed);
  }
}

// 2. One large bid that pushes all N bids out of a full book: the worst
//    case for a single reveal.
for (const k of [1n, 8n, 16n, 32n, 64n]) {
  const chain = await Chain.create();
  const seller = await chain.account("seller");
  const bidder = await chain.account("bidder", 10_000n);
  const gavel = await market(chain, seller, k);
  for (let i = 0n; i < k; i++) await commit(chain, gavel, bidder, 100n + i, 1n, i);
  const whale = await commit(chain, gavel, bidder, 10_000n, k, 999n);
  chain.warp(HOUR);
  for (let i = 0n; i < k; i++) await chain.send(bidder, gavel, "reveal", [i, 100n + i, 1n, i]);
  const tx = await chain.send(bidder, gavel, "reveal", [whale, 10_000n, k, 999n]);
  row("reveal that evicts N bids", k, tx.gasUsed);
}

// 3. Settlement does not depend on the number of bids.
for (const n of [4n, 32n, 128n]) {
  const chain = await Chain.create();
  const seller = await chain.account("seller");
  const bidder = await chain.account("bidder", 10_000n);
  const gavel = await market(chain, seller, n);
  for (let i = 0n; i < n; i++) await commit(chain, gavel, bidder, 100n + i, 1n, i);
  chain.warp(HOUR);
  for (let i = 0n; i < n; i++) await chain.send(bidder, gavel, "reveal", [i, 100n + i, 1n, i]);
  chain.warp(HOUR);
  row("claim, marginal bid", n, (await chain.send(bidder, gavel, "claim", [0n])).gasUsed);
  row("claim, best bid", n, (await chain.send(bidder, gavel, "claim", [n - 1n])).gasUsed);
  row("withdrawProceeds", n, (await chain.send(seller, gavel, "withdrawProceeds")).gasUsed);
}

// 4. Commit.
{
  const chain = await Chain.create();
  const seller = await chain.account("seller");
  const bidder = await chain.account("bidder");
  const gavel = await market(chain, seller, 10n);
  await commit(chain, gavel, bidder, parseEther("0.01"), 1n, 0n);
  const c = await chain.call(gavel, "commitmentOf", [bidder.address, parseEther("0.01"), 1n, 1n]);
  row("commit", 1n, (await chain.send(bidder, gavel, "commit", [c], { value: parseEther("0.01") })).gasUsed);
}

console.log("\n\n| operation | N | gas |\n| --- | ---: | ---: |");
for (const { operation, n, gas } of rows) {
  console.log(`| ${operation} | ${n} | ${gas.toLocaleString("en-US")} |`);
}

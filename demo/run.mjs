// End-to-end demo: a complete Gavel auction on the production bytecode.
//
//   fe build && (cd demo && npm ci && npm run demo)
//
// Five bidders compete for ten lots. The chain only ever sees hashes and
// deposits until the reveal phase. The script checks every number it prints
// and exits with an error if the contract disagrees.
import { strict as assert } from "node:assert";
import { encodeAbiParameters, formatEther, keccak256, parseEther } from "viem";
import { Chain, artifact } from "./chain.mjs";

const HOUR = 3600n;
const LOT = 10n ** 18n;
const eth = (wei) => `${formatEther(wei)} ETH`;

const chain = await Chain.create();
const gavelArtifact = artifact("Gavel");
const tokenArtifact = artifact("LotToken");
const gas = {};
const record = (what, used) => (gas[what] ??= []).push(used);

function step(text) {
  console.log(`\n== ${text}`);
}

// --- Setup -------------------------------------------------------------------

step("The seller deploys a token and an auction for 10 lots");
const seller = await chain.account("seller");
const token = await chain.deploy(seller, tokenArtifact, [1000n * LOT]);
const config = {
  supply: 10n,
  minLots: 1n,
  reserve: parseEther("0.01"),
  penaltyBps: 500n,
};
const gavel = await chain.deploy(seller, gavelArtifact, [
  seller.address,
  token.address,
  LOT,
  config.supply,
  config.minLots,
  config.reserve,
  config.penaltyBps,
  HOUR,
  HOUR,
]);
record("deploy Gavel", gavel.gasUsed);
console.log(`LotToken ${token.address}\nGavel    ${gavel.address}`);
console.log(`10 lots of 1 token, reserve ${eth(config.reserve)} per lot, 5% penalty for unrevealed bids`);
console.log(`commit phase 1 h, then reveal phase 1 h (gas to deploy Gavel: ${gavel.gasUsed})`);

await chain.send(seller, token, "approve", [gavel.address, config.supply * LOT]);
const funded = await chain.send(seller, gavel, "fund");
record("fund", funded.gasUsed);
assert.equal(await chain.call(token, "balanceOf", [gavel.address]), 10n * LOT);
console.log("funded: the auction holds the 10 lots");

// --- Commit ------------------------------------------------------------------

step("Commit phase: sealed bids");
// A commitment is keccak256(abi.encode(chainid, auction, bidder, price, quantity, salt)),
// computed off-chain: the contract never sees the bid until it is revealed.
function sealed(bidder, price, quantity, salt) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint128" }, { type: "uint64" }, { type: "uint256" }],
        [chain.chainId, gavel.address, bidder.address, price, quantity, salt],
      ),
    ),
  );
}

const bids = [
  { who: "alice", quantity: 4n, price: parseEther("0.10"), deposit: parseEther("0.40") },
  { who: "bob", quantity: 4n, price: parseEther("0.08"), deposit: parseEther("0.32") },
  { who: "carol", quantity: 4n, price: parseEther("0.06"), deposit: parseEther("0.24") },
  // Dave hides how much he wants behind a larger deposit.
  { who: "dave", quantity: 3n, price: parseEther("0.09"), deposit: parseEther("0.50") },
  // Erin will not reveal.
  { who: "erin", quantity: 2n, price: parseEther("0.12"), deposit: parseEther("0.30") },
];
for (const [i, bid] of bids.entries()) {
  bid.bidder = await chain.account(bid.who);
  bid.salt = BigInt(keccak256(`0x${(i + 1).toString(16).padStart(2, "0")}`));
  bid.start = await chain.balance(bid.bidder.address);
  const commitment = sealed(bid.bidder, bid.price, bid.quantity, bid.salt);
  // The on-chain helper agrees with the off-chain computation.
  assert.equal(await chain.call(gavel, "commitmentOf", [bid.bidder.address, bid.price, bid.quantity, bid.salt]), commitment);
  const tx = await chain.send(bid.bidder, gavel, "commit", [commitment], { value: bid.deposit });
  bid.id = tx.returned;
  record("commit", tx.gasUsed);
  console.log(`${bid.who.padEnd(6)} bid #${bid.id}: deposit ${eth(bid.deposit).padEnd(10)} commitment ${`0x${commitment.toString(16)}`.slice(0, 18)}…`);
}
const early = await chain.sendExpectingRevert(bids[0].bidder, gavel, "reveal", [0n, bids[0].price, bids[0].quantity, bids[0].salt]);
assert.equal(early.errorName, "WrongPhase");
console.log(`revealing now fails with ${early.errorName}(expected ${early.args[0]}, current ${early.args[1]})`);

// --- Reveal ------------------------------------------------------------------

chain.warp(HOUR);
step("Reveal phase: bids enter the clearing book as they are opened");
assert.equal(await chain.call(gavel, "phase"), 1);
const byName = Object.fromEntries(bids.map((bid) => [bid.who, bid]));
for (const who of ["carol", "alice", "bob", "dave"]) {
  const bid = byName[who];
  const tx = await chain.send(bid.bidder, gavel, "reveal", [bid.id, bid.price, bid.quantity, bid.salt]);
  record("reveal", tx.gasUsed);
  const price = await chain.call(gavel, "clearingPrice");
  const [, marginalId] = await chain.call(gavel, "marginal");
  const demand = await chain.call(gavel, "demand");
  const outbid = tx.events.filter((e) => e.eventName === "Outbid").map((e) => `#${e.args.id}`);
  console.log(
    `${who.padEnd(6)} ${bid.quantity} lots at ${eth(bid.price).padEnd(9)}` +
      ` → demand ${String(demand).padStart(2)}/10, clearing price ${eth(price).padEnd(9)} margin #${marginalId}` +
      (outbid.length ? `, outbid: ${outbid.join(" ")}` : ""),
  );
}
assert.equal(await chain.call(gavel, "clearingPrice"), parseEther("0.08"));
assert.equal(await chain.call(gavel, "isWinning", [byName.carol.id]), false);

step("Carol was outbid: she takes her deposit back before the auction ends");
const carolClaim = await chain.send(byName.carol.bidder, gavel, "claim", [byName.carol.id]);
record("claim (lost)", carolClaim.gasUsed);
console.log(`carol got ${eth(carolClaim.events.find((e) => e.eventName === "Claimed").args.refund)} back`);
const tooSoon = await chain.sendExpectingRevert(byName.alice.bidder, gavel, "claim", [byName.alice.id]);
assert.equal(tooSoon.errorName, "WrongPhase");
console.log(`alice is winning, so her claim waits: ${tooSoon.errorName}`);

// --- Settle ------------------------------------------------------------------

chain.warp(HOUR);
step("Settled: every winner pays the same price per lot");
assert.equal(await chain.call(gavel, "phase"), 2);
for (const who of ["alice", "bob", "dave", "erin"]) {
  const bid = byName[who];
  // Anyone may claim for a bid; the seller settles Erin's unrevealed one.
  const caller = who === "erin" ? seller : bid.bidder;
  const tx = await chain.send(caller, gavel, "claim", [bid.id]);
  record(who === "erin" ? "claim (unrevealed)" : "claim (won)", tx.gasUsed);
}
const proceedsTx = await chain.send(seller, gavel, "withdrawProceeds");
record("withdrawProceeds", proceedsTx.gasUsed);

// --- Results -----------------------------------------------------------------

step("Results");
const expected = {
  alice: { lots: 4n, refund: parseEther("0.08") },
  bob: { lots: 3n, refund: parseEther("0.08") },
  carol: { lots: 0n, refund: parseEther("0.24") },
  dave: { lots: 3n, refund: parseEther("0.26") },
  erin: { lots: 0n, refund: parseEther("0.285") },
};
console.log("bidder  bid               lots  paid        got back");
for (const bid of bids) {
  const lots = (await chain.call(token, "balanceOf", [bid.bidder.address])) / LOT;
  const back = (await chain.balance(bid.bidder.address)) - (bid.start - bid.deposit);
  const paid = bid.deposit - back;
  assert.equal(lots, expected[bid.who].lots, `${bid.who} lots`);
  assert.equal(back, expected[bid.who].refund, `${bid.who} refund`);
  const offer = `${bid.quantity} @ ${formatEther(bid.price)}`;
  console.log(`${bid.who.padEnd(7)} ${offer.padEnd(17)} ${String(lots).padStart(4)}  ${eth(paid).padEnd(11)} ${eth(back)}`);
}
const proceeds = proceedsTx.returned;
assert.equal(proceeds, parseEther("0.815"));
console.log(`seller received ${eth(proceeds)}: 10 lots × 0.08 ETH + 0.015 ETH from Erin's penalty`);
assert.equal(await chain.balance(gavel.address), 0n);
assert.equal(await chain.call(token, "balanceOf", [gavel.address]), 0n);
console.log("the auction holds 0 ETH and 0 tokens: every wei and every lot is accounted for");

step("Gas per transaction (cold storage, 21,000 intrinsic included)");
for (const [what, samples] of Object.entries(gas)) {
  const avg = samples.reduce((a, b) => a + b, 0n) / BigInt(samples.length);
  console.log(`${what.padEnd(20)} ${String(avg).padStart(9)}${samples.length > 1 ? `  (mean of ${samples.length})` : ""}`);
}
console.log("\nAll checks passed.");

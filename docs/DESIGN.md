# Gavel: design notes

This document explains the mechanism, why the clearing book is correct, how
the contract stays solvent, and what it does and does not defend against.
The [README](../README.md) gives the overview.

## 1. The mechanism

Gavel sells `supply` identical **lots** of an ERC-20 token (one lot is
`lot_size` token base units) in a sealed-bid, **uniform-price** auction.

| Phase | Time | What happens |
| --- | --- | --- |
| Commit | `[start, commit_end)` | Bidders send `commit(c)` with an ETH deposit. `c = keccak256(abi.encode(chainid, auction, bidder, price, quantity, salt))`. |
| Reveal | `[commit_end, reveal_end)` | Anyone opens a commitment with `reveal(id, price, quantity, salt)`. The bid enters the clearing book or is rejected. Losers may claim refunds at once. |
| Settled | `[reveal_end, ∞)` | Winners claim their lots and change. Unrevealed bids get their deposit back minus a penalty. Anyone triggers the seller's payout. |

A bid is `quantity` lots at `price` wei per lot. It is valid when
`price >= reserve`, `min_lots <= quantity <= supply` and
`price * quantity <= deposit`. Bids are ranked by price, and then by
commitment order (the lower id wins a tie).

**Allocation and price.** Rank the revealed bids from best to worst and
hand out lots in that order until the supply runs out. Every winner pays the
same **clearing price** per lot:

- if the bids ask for at least `supply` lots: the price of the **marginal
  bid**, the worst bid that receives any lots (the lowest accepted price);
- otherwise: the reserve price, every bid is filled in full, and the unsold
  lots go back to the seller.

Only the marginal bid can be partially filled. Since the clearing price is
at most every winner's own price, no winner pays more than they offered.

### Why these choices

- **Lowest accepted price, not the highest rejected price.** With
  multi-unit bids neither rule is truthful, because large bidders gain by
  shading their demand. The lowest accepted price is the standard choice
  for token sales (Gnosis EasyAuction uses it), it never charges a winner
  more than its own price, and it is the root of the heap, so reading it
  costs `O(1)`.
- **Ties go to the earlier commitment.** Reveal order would reward racing
  and give block builders a lever. A hash-based order could be ground at
  commit time. Commitment order is fixed before anyone sees any bid.
- **Integer lots.** Payments are `lots * price`, with no division, so there
  is no rounding anywhere except the penalty (section 4).
- **Deposits may exceed the cost.** An observer only learns an upper bound
  on each bid's cost.

## 2. The clearing book

`src/book.fe` keeps a `StorageHeap<Bid>` (Fe's std min-heap, after Solady's
`MinHeapLib`) whose root is the marginal bid. `Bid { price: u128, quantity: u64, id: u64 }`
is exactly 256 bits, so Fe packs each heap element into one storage slot.

**Invariant (I).** Let `B` be the bids in the book, `D = Σ quantity(B)`
and `m` the root. Then `D - quantity(m) < supply`: without the marginal
bid, the others do not cover the supply.

**Insert.** Given a newly revealed bid `b`:

1. If `D >= supply` (the book is full) and `b` does not beat `m`, reject `b`.
2. Otherwise push `b` and add its quantity to `D`.
3. While `D - quantity(root) >= supply`, pop the root (**evict** it).

**Claim 1. Every bid in the book receives at least one lot, and the book
is the set of winners.** By (I) the bids above the root total less than
`supply`, so they are filled in full and the root receives
`supply - (D - quantity(m)) > 0` lots, capped at its own quantity. Every
evicted or rejected bid `x` had, at that moment, better bids with
`quantity >= supply` above it. Step 1: `D >= supply` and every bid in the
book beats `x`. Step 3: `D - quantity(x) >= supply` with `x` the worst.

**Claim 2. A bid that leaves the book never wins.** Bids are never
un-revealed. The bids that pushed `x` out stay revealed, and later reveals
only add bids, so better bids for at least `supply` lots stay above `x`.
`x` gets nothing in the final ranking. This is what lets losers **take
their deposit back during the reveal phase**, before the auction ends.

**Claim 3. The book equals the textbook algorithm.** By claims 1 and 2,
after any sequence of reveals the book holds exactly the bids that the
sort-and-allocate algorithm would fill, with the same allocations. The
differential tests (section 6) check this on random auctions.

**Claim 4. Once full, the clearing price only rises.** A full book changes
only when a bid that beats the root arrives. The new root is the old root,
the new bid, or a bid between them. `clearing_price_never_falls_once_the_book_is_full`
and the differential tests check this.

**The new bid is never evicted in its own insert.** If `b` becomes the
root, the demand without it is the demand from before the insert. When the
book was full, step 1 rejects `b` unless it beats the old root, so `b` is
not the root. When it was not full, that demand is below `supply`.

**Cost.** Insert is `O(log n)` plus one `O(log n)` pop per evicted bid, and
each bid is evicted at most once. The clearing price, allocations and
membership (`StorageMap<u64, bool>`) are `O(1)` reads. There is **no loop
over bids anywhere**: not in settlement, not in claims, not in the seller's
withdrawal.

**Bounded worst case.** The book holds at most
`max_winners = ceil(supply / min_lots)` bids, since all but the root are
filled in full and each asks for at least `min_lots`. Deployment requires
`max_winners <= 256` (`MAX_WINNERS`). One reveal evicts at most that many
bids, about 15k gas each (measured), so the worst-case reveal stays near
4M gas. Without a cap, an attacker could fill the book with tiny bids to
make an honest whale's reveal too expensive.

## 3. Effects as the security boundary

Fe functions declare the capabilities they use (`uses (...)`). Gavel puts
its trust boundary there:

| Module | Effects | Can it move funds or call out? |
| --- | --- | --- |
| `book.fe` | `Log` | No |
| `auction.fe` | `Config` (read-only, kept in code), `Clock`, `Log` | No: returns `Payout` values |
| `gavel.fe` | `Ctx`, `Call`, `Log` + the above | Yes, after the state machine returned |

Adding an external call to `auction.fe` does not compile, because the
`call` capability is not in scope:

```text
error[8-0012]: undefined variable
    ┌─ src/auction.fe:393:17
    │
393 │         let _ = call.send_value(addr: record.bidder, gas: 0, value: refund)
    │                 ^^^^ undefined variable `call`
```

The only other route to the `CALL` opcode is an `unsafe` block, and the
ingot has none (`grep -rn unsafe src` is empty). So checks-effects-
interactions holds by construction: every state change for a claim,
reveal or withdrawal is complete before `gavel.fe` sees the `Payout` that
tells it whom to pay.

### The clock is an effect too

`fe test` runs each test in one transaction, so the block time is
frozen, and Fe's test runner has no cheat codes. Rather than add test-only
hooks to the contract, every time-dependent function says
`uses (clock: Clock)`, and the **contract** chooses the clock:

```fe
// src/gavel.fe: production, the block's timestamp
with (Clock = BlockTime::at(ctx.timestamp())) { auction.reveal(id, price, quantity, salt) }

// src/tests/harness.fe: same state machine, a clock the test can move
with (Clock = BlockTime::at(ctx.timestamp() + warp)) { auction.reveal(id, price, quantity, salt) }
```

`GavelHarness` has the same fields, init and handlers as `Gavel`. It calls
the same `Auction` methods and the same payout functions (`handle_claim`,
`handle_fund`, `handle_withdraw_proceeds`), and adds a `warp` message. The
production contract has no way to alter its clock. The demo runs `Gavel`
itself through every phase on a chain whose time does move.

## 4. Accounting and solvency

Let `p` be the clearing price, `a_i` each revealed bid's allocation,
`S = Σ a_i` the lots sold and `d_i` the deposits.

- A winner pays `p * a_i <= price_i * quantity_i <= d_i`, so its refund
  `d_i - p * a_i` is never negative.
- A loser is refunded `d_i`.
- An unrevealed bid pays `penalty_i = floor(d_i * penalty_bps / 10000)`.
  That amount is credited to the seller **when that bid is claimed**, so
  the seller is owed exactly the sum of the penalties actually taken. No
  aggregate rounding can drift.
- The seller is owed `p * S + Σ penalty_i`. It can withdraw any time after
  the end, repeatedly, and each withdrawal pays the difference from the
  last.

Summing over everyone: ETH paid out = `Σ d_i` once every bid is claimed
and the seller has withdrawn. Tokens: winners receive `S * lot_size`, the
seller `(supply - S) * lot_size`, and the contract was funded with
`supply * lot_size`. The tests assert that the auction ends with **0 ETH
and 0 tokens** in every lifecycle test, every differential trial and the
demo.

`fund` checks the balance it actually receives, so a fee-on-transfer or
rebasing token is refused (`TokenShortfall`) instead of leaving the auction
short.

## 5. Threat model

| Threat | Defense |
| --- | --- |
| Reading bids from the mempool or chain before the reveal | Only hashes and deposits are public. Deposits may exceed the cost. |
| Copying someone's commitment and revealing it with their opening | The commitment binds the bidder's address (`copied_commitment_cannot_be_opened`). |
| Replaying a commitment on another auction or chain | It binds the chain id and the auction address (`commitment_is_bound_to_its_auction`). |
| Front-running a reveal | A third party can only reveal the same bid for the same bidder; payouts always go to the bidder. |
| Reentrancy through ETH refunds or token callbacks | State is final before any transfer (enforced by effects, section 3). Reentrant claims revert with `AlreadyClaimed` (`reentrant_claim_is_paid_once`, `reentrant_winner_claim_is_paid_once`). |
| A receiver that refuses ETH | Its claim reverts as a whole and stays claimable. Nobody else is blocked (`failed_refund_keeps_the_bid_claimable`). |
| Gas griefing with many tiny bids | `min_lots` and `MAX_WINNERS` bound the book, and with it every reveal. No loop over commitments exists. |
| Fee-on-transfer or rebasing lot tokens | `fund` rejects a shortfall. |
| Under-collateralized bids | The reveal checks `cost <= deposit` (`InsufficientDeposit`). |
| Privileged roles | None. Funding, revealing, claiming and the seller's withdrawal are permissionless, and every payout goes to a fixed recipient. |

### Known limitations

- **Selective reveal.** A bidder who commits several bids can watch the
  others' reveals and open only some of theirs. The penalty
  (`penalty_bps`) makes this costly but does not prevent it. Fixing it
  needs encrypted bids that open automatically (threshold or time-lock
  encryption), which is out of scope.
- **Deposits leak an upper bound** on each bid's cost.
- **Shill bidding.** The seller may bid in its own auction to raise the
  clearing price. That is inherent to open participation.
- **Demand reduction.** In multi-unit uniform-price auctions, large
  bidders may shade their bids. That is a property of the mechanism class,
  not of this code.
- **Unclaimed funds stay in the contract.** There is no sweep, by design.
  Anyone can claim for anyone, so keepers can settle abandoned bids.
- **Gas figures** measured inside `fe test` come from a single transaction
  with warm storage. `demo/bench.mjs` measures real transactions with cold
  storage; the README's table comes from it.
- **Not audited.** Fe itself states that it is not production-ready.

## 6. Verification

| Evidence | Where |
| --- | --- |
| 68 tests: book rules, lifecycles, every error path, security cases, production contract | `fe test` |
| Differential testing: 32 random auctions (16 bids, 4 bidders, random deposits, 1 in 8 unrevealed, shuffled reveal order through std's `Rng` effect) against a sort-based reference. Every allocation, the price, every bidder's ETH, the seller's proceeds and all tokens are checked, and so is "evicted bids never win" | `src/tests/differential_tests.fe` |
| Mutation check: 9 planted bugs in the engine and state machine, all caught by real test failures | `scripts/mutation-check.sh` |
| End-to-end run of the production `Gavel` bytecode through every phase, with every balance asserted | `demo/run.mjs` |
| Gas on real transactions | `demo/bench.mjs` |
| Gas budgets as regression tests | `src/tests/gas_tests.fe` |

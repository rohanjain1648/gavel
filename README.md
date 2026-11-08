# Gavel

**Pitch:** A sealed-bid, uniform-price batch auction for ERC-20 tokens. It
clears *while* bids are revealed, so settlement needs no loop, losers are
refunded the moment they are outbid, and Fe's effect types prove that the
auction logic cannot move funds.

Built for the [Fe Builders Challenge](https://fe-lang.org/contest/) with
**Fe 26.5.1**. Category: *Rethink a protocol*.

```text
$ npm run demo
== Reveal phase: bids enter the clearing book as they are opened
carol  4 lots at 0.06 ETH  → demand  4/10, clearing price 0.01 ETH  margin #2
alice  4 lots at 0.1 ETH   → demand  8/10, clearing price 0.01 ETH  margin #2
bob    4 lots at 0.08 ETH  → demand 12/10, clearing price 0.06 ETH  margin #2
dave   3 lots at 0.09 ETH  → demand 11/10, clearing price 0.08 ETH  margin #1, outbid: #2

== Carol was outbid: she takes her deposit back before the auction ends
carol got 0.24 ETH back
```

## The problem

Batch auctions with one clearing price are a fair way to sell tokens: everyone
pays the same price, and sealed bids hide the information that front-runners
and snipers use. On-chain they usually break at settlement. The contract
collects every bid, then sorts or walks them all to find the price. That step
costs gas in proportion to the number of bidders. Enough bidders make the
auction impossible to settle in one block. Implementations work around it
with off-chain sorting hints, multi-transaction settlement or caps on the
number of bidders. Losers wait until the very end to get their ETH back.

## Approach

Gavel never waits for the end. Its **clearing book** keeps only the bids
that would win if the auction ended now, in Fe's `StorageHeap` with the
marginal bid at the root, and maintains one invariant:

> Without the marginal bid, the other bids in the book ask for fewer lots
> than the supply.

Each reveal costs `O(log n)`. A revealed bid either joins the book, pushing
out bids that no longer get any lots, or is rejected at once. A bid that
leaves the book can never win again, so **losers claim their deposit back
immediately**. When the reveal phase ends, the clearing price is the root of
the heap: **settlement is `O(1)`**, and no loop over bids exists anywhere in
the contract. [docs/DESIGN.md](docs/DESIGN.md) proves the invariant and the
solvency argument.

The mechanism: commit `keccak256(abi.encode(chainid, auction, bidder, price, quantity, salt))`
with an ETH deposit. Reveal during the reveal phase. After it, every winner
pays the same price per lot, the lowest accepted bid, or the reserve if the
lots are undersubscribed, and gets the rest of its deposit back. Bids that
are never revealed forfeit a configurable penalty to the seller. Nothing is
privileged. Funding, revealing, claiming and paying out the seller are open
to anyone, and every payout goes to a fixed recipient.

Everything in this repository was written during the contest window.

## Fe highlight

**The trust boundary is in the type signatures.** The auction's state
machine has no `Call` effect, so the compiler guarantees it cannot make an
external call or move ETH or tokens. It returns a `Payout`, and only the
contract layer, which does have `Call`, pays it. Checks-effects-interactions
holds by construction:

```fe
// src/auction.fe: the state machine. Its effects: read-only config, a clock, logs.
pub fn claim(mut self, id: u64) -> Payout uses (config: Config, clock: Clock, log: mut Log) { .. }

// src/gavel.fe: the only module with `Call`. State is final before anyone is paid.
pub fn handle_claim(_ id: u64) -> u256
    uses (ctx: Ctx, call: mut Call, config: Config, auction: mut Auction, clock: Clock, log: mut Log)
{
    let payout: Payout = auction.claim(id)
    if payout.tokens > 0 {
        safe_transfer(token: config.token, receiver: payout.to, amount: payout.tokens)
    }
    send_eth(to: payout.to, amount: payout.refund)
    payout.lots
}
```

Adding a transfer inside `auction.fe` is a compile error
(`undefined variable 'call'`), and the ingot has no `unsafe` code to get
around it.

**Time is an effect, too.** `fe test` runs each test in a single
transaction, so block time cannot move, and Fe has no cheat codes. Every
time-dependent function declares `uses (clock: Clock)`, and the *contract*
supplies the clock:

```fe
// Production (`Gavel`): the block's timestamp.
with (Clock = BlockTime::at(ctx.timestamp())) { auction.reveal(id, price, quantity, salt) }
// Test harness (`GavelHarness`): the same state machine, a clock the test moves.
with (Clock = BlockTime::at(ctx.timestamp() + warp)) { auction.reveal(id, price, quantity, salt) }
```

The rest of the design leans on Fe too:

- `Bid { price: u128, quantity: u64, id: u64 }` packs into one storage slot
  for the std `StorageHeap`.
- The auction's `Config` is an immutable contract field, so it lives in
  code, and functions read it as a read-only effect.
- `Wei`, `Timestamp` and `Duration` keep ETH amounts and times from mixing.
- `#[error]` structs give typed custom errors that viem decodes.
- The differential tests draw their random auctions from std's `Rng` effect
  (`with (Rng = KeccakRng::seeded(seed))`).

## Architecture

```text
src/
├── bid.fe        Bid (one storage slot), priority order, commitment hash
├── clock.fe      Clock effect, BlockTime, Phase, Schedule
├── book.fe       ClearingBook: StorageHeap<Bid> + membership map    effects: Log
├── auction.fe    Auction state machine, Config, errors, events      effects: Config, Clock, Log
├── gavel.fe      GavelMsg (Solidity ABI), Gavel contract, payouts   effects: Ctx, Call, Log
├── token.fe      LotToken: minimal ERC-20 to auction
└── tests/        68 tests (see Evidence); GavelHarness and Bidder proxies in harness.fe
demo/             End-to-end demo and gas benchmark on the built bytecode (Node, EthereumJS, viem)
scripts/          Mutation check, gas report
docs/DESIGN.md    Mechanism, proofs, solvency, threat model
```

A call flows `Gavel` handler → `with (Clock = ..)` → `Auction` method →
`ClearingBook`. Then, back in the handler, the transfers happen.

## Build and test

```sh
fe --version        # fe 26.5.1
fe fmt --check
fe test             # 68 tests, about 35 s
fe build            # out/Gavel.bin, out/Gavel.abi.json, out/LotToken.bin, ...
```

Install Fe 26.5.1 with
`curl -fsSL https://raw.githubusercontent.com/argotorg/fe/master/feup/feup.sh | bash -s -- --version v26.5.1`
or take the binary from the [release](https://github.com/argotorg/fe/releases/tag/v26.5.1).
`fe build` also writes the test-only contracts in `src/tests`
(`GavelHarness`, `Bidder`, `BookHost`). Only `Gavel` and `LotToken` are meant
to be deployed (`fe build --contract Gavel`).

The demo and the benchmark need Node.js 20 or later:

```sh
cd demo && npm ci
npm run demo        # a full auction on the production bytecode, every balance checked
npm run bench       # gas on real transactions
cd .. && bash scripts/mutation-check.sh  # plants 9 bugs, all must be caught (about 4 min)
node scripts/gas-report.mjs              # gas measured inside `fe test`
```

## Demo

`npm run demo` deploys `out/Gavel.bin`, the bytecode `fe build` produced, on
an in-process EVM whose block time it controls. It then runs a complete
auction. Five bidders compete for 10 lots, and Erin never reveals. Excerpt:

```text
== Commit phase: sealed bids
alice  bid #0: deposit 0.4 ETH    commitment 0x623bc16faeeed514…
...
revealing now fails with WrongPhase(expected 1, current 0)

== Results
bidder  bid               lots  paid        got back
alice   4 @ 0.1              4  0.32 ETH    0.08 ETH
bob     4 @ 0.08             3  0.24 ETH    0.08 ETH
carol   4 @ 0.06             0  0 ETH       0.24 ETH
dave    3 @ 0.09             3  0.24 ETH    0.26 ETH
erin    2 @ 0.12             0  0.015 ETH   0.285 ETH
seller received 0.815 ETH: 10 lots × 0.08 ETH + 0.015 ETH from Erin's penalty
the auction holds 0 ETH and 0 tokens: every wei and every lot is accounted for
```

Commitments are computed off-chain with viem and accepted by the Fe
contract, and its custom errors decode with the generated ABI. Since the
selectors are Solidity's, `cast`, viem and ethers work with it unchanged.

## Evidence

| What | How |
| --- | --- |
| **68 tests** | Book rules (10), lifecycles (6), every phase and validation error with its exact custom error and fields (28), security (6), the production contract (6), differential (8), gas budgets (4) |
| **Differential testing** | 32 random auctions (16 bids, 4 bidders, random deposits, 1 in 8 unrevealed, shuffled reveal order) against a sort-based reference. Every allocation, the price, every bidder's ETH, the seller's proceeds and all tokens must match, and evicted bids must never win |
| **Mutation check** | 9 bugs planted in the engine and state machine (off-by-one evictions, a reversed tie-break, a full fill of the marginal bid, a skipped charge, ...). The suite catches every one |
| **Security cases** | Reentrant claims (loser and winner), receivers that refuse ETH, copied and replayed commitments, fee-on-transfer tokens, third-party reveals and claims |
| **End to end** | `demo/run.mjs` drives the production bytecode through every phase |

Gas per transaction from `npm run bench` (separate transactions, cold
storage, 21,000 intrinsic gas included):

| Operation | N | Gas |
| --- | ---: | ---: |
| commit | | 120,198 |
| reveal into a book of N bids | 1 | 119,666 |
| reveal into a book of N bids | 15 | 135,686 |
| reveal into a book of N bids | 127 | 151,706 |
| reveal that evicts N bids (worst case) | 8 | 193,208 |
| reveal that evicts N bids (worst case) | 64 | 977,624 |
| claim, marginal bid, with N bids in the auction | 4 or 128 | 83,944 |
| claim, any other winning bid | 4 or 128 | 73,548 |
| seller withdrawal | 4 or 128 | 68,674 |

A reveal costs about 5,300 more gas per doubling of the book. Claims cost
the same with 4 bids or 128. An eviction costs about 15,000 gas, and
`MAX_WINNERS = 256` caps the evictions per reveal.

## Limitations

- **Selective reveal.** A bidder with several commitments can watch the
  others' reveals and open only some of theirs. The penalty makes that
  costly but cannot stop it. Encrypted bids that open automatically
  (threshold or time-lock) would.
- Deposits are public, so they leak an upper bound on each bid's cost.
- Ties at the marginal price go to the earlier commitment. There is no
  pro-rata split.
- The book holds at most 256 possible winners (`ceil(supply / min_lots)`).
  Larger sales need larger lots or a higher `min_lots`.
- Fee-on-transfer and rebasing tokens are refused at funding.
- One auction per deployment. There is no factory, no sweep of abandoned
  deposits (anyone can claim them for their owner), and no frontend.
- The full lifecycle of the production contract is verified on an
  in-process EVM (EthereumJS, Cancun rules). It has not been deployed to a
  public testnet. The bytecode needs only `PUSH0` and `MCOPY`.
- Not audited. Fe itself is not production-ready.

See [docs/DESIGN.md](docs/DESIGN.md#5-threat-model) for the threat model.

## Declaration

- **Pre-existing work:** None. The project was started during the contest
  from [`fe-lang/builders-challenge-starter`](https://github.com/fe-lang/builders-challenge-starter)
  (commit `f9d9aa9`). Only its `LICENSE`, `.gitignore` and the shape of its
  CI workflow were kept; its example vault contract was not used.
- **Third-party code:** No code was copied. The contract uses Fe's standard
  library (`StorageHeap`, `StorageMap`, `std::evm::erc20` safe transfers,
  `std::evm::random` in tests), which is Apache-2.0. The demo uses
  [viem](https://viem.sh) (MIT) and [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo)
  (MPL-2.0) as npm dependencies.
- **AI assistance:** Developed with Claude (Anthropic) through Claude Code,
  which researched the Fe 26.5 standard library and compiler fixtures, and
  wrote the contracts, tests, demo and documentation under the author's
  direction. Every claim here is backed by a test, the demo or a script in
  this repository.

## Team

rohanjain1648

## License

[Apache-2.0](LICENSE)

#!/usr/bin/env bash
# Mutation check: plants one bug at a time in the clearing engine and checks
# that `fe test` fails for each. A mutant that survives means the test
# suite has a blind spot.
#
#   scripts/mutation-check.sh            # uses `fe` from PATH
#   scripts/mutation-check.sh --dry-run  # only check that every mutation applies
#   FE=/path/to/fe scripts/mutation-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
FE="${FE:-fe}"
DRY_RUN="${1:-}"

# file | original text | mutated text | description
mutants=(
  "src/book.fe|if self.demand - quantity < self.supply {|if self.demand - quantity <= self.supply {|evict one bid too many"
  "src/book.fe|if !marginal.lt(bid) {|if marginal.lt(bid) {|invert the full-book admission test"
  "src/book.fe|if remainder < quantity {\n            remainder\n        } else {\n            quantity\n        }|quantity|fill the marginal bid completely"
  "src/book.fe|if self.demand < self.supply {\n            return reserve|if self.demand < 0 {\n            return reserve|ignore the reserve when undersubscribed"
  "src/bid.fe|(self.price == other.price \&\& self.id > other.id)|(self.price == other.price \&\& self.id < other.id)|reverse the tie-break"
  "src/auction.fe|if cost > record.deposit {|if cost > record.deposit + record.deposit {|accept under-collateralized bids"
  "src/auction.fe|                    require_phase(Phase::Settled)\n                    let bid|                    let bid|let winners claim before the end"
  "src/auction.fe|        let refund = record.deposit - paid|        let refund = record.deposit|refund without charging"
  "src/auction.fe|        let proceeds = earned - self.withdrawn|        let proceeds = earned|pay the seller twice"
)

survived=0
invalid=0
current=""
# Put the original back however the script ends.
restore() {
  if [ -n "$current" ] && [ -f "$current.orig" ]; then
    mv "$current.orig" "$current"
  fi
}
trap restore EXIT

for entry in "${mutants[@]}"; do
  IFS='|' read -r file from to what <<<"$entry"
  current="$file"
  cp "$file" "$file.orig"
  node -e '
    const fs = require("fs");
    const [file, from, to] = process.argv.slice(1).map(s => s.replace(/\\n/g, "\n").replace(/\\&/g, "&"));
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes(from)) { console.error("mutation target not found in " + file + ": " + from); process.exit(2); }
    fs.writeFileSync(file, src.replace(from, to));
  ' "$file" "$from" "$to"
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "applies   $what  ($file)"
    mv "$file.orig" "$file"
    current=""
    continue
  fi
  if output="$("$FE" test 2>&1)"; then
    echo "SURVIVED  $what  ($file)"
    survived=$((survived + 1))
  elif grep -q "Compilation errors" <<<"$output"; then
    # A mutant that does not compile proves nothing about the tests.
    echo "INVALID   $what  ($file): does not compile"
    invalid=$((invalid + 1))
  else
    failed=$(grep -c "^FAIL" <<<"$output" || true)
    echo "killed    $what  ($file): $failed failing test(s)"
  fi
  mv "$file.orig" "$file"
  current=""
done

if [ "$survived" -ne 0 ] || [ "$invalid" -ne 0 ]; then
  echo "$survived mutant(s) survived, $invalid invalid"
  exit 1
fi
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "all ${#mutants[@]} mutations apply"
else
  echo "all ${#mutants[@]} mutants killed"
fi

#!/usr/bin/env node
// Runs the gas tests and prints their `GasUsed` events as a table.
//
//   node scripts/gas-report.mjs            # uses `fe` from PATH
//   FE=/path/to/fe node scripts/gas-report.mjs
//
// Needs the demo's dependencies for keccak256: `(cd demo && npm ci)`.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { keccak256, toHex } = createRequire(join(root, "demo", "package.json"))("viem");
const GAS_USED = keccak256(toHex("GasUsed(uint256,uint256,uint256)")).slice(2);

const fe = process.env.FE ?? "fe";
const output = execFileSync(fe, ["test", "--filter", "gas", "--show-logs", "--color", "never"], {
  cwd: root,
  encoding: "utf8",
});

const labels = {
  1: "reveal into a book of N bids",
  2: "reveal that evicts N bids",
  3: "claim (marginal bid), N bids in auction",
  4: "commit",
  5: "seller withdrawal, N bids in auction",
};

// `log Log { ..., topics: [signature, what], data: 0x<size><gas> }`
const pattern = /topics: \[0x([0-9a-f]{64}), 0x([0-9a-f]{64})\], data: 0x([0-9a-f]{128}) /;
const rows = [];
for (const line of output.split("\n")) {
  const m = line.match(pattern);
  if (!m || m[1] !== GAS_USED) continue;
  rows.push({
    what: Number(BigInt("0x" + m[2])),
    size: Number(BigInt("0x" + m[3].slice(0, 64))),
    gas: Number(BigInt("0x" + m[3].slice(64))),
  });
}
if (rows.length === 0) {
  console.error(output);
  throw new Error("no GasUsed events found");
}
rows.sort((a, b) => a.what - b.what || a.size - b.size);

const width = Math.max(...Object.values(labels).map((l) => l.length));
console.log(`| ${"operation".padEnd(width)} |     N |       gas |`);
console.log(`| ${"-".repeat(width)} | ----: | --------: |`);
for (const { what, size, gas } of rows) {
  const gasText = gas.toLocaleString("en-US").padStart(9);
  console.log(`| ${labels[what].padEnd(width)} | ${String(size).padStart(5)} | ${gasText} |`);
}
console.log("\nGas includes the test contract's CALL and ABI-encoding overhead.");

// A small in-process Ethereum chain for the demo and the gas benchmark.
//
// It runs the bytecode `fe build` writes to `out/` on the EthereumJS VM
// (Cancun rules; Gavel's bytecode needs nothing newer than PUSH0 and
// MCOPY). Every action is a signed transaction in its own block, so gas
// figures include the intrinsic cost and cold storage access, as on a real
// chain. The chain's clock only moves when `warp` is called.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  toHex,
} from "viem";
import { Block } from "@ethereumjs/block";
import { Chain as ChainId, Common, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Account, Address, bytesToHex, hexToBytes, privateToAddress } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Bytecode and ABI of a contract built by `fe build`. */
export function artifact(name) {
  const read = (file) => readFileSync(join(ROOT, "out", file), "utf8").trim();
  try {
    return { name, bytecode: "0x" + read(`${name}.bin`), abi: JSON.parse(read(`${name}.abi.json`)) };
  } catch (error) {
    throw new Error(`out/${name}.bin is missing: run \`fe build\` in ${ROOT} first`, { cause: error });
  }
}

export class RevertError extends Error {
  constructor(label, decoded, data) {
    super(`${label} reverted: ${decoded ? `${decoded.errorName}(${decoded.args?.join(", ") ?? ""})` : data}`);
    this.decoded = decoded;
    this.data = data;
  }
}

export class Chain {
  static async create({ start = 1_800_000_000n } = {}) {
    const common = new Common({ chain: ChainId.Mainnet, hardfork: Hardfork.Cancun });
    const vm = await VM.create({ common });
    return new Chain(vm, common, start);
  }

  constructor(vm, common, start) {
    this.vm = vm;
    this.common = common;
    this.time = start;
    this.number = 1n;
    this.nonces = new Map();
    this.abis = [];
  }

  get chainId() {
    return this.common.chainId();
  }

  /** A funded account with a private key derived from its label. */
  async account(label, ether = 100n) {
    const privateKey = hexToBytes(keccak256(toHex(`gavel demo ${label}`)));
    const address = new Address(privateToAddress(privateKey));
    await this.vm.stateManager.putAccount(address, new Account(0n, ether * 10n ** 18n));
    return { label, privateKey, address: address.toString() };
  }

  /** Moves the clock forward. */
  warp(seconds) {
    this.time += BigInt(seconds);
  }

  async balance(address) {
    const account = await this.vm.stateManager.getAccount(Address.fromString(address));
    return account?.balance ?? 0n;
  }

  // Gas is free (base fee and gas price 0), so ETH balances move only by
  // what the contracts pay; the gas used is reported per transaction.
  block() {
    const header = { number: this.number++, timestamp: this.time, gasLimit: 60_000_000n, baseFeePerGas: 0n };
    return Block.fromBlockData({ header }, { common: this.common });
  }

  async transact(from, { to, data, value = 0n, gasLimit = 30_000_000n }) {
    const nonce = this.nonces.get(from.address) ?? 0n;
    const tx = LegacyTransaction.fromTxData(
      { nonce, gasPrice: 0n, gasLimit, to, value, data: hexToBytes(data) },
      { common: this.common },
    ).sign(from.privateKey);
    const result = await this.vm.runTx({ tx, block: this.block() });
    this.nonces.set(from.address, nonce + 1n);
    return result;
  }

  async deploy(from, art, args = []) {
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    const result = await this.transact(from, { data });
    this.check(result, `deploy ${art.name}`, art.abi);
    this.abis.push(art.abi);
    return { name: art.name, abi: art.abi, address: result.createdAddress.toString(), gasUsed: result.totalGasSpent };
  }

  /** Sends a transaction calling `fn` and returns its result, events and gas. */
  async send(from, contract, fn, args = [], { value = 0n } = {}) {
    const data = encodeFunctionData({ abi: contract.abi, functionName: fn, args });
    const result = await this.transact(from, { to: Address.fromString(contract.address), data, value });
    this.check(result, `${from.label} → ${contract.name}.${fn}`, contract.abi);
    const returned = decodeFunctionResult({
      abi: contract.abi,
      functionName: fn,
      data: bytesToHex(result.execResult.returnValue),
    });
    return { returned, events: this.events(result), gasUsed: result.totalGasSpent };
  }

  /** Like `send`, but returns the decoded custom error instead of throwing. */
  async sendExpectingRevert(from, contract, fn, args = [], { value = 0n } = {}) {
    const data = encodeFunctionData({ abi: contract.abi, functionName: fn, args });
    const result = await this.transact(from, { to: Address.fromString(contract.address), data, value });
    if (!result.execResult.exceptionError) {
      throw new Error(`${contract.name}.${fn} was expected to revert`);
    }
    return this.decodeRevert(contract.abi, result);
  }

  /** A read-only call at the current time. */
  async call(contract, fn, args = []) {
    const data = encodeFunctionData({ abi: contract.abi, functionName: fn, args });
    const result = await this.vm.evm.runCall({
      to: Address.fromString(contract.address),
      caller: Address.zero(),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      block: Block.fromBlockData({ header: { number: this.number, timestamp: this.time } }, { common: this.common }),
    });
    if (result.execResult.exceptionError) {
      throw new RevertError(`${contract.name}.${fn}`, this.decodeRevert(contract.abi, result), bytesToHex(result.execResult.returnValue));
    }
    return decodeFunctionResult({ abi: contract.abi, functionName: fn, data: bytesToHex(result.execResult.returnValue) });
  }

  check(result, label, abi) {
    if (result.execResult.exceptionError) {
      throw new RevertError(label, this.decodeRevert(abi, result), bytesToHex(result.execResult.returnValue));
    }
  }

  decodeRevert(abi, result) {
    const data = bytesToHex(result.execResult.returnValue);
    try {
      return decodeErrorResult({ abi, data });
    } catch {
      return { errorName: "unknown", args: [data] };
    }
  }

  events(result) {
    const decoded = [];
    for (const [, topics, data] of result.receipt.logs) {
      for (const abi of this.abis) {
        try {
          decoded.push(decodeEventLog({ abi, data: bytesToHex(data), topics: topics.map(bytesToHex) }));
          break;
        } catch {
          // not this contract's event
        }
      }
    }
    return decoded;
  }
}

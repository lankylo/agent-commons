import { describe, expect, it } from "vitest";
import { httpRpc, RPC_RETRY_DELAYS_MS, RpcError } from "../src/payments/chain";

const RPC_URL = "https://rpc.example.org";

/** A fake fetch that answers each call with the next reply (an Error is a network failure). */
function scripted(...replies: (() => Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!();
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  return { calls, slept, rpc: httpRpc(RPC_URL, fetchImpl, { sleep }) };
}

const result = (value: unknown) => () => Response.json({ jsonrpc: "2.0", id: 1, result: value });
const rpcError = () => () =>
  Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit" } });
const status = (code: number) => () => new Response("x", { status: code });

describe("JSON-RPC transport", () => {
  it("posts JSON-RPC with a redirect mode that Cloudflare Workers accept", async () => {
    const { calls, rpc, slept } = scripted(result("0x14a34"));
    await expect(rpc("eth_chainId", [])).resolves.toBe("0x14a34");
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
    expect(calls[0]!.url).toBe(RPC_URL);
    // Workers throw on redirect: "error"; only "follow" and "manual" are supported.
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    });
  });

  it("retries throttling, server errors, network failures and JSON-RPC errors", async () => {
    for (const first of [status(429), status(503), () => new Error("reset"), rpcError()]) {
      const { calls, rpc, slept } = scripted(first, result("0x1"));
      await expect(rpc("eth_blockNumber", [])).resolves.toBe("0x1");
      expect(calls).toHaveLength(2);
      expect(slept).toEqual([RPC_RETRY_DELAYS_MS[0]]);
    }
  });

  it("gives up after two retries", async () => {
    const { calls, rpc, slept } = scripted(status(429));
    await expect(rpc("eth_blockNumber", [])).rejects.toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([...RPC_RETRY_DELAYS_MS]);
  });

  it("never retries redirects or other client errors", async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } });
    for (const reply of [redirect, status(400), status(403)]) {
      const { calls, rpc, slept } = scripted(reply, result("0x1"));
      await expect(rpc("eth_blockNumber", [])).rejects.toBeInstanceOf(RpcError);
      expect(calls).toHaveLength(1);
      expect(slept).toEqual([]);
    }
  });

  it("returns null for a missing result", async () => {
    const { rpc } = scripted(result(null));
    await expect(rpc("eth_getTransactionReceipt", ["0x00"])).resolves.toBeNull();
  });
});

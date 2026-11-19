import { describe, expect, it } from "vitest";
import { httpRpc, RpcError } from "../src/payments/chain";

const RPC_URL = "https://rpc.example.org";

function recorder(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("JSON-RPC transport", () => {
  it("posts JSON-RPC with a redirect mode that Cloudflare Workers accept", async () => {
    const { calls, fetchImpl } = recorder(
      Response.json({ jsonrpc: "2.0", id: 1, result: "0x14a34" }),
    );
    await expect(httpRpc(RPC_URL, fetchImpl)("eth_chainId", [])).resolves.toBe("0x14a34");
    expect(calls).toHaveLength(1);
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

  it("refuses redirects, HTTP errors and JSON-RPC errors", async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }),
      new Response("rate limited", { status: 429 }),
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }),
    ]) {
      const { fetchImpl } = recorder(response);
      await expect(httpRpc(RPC_URL, fetchImpl)("eth_blockNumber", [])).rejects.toBeInstanceOf(
        RpcError,
      );
    }
  });

  it("returns null for a missing result", async () => {
    const { fetchImpl } = recorder(Response.json({ jsonrpc: "2.0", id: 1, result: null }));
    await expect(
      httpRpc(RPC_URL, fetchImpl)("eth_getTransactionReceipt", ["0x00"]),
    ).resolves.toBeNull();
  });
});

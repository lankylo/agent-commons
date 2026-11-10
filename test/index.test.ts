import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("returns ok on /health", async () => {
    const res = await worker.fetch(new Request("https://example.com/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "agent-commons" });
  });

  it("returns 404 for unknown paths", async () => {
    const res = await worker.fetch(new Request("https://example.com/x"));
    expect(res.status).toBe(404);
  });
});

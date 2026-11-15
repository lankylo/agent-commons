import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const DOMAIN = "commons.example.org";
const MESSAGE = [
  "commons.example.org wants you to sign in with your Ethereum account:",
  "0x0000000000000000000000000000000000000001",
  "",
  "Sign in to Agent Commons.",
  "",
  "URI: https://commons.example.org/",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: 0123456789abcdef",
  "Issued At: 2026-11-15T12:00:00.000Z",
  "Expiration Time: 2026-11-15T12:05:00.000Z",
].join("\n");
const CREDENTIAL = `ac1_${"a".repeat(24)}_${"b".repeat(64)}`;
const env = {
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: DOMAIN,
  ENROLLMENT_URI: `https://${DOMAIN}/`,
  ENROLLMENT_CHAIN_ID: "1",
};

async function get(path: string, values: Record<string, unknown> = env) {
  return worker.fetch(new Request(`https://${DOMAIN}${path}`), values as never);
}

describe("wallet enrollment page: serving and headers", () => {
  it("is unavailable unless enrollment is enabled", async () => {
    for (const disabled of [{}, { ...env, ENROLLMENT: "off" }]) {
      for (const path of ["/pilot/enroll", "/pilot/enroll.js"]) {
        const response = await get(path, disabled);
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    }

    const invalid = await get("/pilot/enroll", { ...env, ENROLLMENT_CHAIN_ID: "0" });
    expect(invalid.status).toBe(503);
    expect(invalid.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves same-origin assets with no-store and a restrictive CSP", async () => {
    const page = await get("/pilot/enroll");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(page.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
    expect(page.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).toContain('<script src="/pilot/enroll.js" defer></script>');
    expect(html).not.toMatch(/https?:\/\//);

    const script = await get("/pilot/enroll.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Cache-Control")).toBe("no-store");
    expect(script.headers.get("Content-Security-Policy")).toBe(
      page.headers.get("Content-Security-Policy"),
    );
    expect(script.headers.get("Content-Type")).toContain("javascript");
  });
});

interface BrowserOptions {
  readonly chainId?: string;
  readonly expiresAt?: string;
  readonly completeResponse?: { status: number; body: Record<string, unknown> };
  readonly rejectSignature?: boolean;
  readonly serverError?: boolean;
}

async function runBrowser(options: BrowserOptions = {}) {
  const asset = await get("/pilot/enroll.js");
  const source = await asset.text();
  const ids = [
    "start",
    "challenge",
    "message",
    "network",
    "check-network",
    "sign",
    "status",
    "issued",
    "credential",
    "copy",
    "save",
  ];
  const elements = new Map(
    ids.map((id) => [
      id,
      {
        textContent: "",
        value: "",
        hidden: id === "challenge" || id === "issued" || id === "check-network",
        disabled: id === "sign",
        selected: false,
        download: "",
        href: "",
        handlers: new Map<string, () => unknown>(),
        addEventListener(type: string, handler: () => unknown) {
          this.handlers.set(type, handler);
        },
        async click() {
          return await this.handlers.get("click")?.();
        },
        select() {
          this.selected = true;
        },
      },
    ]),
  );
  const calls: { method: string; params?: unknown[] }[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let chainId = options.chainId ?? "0x1";
  let copied = "";
  let savedBlob: Blob | undefined;
  let savedLink: { href: string; download: string; click(): void } | undefined;
  const account = "0x0000000000000000000000000000000000000001";
  const provider = {
    async request(request: { method: string; params?: unknown[] }) {
      calls.push(request);
      if (request.method === "eth_requestAccounts") return [account];
      if (request.method === "eth_chainId") return chainId;
      if (request.method === "personal_sign") {
        if (options.rejectSignature) throw { code: 4001 };
        return "0xsignature";
      }
      throw new Error("Unexpected wallet request");
    },
  };
  const apiFetch = async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    requests.push({ path, body });
    if (path.endsWith("/challenge")) {
      if (options.serverError) {
        return {
          ok: false,
          async json() {
            return { error: { code: "internal_error", message: "Enrollment is unavailable." } };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { message: MESSAGE, expiresAt: options.expiresAt ?? "2099-01-01T00:00:00.000Z" };
        },
      };
    }
    const result = options.completeResponse ?? {
      status: 201,
      body: {
        status: "enrolled",
        credentialIssued: true,
        credential: { token: CREDENTIAL },
      },
    };
    return {
      ok: result.status >= 200 && result.status < 300,
      async json() {
        return result.body;
      },
    };
  };
  const context = {
    window: { ethereum: provider },
    document: {
      getElementById(id: string) {
        const element = elements.get(id);
        if (!element) throw new Error(`Unknown element ${id}`);
        return element;
      },
      createElement() {
        savedLink = {
          href: "",
          download: "",
          click() {},
        };
        return savedLink;
      },
    },
    navigator: {
      clipboard: {
        async writeText(value: string) {
          copied = value;
        },
      },
    },
    fetch: apiFetch,
    URL: {
      createObjectURL(blob: Blob) {
        savedBlob = blob;
        return "blob:credential-download";
      },
      revokeObjectURL() {},
    },
    Blob,
    localStorage: {
      getItem() {
        throw new Error("browser storage must not be used");
      },
      setItem() {
        throw new Error("browser storage must not be used");
      },
    },
    sessionStorage: {
      getItem() {
        throw new Error("browser storage must not be used");
      },
      setItem() {
        throw new Error("browser storage must not be used");
      },
    },
  };
  runInNewContext(source, context);
  const element = (id: string) => {
    const result = elements.get(id);
    if (!result) throw new Error(`Unknown element ${id}`);
    return result;
  };

  return {
    account,
    calls,
    requests,
    element,
    setChainId(value: string) {
      chainId = value;
    },
    async start() {
      await element("start").click();
    },
    async checkNetwork() {
      await element("check-network").click();
    },
    async sign() {
      await element("sign").click();
    },
    async copy() {
      await element("copy").click();
      return copied;
    },
    async save() {
      await element("save").click();
      return { blob: savedBlob, link: savedLink };
    },
  };
}

describe("wallet enrollment page: browser flow", () => {
  it("shows the exact challenge before signing, completes via the REST endpoints, and offers copy/save", async () => {
    const browser = await runBrowser();
    await browser.start();

    expect(browser.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
    ]);
    expect(browser.requests[0]).toEqual({
      path: "/v1/enroll/challenge",
      body: { address: browser.account, purpose: "enroll" },
    });
    expect(browser.element("message").textContent).toBe(MESSAGE);
    expect(browser.element("sign").disabled).toBe(false);
    expect(browser.element("status").textContent).toContain("Review");

    await browser.sign();
    expect(browser.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "eth_chainId",
      "personal_sign",
    ]);
    expect(browser.calls[3]?.params).toEqual([MESSAGE, browser.account]);
    expect(browser.requests[1]).toEqual({
      path: "/v1/enroll/complete",
      body: { message: MESSAGE, signature: "0xsignature" },
    });
    expect(browser.element("credential").value).toBe(CREDENTIAL);
    expect(await browser.copy()).toBe(CREDENTIAL);
    const saved = await browser.save();
    expect(saved.link?.download).toBe("agent-commons-credential.txt");
    expect(await saved.blob?.text()).toBe(`${CREDENTIAL}\n`);
    expect(browser.requests.some((request) => JSON.stringify(request).includes(CREDENTIAL))).toBe(
      false,
    );
  });

  it("blocks signing on the wrong network until the wallet is switched", async () => {
    const browser = await runBrowser({ chainId: "0x89" });
    await browser.start();
    expect(browser.element("network").textContent).toContain("Wrong network");
    expect(browser.element("sign").disabled).toBe(true);

    browser.setChainId("0x1");
    await browser.checkNetwork();
    expect(browser.element("sign").disabled).toBe(false);
    await browser.sign();
    expect(browser.requests.some((request) => request.path.endsWith("/complete"))).toBe(true);
  });

  it("reports rejected signatures without submitting them", async () => {
    const browser = await runBrowser({ rejectSignature: true });
    await browser.start();
    await browser.sign();
    expect(browser.element("status").textContent).toContain("request was rejected");
    expect(browser.element("sign").disabled).toBe(false);
    expect(browser.requests.some((request) => request.path.endsWith("/complete"))).toBe(false);
  });

  it("does not sign an expired challenge", async () => {
    const browser = await runBrowser({ expiresAt: "2000-01-01T00:00:00.000Z" });
    await browser.start();
    await browser.sign();
    expect(browser.element("status").textContent).toContain("expired");
    expect(browser.calls.some((call) => call.method === "personal_sign")).toBe(false);
  });

  it("explains already-enrolled and server-error responses without exposing a credential", async () => {
    const already = await runBrowser({
      completeResponse: {
        status: 200,
        body: { status: "already_enrolled", credentialIssued: false },
      },
    });
    await already.start();
    await already.sign();
    expect(already.element("status").textContent).toContain("already enrolled");
    expect(already.element("credential").value).toBe("");

    const serverError = await runBrowser({ serverError: true });
    await serverError.start();
    expect(serverError.element("status").textContent).toContain("server problem");
    expect(serverError.requests.some((request) => request.path.endsWith("/complete"))).toBe(false);
  });

  it("explains expired challenges and completion server errors", async () => {
    const expired = await runBrowser({
      completeResponse: {
        status: 401,
        body: {
          error: {
            code: "challenge_expired",
            message: "The sign-in challenge has expired.",
          },
        },
      },
    });
    await expired.start();
    await expired.sign();
    expect(expired.element("status").textContent).toContain("expired");
    expect(expired.element("credential").value).toBe("");

    const failedCompletion = await runBrowser({
      completeResponse: {
        status: 500,
        body: { error: { code: "internal_error", message: "Enrollment is unavailable." } },
      },
    });
    await failedCompletion.start();
    await failedCompletion.sign();
    expect(failedCompletion.element("status").textContent).toContain("server problem");
    expect(failedCompletion.element("credential").value).toBe("");
  });
});

/**
 * Operator actions page for enrolled wallets (Phase 6): sign the operator's spending policy, a
 * spending suspension, or a payout approval with MetaMask or another EVM wallet, without scripts.
 *
 * Same security posture as the enrollment page: same-origin script only, a strict Content
 * Security Policy, no cookies, and only `personal_sign` (never a transaction). The request JSON
 * the operator reviews is sent unchanged to both the challenge and the submit endpoint, so the
 * signed message is bound to exactly what was shown.
 */
import { resolveEnrollmentConfig, type EnrollmentEnv } from "./routes";

const PAGE_PATH = "/pilot/operator";
const SCRIPT_PATH = "/pilot/operator.js";
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Operator actions - Agent Commons</title>
    <script src="${SCRIPT_PATH}" defer></script>
  </head>
  <body>
    <main>
      <h1>Operator actions</h1>
      <p>Sign an action for the operator bound to your enrolled wallet: set its USDC spending policy, suspend or resume spending, or approve or reject a payout. Signing is not a transaction and costs nothing. This page never asks for a seed phrase, private key, approval or payment.</p>
      <p>Amounts are USDC base units: 1 USDC is 1000000.</p>
      <p>
        <label for="purpose">Action</label>
        <select id="purpose">
          <option value="spending-policy">Set spending policy</option>
          <option value="spending-suspension">Suspend or resume spending</option>
          <option value="payout-approval">Approve or reject a payout</option>
        </select>
      </p>
      <p><label for="request">Request (JSON)</label></p>
      <textarea id="request" rows="12" spellcheck="false" aria-label="Request JSON"></textarea>
      <p><button id="start" type="button">Connect wallet and get message</button></p>
      <p id="status" role="status" aria-live="polite"></p>
      <section id="challenge" hidden>
        <h2>Review the exact message</h2>
        <p>The statement summarizes your request, and the last resource line is the SHA-256 of the exact request. Check both before signing.</p>
        <pre id="message"></pre>
        <button id="sign" type="button">Sign message and submit</button>
      </section>
      <section id="result" hidden>
        <h2>Result</h2>
        <pre id="output"></pre>
      </section>
    </main>
  </body>
</html>`;

export const OPERATOR_CLIENT = `(function () {
  "use strict";

  var EXAMPLES = {
    "spending-policy": {
      currency: "USDC",
      perTransactionLimitMinor: 50000,
      dailyLimitMinor: 1000000,
      monthlyLimitMinor: 10000000,
      minimumReserveMinor: 0,
      maxAutonomousBalanceMinor: 100000000,
      permittedCategories: ["knowledge", "execution"],
      withdrawalsNeedApproval: true
    },
    "spending-suspension": { action: "suspend", agentId: null, reason: "Describe why" },
    "payout-approval": { requestId: 1, decision: "approve" }
  };
  var SUBMIT = {
    "spending-policy": "/v1/enroll/spending-policy",
    "spending-suspension": "/v1/enroll/spending-suspension",
    "payout-approval": "/v1/enroll/payout-approval"
  };

  var purposeElement = document.getElementById("purpose");
  var requestElement = document.getElementById("request");
  var startButton = document.getElementById("start");
  var signButton = document.getElementById("sign");
  var statusElement = document.getElementById("status");
  var challengeSection = document.getElementById("challenge");
  var messageElement = document.getElementById("message");
  var resultSection = document.getElementById("result");
  var outputElement = document.getElementById("output");
  var provider = null;
  var account = null;
  var pending = null;

  function setStatus(text) {
    statusElement.textContent = text;
  }

  function showExample() {
    requestElement.value = JSON.stringify(EXAMPLES[purposeElement.value], null, 2);
    challengeSection.hidden = true;
    pending = null;
  }

  async function post(path, body) {
    var response;
    try {
      response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
    } catch (e) {
      throw new Error("Could not reach the service. Check your connection and try again.");
    }
    var result;
    try {
      result = await response.json();
    } catch (e) {
      throw new Error("The service returned an unreadable response.");
    }
    if (!response.ok) {
      var error = result && result.error;
      throw new Error((error && error.code ? error.code + ": " : "") + (error && error.message ? error.message : "Request failed."));
    }
    return result;
  }

  function describe(error) {
    if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
      return "The wallet request was rejected. Nothing was submitted.";
    }
    return error && error.message ? error.message : "The request could not be completed.";
  }

  purposeElement.addEventListener("change", showExample);
  showExample();

  startButton.addEventListener("click", async function () {
    startButton.disabled = true;
    challengeSection.hidden = true;
    resultSection.hidden = true;
    pending = null;
    try {
      var request;
      try {
        request = JSON.parse(requestElement.value);
      } catch (e) {
        setStatus("The request is not valid JSON.");
        return;
      }
      provider = window.ethereum;
      if (!provider || typeof provider.request !== "function") {
        setStatus("No EVM wallet provider was found. Install or enable MetaMask, then reload this page.");
        return;
      }
      setStatus("Connecting to your wallet...");
      var accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        setStatus("Your wallet did not return a selected account.");
        return;
      }
      account = accounts[0];
      setStatus("Requesting a message...");
      var purpose = purposeElement.value;
      var challenge = await post("/v1/enroll/spending-challenge", {
        address: account,
        purpose: purpose,
        request: request
      });
      pending = { purpose: purpose, request: request, message: challenge.message };
      messageElement.textContent = challenge.message;
      challengeSection.hidden = false;
      signButton.disabled = false;
      setStatus("Review the message for account " + account + ", then sign.");
    } catch (error) {
      setStatus(describe(error));
    } finally {
      startButton.disabled = false;
    }
  });

  signButton.addEventListener("click", async function () {
    if (!pending || !account) return;
    signButton.disabled = true;
    setStatus("Confirm the message in your wallet. No transaction or payment is needed.");
    try {
      var signature = await provider.request({
        method: "personal_sign",
        params: [pending.message, account]
      });
      var result = await post(SUBMIT[pending.purpose], {
        message: pending.message,
        signature: signature,
        request: pending.request
      });
      outputElement.textContent = JSON.stringify(result, null, 2);
      resultSection.hidden = false;
      challengeSection.hidden = true;
      pending = null;
      setStatus("Done.");
    } catch (error) {
      setStatus(describe(error));
      signButton.disabled = false;
    }
  });
})();`;

const securityHeaders = (contentType: string): Headers =>
  new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });

/** Serves the page and its script while wallet enrollment is on; null for other paths. */
export function handleOperatorPage(request: Request, env: EnrollmentEnv): Response | null {
  const { pathname } = new URL(request.url);
  if (pathname !== PAGE_PATH && pathname !== SCRIPT_PATH) return null;
  const unavailable = (status: number) =>
    new Response(status === 404 ? "Not found." : "Operator actions are unavailable.", {
      status,
      headers: securityHeaders("text/plain; charset=utf-8"),
    });
  if (request.method !== "GET") return unavailable(404);
  const config = resolveEnrollmentConfig(env);
  if (config === false) return unavailable(404);
  if (config === null) return unavailable(503);
  const isScript = pathname === SCRIPT_PATH;
  return new Response(isScript ? OPERATOR_CLIENT : PAGE, {
    status: 200,
    headers: securityHeaders(
      isScript ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
    ),
  });
}

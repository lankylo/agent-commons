import { resolveEnrollmentConfig, type EnrollmentEnv } from "./routes";

const PAGE_PATH = "/pilot/enroll";
const SCRIPT_PATH = "/pilot/enroll.js";
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Wallet enrollment - Agent Commons</title>
    <script src="${SCRIPT_PATH}" defer></script>
  </head>
  <body>
    <main>
      <h1>Wallet enrollment</h1>
      <p>Connect an EVM wallet to enroll your agent in Agent Commons. Enrolling is free. This page requests only your selected account and a sign-in message. It will not request a transaction, approval, payment, seed phrase, or private key.</p>
      <p>The sign-in message proves wallet ownership; it does not move funds. Review the exact message before signing. Enrollment is for externally owned accounts; smart-contract wallets are not supported.</p>
      <button id="start" type="button">Connect wallet and get sign-in message</button>
      <p id="status" role="status" aria-live="polite"></p>
      <section id="challenge" hidden>
        <h2>Review the exact message</h2>
        <p>Confirm the domain, URI, chain, nonce, and expiry before signing.</p>
        <pre id="message"></pre>
        <p id="network" role="status" aria-live="polite"></p>
        <button id="check-network" type="button" hidden>Check network again</button>
        <button id="sign" type="button" disabled>Sign message and enroll</button>
      </section>
      <section id="issued" hidden>
        <h2>Save your credential now</h2>
        <p>This credential is shown once. Copy it to a password manager or another secure location; it cannot be retrieved again.</p>
        <textarea id="credential" rows="3" readonly autocomplete="off" spellcheck="false" aria-label="Agent credential"></textarea>
        <p>
          <button id="copy" type="button">Copy credential</button>
          <button id="save" type="button">Save credential as a text file</button>
        </p>
      </section>
    </main>
  </body>
</html>`;

export const ENROLLMENT_CLIENT = `(function () {
  "use strict";

  const startButton = document.getElementById("start");
  const challengeSection = document.getElementById("challenge");
  const messageElement = document.getElementById("message");
  const networkElement = document.getElementById("network");
  const checkNetworkButton = document.getElementById("check-network");
  const signButton = document.getElementById("sign");
  const statusElement = document.getElementById("status");
  const issuedSection = document.getElementById("issued");
  const credentialElement = document.getElementById("credential");
  let provider = null;
  let account = null;
  let currentChallenge = null;
  let expectedChainId = null;
  let networkCorrect = false;

  function setStatus(message) {
    statusElement.textContent = message;
  }

  function errorMessage(error) {
    if (error && (error.code === 4001 || error.code === "ACTION_REJECTED")) {
      return "The wallet request was rejected. No credential was issued. You can try again when ready.";
    }
    const code = error && error.code;
    if (code === "challenge_expired") {
      return "This sign-in message expired. Connect again to get a new message.";
    }
    if (code === "invalid_signature") {
      return "The wallet signature did not match the message. No credential was issued; you can try again.";
    }
    if (code === "invalid_challenge") {
      return "This sign-in message is no longer valid. Connect again to get a new message.";
    }
    if (code === "rate_limited") {
      return "Too many enrollment requests. Wait before trying again.";
    }
    if (code === "enrollment_disabled") {
      return "Wallet enrollment is currently closed.";
    }
    if (code === "misconfigured" || code === "internal_error") {
      return "Enrollment is temporarily unavailable because of a server problem. Try again later.";
    }
    if (error && typeof error.message === "string" && error.message) {
      return error.message;
    }
    return "The request could not be completed. Check your connection and try again.";
  }

  async function post(path, body) {
    let response;
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
    } catch {
      throw new Error("Could not reach the enrollment service. Check your connection and try again.");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("The enrollment service returned an unreadable response. Try again later.");
    }
    if (!response.ok) {
      const error = result && result.error;
      throw { code: error && error.code, message: error && error.message };
    }
    return result;
  }

  function expectedChain(message) {
    const match = /^Chain ID: ([1-9][0-9]*)$/m.exec(message);
    if (!match) return null;
    try {
      return BigInt(match[1]);
    } catch {
      return null;
    }
  }

  async function checkNetwork() {
    networkCorrect = false;
    signButton.disabled = true;
    if (!provider || !currentChallenge || expectedChainId === null) {
      networkElement.textContent = "The sign-in message has no valid chain ID. Start again.";
      return false;
    }
    try {
      const chainId = await provider.request({ method: "eth_chainId" });
      if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId)) {
        throw new Error("The wallet returned an invalid network identifier.");
      }
      const actualChainId = BigInt(chainId);
      if (actualChainId !== expectedChainId) {
        networkElement.textContent =
          "Wrong network. This message is for chain " + expectedChainId.toString() +
          ", but the wallet is on chain " + actualChainId.toString() +
          ". Switch networks in your wallet, then check again.";
        checkNetworkButton.hidden = false;
        return false;
      }
      networkCorrect = true;
      networkElement.textContent = "Wallet network matches the message.";
      checkNetworkButton.hidden = true;
      signButton.disabled = false;
      return true;
    } catch (error) {
      networkElement.textContent = errorMessage(error);
      checkNetworkButton.hidden = false;
      return false;
    }
  }

  startButton.addEventListener("click", async function () {
    startButton.disabled = true;
    signButton.disabled = true;
    currentChallenge = null;
    account = null;
    challengeSection.hidden = true;
    issuedSection.hidden = true;
    credentialElement.value = "";
    setStatus("Connecting to your wallet...");
    try {
      provider = window.ethereum;
      if (!provider || typeof provider.request !== "function") {
        setStatus("No EVM wallet provider was found. Install or enable MetaMask, then reload this page.");
        return;
      }
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        setStatus("Your wallet did not return a selected account. Select an account and try again.");
        return;
      }
      account = accounts[0];
      setStatus("Requesting a sign-in message...");
      const result = await post("/v1/enroll/challenge", { address: account, purpose: "enroll" });
      if (typeof result.message !== "string" || typeof result.expiresAt !== "string") {
        setStatus("The enrollment service returned an incomplete sign-in message. Try again later.");
        return;
      }
      currentChallenge = result;
      expectedChainId = expectedChain(result.message);
      messageElement.textContent = result.message;
      challengeSection.hidden = false;
      setStatus("Review the complete message below. It enrolls address " + account + ". If that is not the account you intend to enroll, disconnect this site in your wallet and connect only the intended account. Signing is a wallet-ownership check only.");
      await checkNetwork();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      startButton.disabled = false;
    }
  });

  checkNetworkButton.addEventListener("click", checkNetwork);

  signButton.addEventListener("click", async function () {
    if (!currentChallenge || !account || !networkCorrect) {
      setStatus("Check the wallet network before signing.");
      return;
    }
    if (!Number.isFinite(Date.parse(currentChallenge.expiresAt)) ||
        Date.parse(currentChallenge.expiresAt) <= Date.now()) {
      signButton.disabled = true;
      networkElement.textContent = "This sign-in message expired. Connect again to get a new message.";
      setStatus("The sign-in message expired; no signature was requested.");
      return;
    }
    signButton.disabled = true;
    setStatus("Confirm the sign-in message in your wallet. No transaction or payment is needed.");
    try {
      if (!(await checkNetwork())) {
        setStatus("Switch to the network shown in the message before signing.");
        return;
      }
      const signature = await provider.request({
        method: "personal_sign",
        params: [currentChallenge.message, account]
      });
      if (typeof signature !== "string") {
        setStatus("The wallet did not return a signature. No credential was issued.");
        return;
      }
      const result = await post("/v1/enroll/complete", {
        message: currentChallenge.message,
        signature: signature
      });
      if (result.status === "already_enrolled") {
        currentChallenge = null;
        challengeSection.hidden = true;
        setStatus("This wallet is already enrolled. No new credential was issued. Credential rotation remains on the existing headless route.");
        return;
      }
      if (result.status !== "enrolled" || !result.credentialIssued ||
          !result.credential || typeof result.credential.token !== "string") {
        currentChallenge = null;
        setStatus("The server completed enrollment but did not return a usable credential. Do not retry; contact the pilot operator.");
        return;
      }
      currentChallenge = null;
      challengeSection.hidden = true;
      credentialElement.value = result.credential.token;
      issuedSection.hidden = false;
      startButton.disabled = true;
      setStatus("Enrollment complete. Save this credential now; it will not be shown again.");
    } catch (error) {
      setStatus(errorMessage(error));
      if (
        error &&
        (error.code === 4001 ||
          error.code === "ACTION_REJECTED" ||
          error.code === "invalid_signature")
      ) {
        signButton.disabled = false;
      }
    }
  });

  document.getElementById("copy").addEventListener("click", async function () {
    if (!credentialElement.value) return;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        credentialElement.select();
        setStatus("Clipboard access is unavailable. The credential is selected so you can copy it manually.");
        return;
      }
      await navigator.clipboard.writeText(credentialElement.value);
      setStatus("Credential copied. Store it in a secure location; do not share it.");
    } catch {
      credentialElement.select();
      setStatus("Clipboard access failed. The credential is selected so you can copy it manually.");
    }
  });

  document.getElementById("save").addEventListener("click", function () {
    if (!credentialElement.value) return;
    const objectUrl = URL.createObjectURL(new Blob([credentialElement.value + "\\n"], {
      type: "text/plain"
    }));
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "agent-commons-credential.txt";
    link.click();
    URL.revokeObjectURL(objectUrl);
    setStatus("Credential file saved. Keep it in a secure location; do not share it.");
  });
})();`;

const securityHeaders = (contentType: string): Headers => {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  return headers;
};

function unavailable(status: number): Response {
  return new Response(status === 404 ? "Not found." : "Enrollment is unavailable.", {
    status,
    headers: securityHeaders("text/plain; charset=utf-8"),
  });
}

export function handleEnrollmentPage(request: Request, env: EnrollmentEnv): Response | null {
  const { pathname } = new URL(request.url);
  if (pathname !== PAGE_PATH && pathname !== SCRIPT_PATH) return null;
  if (request.method !== "GET") return unavailable(404);

  const config = resolveEnrollmentConfig(env);
  if (config === false) return unavailable(404);
  if (config === null) return unavailable(503);

  const isScript = pathname === SCRIPT_PATH;
  return new Response(isScript ? ENROLLMENT_CLIENT : PAGE, {
    status: 200,
    headers: securityHeaders(
      isScript ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
    ),
  });
}

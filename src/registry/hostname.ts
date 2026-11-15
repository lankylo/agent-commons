/** DNS hostname rules shared by Execution targets and Knowledge reference URLs. */
export const HOSTNAME =
  /^(?=.{1,254}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/;

// Static snapshot of the IANA registry, last updated 2026-05-22. Special use
// applies to each listed name and its subdomains; no DNS lookups are performed.
// Source: https://www.iana.org/assignments/special-use-domain-names/
export const IANA_SPECIAL_USE_DOMAINS = [
  "alt",
  "6tisch.arpa",
  "eap.arpa",
  "eap-noob.arpa",
  "home.arpa",
  "10.in-addr.arpa",
  "254.169.in-addr.arpa",
  "16.172.in-addr.arpa",
  "17.172.in-addr.arpa",
  "18.172.in-addr.arpa",
  "19.172.in-addr.arpa",
  "20.172.in-addr.arpa",
  "21.172.in-addr.arpa",
  "22.172.in-addr.arpa",
  "23.172.in-addr.arpa",
  "24.172.in-addr.arpa",
  "25.172.in-addr.arpa",
  "26.172.in-addr.arpa",
  "27.172.in-addr.arpa",
  "28.172.in-addr.arpa",
  "29.172.in-addr.arpa",
  "30.172.in-addr.arpa",
  "31.172.in-addr.arpa",
  "170.0.0.192.in-addr.arpa",
  "171.0.0.192.in-addr.arpa",
  "168.192.in-addr.arpa",
  "8.e.f.ip6.arpa",
  "9.e.f.ip6.arpa",
  "a.e.f.ip6.arpa",
  "b.e.f.ip6.arpa",
  "ipv4only.arpa",
  "resolver.arpa",
  "service.arpa",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "local",
  "localhost",
  "onion",
  "test",
] as const;

export function isIanaSpecialUseHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  return IANA_SPECIAL_USE_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

export function canonicalPublicHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !HOSTNAME.test(value)) return undefined;
  const hostname = value.toLowerCase().replace(/\.$/, "");
  return isIanaSpecialUseHostname(hostname) ? undefined : hostname;
}

# E1 implementation gate

E1's user-visible promise is Android access on mobile data without asking the user to edit router rules. The existing gateway is HTTP with Basic Auth. Its pairing claim returns those credentials over HTTP. Neither it nor an automatically mapped port may be exposed to the public Internet.

## Trust boundary

The Internet-facing listener must be distinct from the LAN HTTP listener. The current implementation direction uses TLS 1.3 with a persistent self-signed P-256 machine certificate. The phone obtains its DNS identity and SHA-256 SPKI pin from the local QR and validates both before sending a pairing token or request. Every request then carries a P-256 device signature over the machine identity, certificate pin, method, exact target, body digest, timestamp and fresh nonce. The gateway rejects replays and revoked devices before forwarding to the loopback HTTP daemon; an active SSE stream is closed on revocation. Pairing is the only unsigned route and accepts a bounded one-time token over the pinned TLS channel. No Basic credentials are returned by that route.

The P-256 key in Android Keystore, persistent registry, TLS identity, signed-request authenticator, HTTPS ingress and Android pin verifier are wired for a loopback-only preview. Android app requests, SSE and background attention can use the pinned signed path, and a separate QR pairs without returning Basic credentials. The public listener and router mapping remain disabled. The registry never authorizes the existing HTTP port. A reviewer must verify the complete pairing, TLS pin validation, signed transcript, nonce handling, bounds, rate limits, revocation and storage before any Internet listener or router mapping is enabled.

## Activation order

1. Complete and test the encrypted, mutually authenticated Android to gateway transport, including pairing and revocation UI. Include negative tests for missing, altered, replayed and revoked keys. Keep the legacy LAN path independent.
2. Close the independent security review of that path.
3. Only then enable IPv6 firewall rules and IPv4 UPnP-IGD/NAT-PMP/PCP leases. The mapping manager must verify the public address is globally routable and renew leases. It removes an owned UPnP or PCP mapping at shutdown; NAT-PMP has no ownership token, so its short lease expires without a destructive delete. A failed check must leave remote access off.
4. Add an address book, mobile-data reachability check, user-owned relay option and always-on host lifecycle. The app must explain CGNAT, blocked port mapping and missing IPv6 instead of claiming success.
5. Run the full Android mobile-data turn, Stop and permission flow, then the real-harness regression gate and manual Electron/Android checks described in `AGENTS.md`.

The E1 branch may contain inactive foundation code, but its UI, docs and PR must not call Internet access ready until every gate above is satisfied.

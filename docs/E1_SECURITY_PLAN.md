# E1 implementation gate

E1's user-visible promise is Android access on mobile data without asking the user to edit router rules. The existing gateway is HTTP with Basic Auth. Its pairing claim returns those credentials over HTTP. Neither it nor an automatically mapped port may be exposed to the public Internet.

## Trust boundary

The Internet-facing listener must be distinct from the LAN HTTP listener. It must accept only a bounded device-key handshake before authentication, then carry every request, SSE event and permission response over a channel encrypted and mutually authenticated with the paired device key. The phone pins the machine identity obtained through the local QR. An unpaired or revoked key must not reach the HTTP router or an agent. On every frame, check the in-memory revocation state before forwarding. A reconnect must establish fresh session keys and reject replayed handshake material.

The P-256 key in Android Keystore and the persistent paired-device registry are foundation pieces. They do not create a secure channel by themselves. The registry never authorizes the existing HTTP port. A reviewer must verify the exact handshake transcript, key derivation, nonce handling, bounds, rate limits, revocation and storage before any Internet listener or router mapping is enabled.

## Activation order

1. Complete and test the encrypted, mutually authenticated Android to gateway transport, including pairing and revocation UI. Include negative tests for missing, altered, replayed and revoked keys. Keep the legacy LAN path independent.
2. Close the independent security review of that path.
3. Only then enable IPv6 firewall rules and IPv4 UPnP-IGD/NAT-PMP/PCP leases. The mapping manager must verify the public address is globally routable, renew the lease and remove only its own mapping at shutdown. A failed check must leave remote access off.
4. Add an address book, mobile-data reachability check, user-owned relay option and always-on host lifecycle. The app must explain CGNAT, blocked port mapping and missing IPv6 instead of claiming success.
5. Run the full Android mobile-data turn, Stop and permission flow, then the real-harness regression gate and manual Electron/Android checks described in `AGENTS.md`.

The E1 branch may contain inactive foundation code, but its UI, docs and PR must not call Internet access ready until every gate above is satisfied.

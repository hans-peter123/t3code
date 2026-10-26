import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface NetbirdPeer {
  readonly name: string;
  readonly ip: string;
  readonly connected: boolean;
}

export interface NetbirdStatus {
  // CIDR form, e.g. "100.119.108.181/16". Null until the management server
  // has assigned an address.
  readonly ip: string | null;
  readonly peers: ReadonlyArray<NetbirdPeer>;
}

const NetbirdStatusJson = fromLenientJson(
  Schema.Struct({
    netbirdIp: Schema.optionalKey(Schema.String),
    peers: Schema.optionalKey(
      Schema.Struct({
        details: Schema.optionalKey(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                fqdn: Schema.optionalKey(Schema.String),
                netbirdIp: Schema.optionalKey(Schema.String),
                status: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
        ),
      }),
    ),
  }),
);
const decodeNetbirdStatusJson = Schema.decodeUnknownOption(NetbirdStatusJson);

/** Reads the output of `netbird status --json`. */
export function parseNetbirdStatus(raw: string): Option.Option<NetbirdStatus> {
  return decodeNetbirdStatusJson(raw).pipe(
    Option.map((status) => ({
      ip: status.netbirdIp && status.netbirdIp.length > 0 ? status.netbirdIp : null,
      peers: (status.peers?.details ?? []).flatMap((peer) =>
        peer.netbirdIp
          ? [
              {
                name: peer.fqdn?.split(".")[0] || peer.netbirdIp,
                ip: peer.netbirdIp,
                connected: peer.status === "Connected",
              },
            ]
          : [],
      ),
    })),
  );
}

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

const toDotted = (value: number) =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");

/**
 * Routes only the NetBird network through the userspace SOCKS proxy. A global
 * proxy would push app.t3.codes, updates and sign-in through the relay, which
 * has no exit to the internet. The IP-literal check keeps PAC from doing a DNS
 * lookup for every hostname the app requests.
 */
export function buildNetbirdPacScript(cidr: string, socksPort: number): Option.Option<string> {
  const match = IPV4_CIDR.exec(cidr.trim());
  if (!match) return Option.none();
  const octets = match.slice(1, 5).map(Number);
  const bits = Number(match[5]);
  if (octets.some((octet) => octet > 255) || bits > 32) return Option.none();
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (((a << 24) | (b << 16) | (c << 8) | d) & mask) >>> 0;
  return Option.some(
    [
      "function FindProxyForURL(url, host) {",
      `  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host) && isInNet(host, "${toDotted(network)}", "${toDotted(mask)}")) {`,
      `    return "SOCKS5 127.0.0.1:${socksPort}";`,
      "  }",
      '  return "DIRECT";',
      "}",
    ].join("\n"),
  );
}

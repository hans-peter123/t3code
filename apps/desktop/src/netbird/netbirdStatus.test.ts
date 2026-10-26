import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { buildNetbirdPacScript, parseNetbirdStatus } from "./netbirdStatus.ts";

const toNumber = (ip: string) =>
  ip.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);

// Chromium's PAC runtime, reduced to what the generated script calls.
function evaluatePac(script: string, host: string): string {
  const isInNet = (candidate: string, network: string, mask: string) =>
    (toNumber(candidate) & toNumber(mask)) >>> 0 === toNumber(network);
  const findProxy = new Function("isInNet", `${script}\nreturn FindProxyForURL;`)(isInNet);
  return findProxy(`http://${host}/`, host);
}

describe("buildNetbirdPacScript", () => {
  const script = Option.getOrThrow(buildNetbirdPacScript("100.119.108.181/16", 41080));

  it("sends only the NetBird network through the SOCKS proxy", () => {
    assert.strictEqual(evaluatePac(script, "100.119.116.62"), "SOCKS5 127.0.0.1:41080");
    assert.strictEqual(evaluatePac(script, "100.120.0.1"), "DIRECT");
    assert.strictEqual(evaluatePac(script, "127.0.0.1"), "DIRECT");
    assert.strictEqual(evaluatePac(script, "app.t3.codes"), "DIRECT");
  });

  it("rejects addresses that are not IPv4 CIDRs", () => {
    assert.isTrue(Option.isNone(buildNetbirdPacScript("100.119.108.181", 41080)));
    assert.isTrue(Option.isNone(buildNetbirdPacScript("300.1.1.1/16", 41080)));
    assert.isTrue(Option.isNone(buildNetbirdPacScript("fd00::1/64", 41080)));
  });
});

describe("parseNetbirdStatus", () => {
  it("reads the own address and peers from `netbird status --json`", () => {
    const status = parseNetbirdStatus(
      JSON.stringify({
        netbirdIp: "100.119.108.181/16",
        fqdn: "windows.netbird.selfhosted",
        management: { url: "https://muntean.cloud:443", connected: true },
        peers: {
          total: 2,
          connected: 1,
          details: [
            {
              fqdn: "checkmk-monitor.netbird.selfhosted",
              netbirdIp: "100.119.116.62",
              status: "Connected",
              connectionType: "Relayed",
            },
            { fqdn: "nexterm.netbird.selfhosted", netbirdIp: "100.119.43.153", status: "Idle" },
          ],
        },
      }),
    );
    assert.deepStrictEqual(
      status,
      Option.some({
        ip: "100.119.108.181/16",
        peers: [
          { name: "checkmk-monitor", ip: "100.119.116.62", connected: true },
          { name: "nexterm", ip: "100.119.43.153", connected: false },
        ],
      }),
    );
  });

  it("treats a peer without an address as not yet connected", () => {
    assert.deepStrictEqual(
      parseNetbirdStatus(JSON.stringify({ netbirdIp: "", peers: { details: null } })),
      Option.some({ ip: null, peers: [] }),
    );
    assert.isTrue(Option.isNone(parseNetbirdStatus("daemon is not running")));
  });
});

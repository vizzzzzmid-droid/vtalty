import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { REDACTED_PATHS, loggerOptions } from "../../src/lib/logger.js";

function captureLog(line: (log: pino.Logger) => void): string {
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const log = pino({ ...loggerOptions(), level: "info" }, sink);
  line(log);
  return output;
}

describe("log redaction", () => {
  it("declares redaction for all secret carriers", () => {
    expect([...REDACTED_PATHS]).toEqual(
      expect.arrayContaining([
        "req.headers.authorization",
        "req.query.ticket",
        "req.body.password",
        "res.headers.set-cookie",
      ]),
    );
  });

  it("redacts secrets from logged request/response objects", () => {
    const output = captureLog((log) => {
      log.info({
        req: {
          headers: { authorization: "Bearer super-secret-jwt" },
          query: { ticket: "single-use-ticket" },
          body: { username: "owner", password: "hunter2", inviteCode: "abc123" },
        },
        res: { headers: { "set-cookie": "vitality_refresh=xyz" } },
      });
    });
    for (const secret of [
      "super-secret-jwt",
      "single-use-ticket",
      "hunter2",
      "abc123",
      "vitality_refresh=xyz",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[Redacted]");
    // Non-secret fields survive redaction.
    expect(output).toContain("owner");
  });
});

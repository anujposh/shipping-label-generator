import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNotificationRecipients,
  resolveRecipients,
  resolveSmtpIdentity,
} from "../../src/core/mailer";

describe("mailer helpers", () => {
  it("resolveRecipients deduplicates case-insensitively", () => {
    const result = resolveRecipients("A@EXAMPLE.COM", "a@example.com");
    assert.deepEqual(result, ["A@EXAMPLE.COM"]);
  });

  it("resolveRecipients preserves order skips blanks", () => {
    const result = resolveRecipients("first@example.com", " ");
    assert.deepEqual(result, ["first@example.com"]);
  });

  it("resolveRecipients returns empty both missing", () => {
    const result = resolveRecipients(undefined, undefined);
    assert.deepEqual(result, []);
  });

  it("resolveRecipients includes both distinct emails", () => {
    const result = resolveRecipients("first@example.com", "second@example.com");
    assert.deepEqual(result, ["first@example.com", "second@example.com"]);
  });

  it("resolveNotificationRecipients collects all three emails", () => {
    const result = resolveNotificationRecipients({
      recipientEmail: "recipient@example.com",
      shipperEmail: "shipper@example.com",
      additionalEmail: "additional@example.com",
    });
    assert.deepEqual(result, [
      "recipient@example.com",
      "shipper@example.com",
      "additional@example.com",
    ]);
  });

  it("resolveNotificationRecipients deduplicates case-insensitively", () => {
    const result = resolveNotificationRecipients({
      recipientEmail: "A@EXAMPLE.COM",
      shipperEmail: "a@example.com",
      additionalEmail: "b@example.com",
    });
    assert.deepEqual(result, ["A@EXAMPLE.COM", "b@example.com"]);
  });

  it("resolveNotificationRecipients trims and skips blanks", () => {
    const result = resolveNotificationRecipients({
      recipientEmail: "  first@example.com  ",
      shipperEmail: " ",
      additionalEmail: undefined,
    });
    assert.deepEqual(result, ["first@example.com"]);
  });

  it("resolveNotificationRecipients returns empty when all missing", () => {
    const result = resolveNotificationRecipients({});
    assert.deepEqual(result, []);
  });
});

describe("resolveSmtpIdentity (per-company mail credentials)", () => {
  const saved: string[] = [
    "POSH_SMTP_USER",
    "POSH_SMTP_PASSWORD",
    "POSH_SMTP_FROM",
    "SILK_SMTP_USER",
    "SILK_SMTP_PASSWORD",
    "SILK_SMTP_FROM",
  ];
  const snapshot = Object.fromEntries(
    saved.map((key) => [key, process.env[key]]),
  );

  function restore() {
    for (const key of saved) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }

  it("selects the Posh identity for Posh Textiles links", () => {
    process.env.POSH_SMTP_USER = "marketing@poshtextiles.com";
    process.env.POSH_SMTP_PASSWORD = "pw";
    process.env.POSH_SMTP_FROM = "info@poshtextiles.com";
    try {
      const { identity, key } = resolveSmtpIdentity("Posh Textiles Inc.");
      assert.equal(key, "posh");
      assert.equal(identity.user, "marketing@poshtextiles.com");
      assert.equal(identity.from, "info@poshtextiles.com");
    } finally {
      restore();
    }
  });

  it("selects the Silk identity for Silk Crafts links", () => {
    process.env.SILK_SMTP_USER = "ar@silk-crafts.com";
    process.env.SILK_SMTP_PASSWORD = "pw";
    process.env.SILK_SMTP_FROM = "customerservice@silk-crafts.com";
    try {
      const { identity, key } = resolveSmtpIdentity("Silk Crafts, Inc.");
      assert.equal(key, "silk");
      assert.equal(identity.user, "ar@silk-crafts.com");
      assert.equal(identity.from, "customerservice@silk-crafts.com");
    } finally {
      restore();
    }
  });

  it("falls back to the generic identity when company credentials lack a password", () => {
    process.env.POSH_SMTP_USER = "marketing@poshtextiles.com";
    delete process.env.POSH_SMTP_PASSWORD;
    try {
      const { key } = resolveSmtpIdentity("Posh Textiles Inc.");
      assert.equal(key, "default");
    } finally {
      restore();
    }
  });

  it("falls back to the generic identity for unknown companies", () => {
    const { key } = resolveSmtpIdentity("Some Other Corp");
    assert.equal(key, "default");
  });
});

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "../config";

export interface NotificationMail {
  to: string[];
  carrier: string;
  serviceType: string;
  trackingNumber: string;
  shipToCity?: string;
  shipToState?: string;
  shipToCountry?: string;
  vendorName: string;
  companyName?: string;
  personalMessage?: string;
  /** Label PDF + trade documents, base64-encoded, attached to the email. */
  attachments?: Array<{ fileName: string; contentBase64: string }>;
  /**
   * BC company owning the link ("Posh Textiles Inc.", "Silk Crafts,
   * Inc.", ...). Selects the per-company SMTP identity for sending.
   */
  sendingCompany?: string | null;
}

/** Nodemailer/Mailgun ceiling guard: keep the whole message under ~20 MB. */
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function toNodemailerAttachments(
  attachments: NotificationMail["attachments"],
): Array<{ filename: string; content: Buffer }> {
  const result: Array<{ filename: string; content: Buffer }> = [];
  let total = 0;
  for (const attachment of attachments ?? []) {
    if (!attachment.fileName || !attachment.contentBase64) continue;
    const content = Buffer.from(attachment.contentBase64, "base64");
    if (content.length === 0 || total + content.length > MAX_TOTAL_ATTACHMENT_BYTES)
      continue;
    total += content.length;
    result.push({ filename: attachment.fileName, content });
  }
  return result;
}

export interface Mailer {
  sendNotificationMail(mail: NotificationMail): Promise<void>;
}

export function resolveRecipients(
  contactEmail: string | undefined,
  notificationEmail: string | undefined,
): string[] {
  const raw = [contactEmail, notificationEmail].filter(
    (e): e is string => typeof e === "string" && e.trim().length > 0,
  );
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const email of raw) {
    const lower = email.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      deduped.push(email);
    }
  }
  return deduped;
}

export interface ResolveNotificationRecipientsInput {
  recipientEmail?: string;
  shipperEmail?: string;
  additionalEmail?: string;
}

export function resolveNotificationRecipients(
  input: ResolveNotificationRecipientsInput,
): string[] {
  const raw = [input.recipientEmail, input.shipperEmail, input.additionalEmail]
    .filter(
      (e): e is string => typeof e === "string" && e.trim().length > 0,
    )
    .map((e) => e.trim());
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const email of raw) {
    const lower = email.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      deduped.push(email);
    }
  }
  return deduped;
}

function buildNotificationText(mail: NotificationMail): string {
  const lines: string[] = [
    `Hi ${mail.vendorName},`,
    "",
    "Your shipping label is ready.",
    "",
  ];

  if (mail.personalMessage !== undefined) {
    lines.push("Personal message:");
    lines.push(mail.personalMessage);
    lines.push("");
  }

  lines.push(`Carrier: ${mail.carrier}`);
  lines.push(`Service: ${mail.serviceType}`);
  lines.push(`Tracking number: ${mail.trackingNumber}`);

  const shipToParts = [
    mail.shipToCity,
    mail.shipToState,
    mail.shipToCountry,
  ].filter(Boolean);
  if (shipToParts.length > 0) {
    lines.push(`Ship to: ${shipToParts.join(", ")}`);
  }

  lines.push("");
  if (mail.attachments && mail.attachments.length > 0) {
    lines.push("Your shipping label and documents are attached to this email.");
  }
  lines.push("Download your label from your private shipping link page.");

  return lines.join("\n");
}

/**
 * Company-specific SMTP identity resolution. Links carry a BC company name
 * (e.g. "Posh Textiles Inc.", "Silk Crafts, Inc."); notification mail must
 * be sent from that company's own mailbox/credentials when configured.
 * Env contract (all optional, host/port/secure stay global):
 *   POSH_SMTP_USER / POSH_SMTP_PASSWORD / POSH_SMTP_FROM
 *   SILK_SMTP_USER / SILK_SMTP_PASSWORD / SILK_SMTP_FROM
 * Unmatched or partially-configured companies fall back to the generic
 * SMTP_USER / SMTP_PASSWORD / SMTP_FROM identity.
 */
export type SmtpIdentity = {
  user: string;
  password: string;
  from: string;
};

function identityFor(prefix: "POSH" | "SILK"): SmtpIdentity | null {
  const user = process.env[`${prefix}_SMTP_USER`] || "";
  const password = process.env[`${prefix}_SMTP_PASSWORD`] || "";
  const from = process.env[`${prefix}_SMTP_FROM`] || "";
  // Only treat as configured when it can actually authenticate and
  // identify a sender; a user without password would 530 anyway.
  return user && password ? { user, password, from } : null;
}

export function resolveSmtpIdentity(
  companyName: string | undefined | null,
): { identity: SmtpIdentity; key: string } {
  const name = (companyName || "").toLowerCase();
  if (name.includes("silk")) {
    const silk = identityFor("SILK");
    if (silk) return { identity: silk, key: "silk" };
  }
  if (name.includes("posh")) {
    const posh = identityFor("POSH");
    if (posh) return { identity: posh, key: "posh" };
  }
  return {
    identity: {
      user: config.smtpUser,
      password: config.smtpPassword,
      from: config.smtpFrom,
    },
    key: "default",
  };
}

export function createSmtpMailer(): Mailer {
  const transports = new Map<string, Transporter>();

  return {
    async sendNotificationMail(mail: NotificationMail): Promise<void> {
      if (!isSmtpConfigured()) {
        throw new Error("SMTP is not configured");
      }

      // Company hint comes from the link's BC company (set by admin at
      // link creation), NOT the vendor's own company name.
      const { identity, key } = resolveSmtpIdentity(
        (mail as NotificationMail & { sendingCompany?: string })
          .sendingCompany,
      );

      let transport = transports.get(key);
      if (transport === undefined) {
        transport = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpSecure,
          auth:
            identity.user || identity.password
              ? { user: identity.user, pass: identity.password }
              : undefined,
        });
        transports.set(key, transport);
      }

      const fromName = "Shipping Label Generator";
      const from = identity.from
        ? `"${fromName}" <${identity.from}>`
        : fromName;

      await transport.sendMail({
        from,
        to: mail.to.join(", "),
        subject: `Your shipping label is ready — tracking ${mail.trackingNumber}`,
        text: buildNotificationText(mail),
        attachments: toNodemailerAttachments(mail.attachments),
      });
    },
  };
}

export function isSmtpConfigured(): boolean {
  return config.smtpHost.length > 0;
}

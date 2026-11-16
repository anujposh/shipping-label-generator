import { createHash } from "node:crypto";
import type { Request, Response, NextFunction, Router } from "express";
import express from "express";
import type { z } from "zod";
import * as linksStore from "../store/links.store";
import * as shipmentsStore from "../store/shipments.store";
import * as labelsStore from "../store/labels.store";
import * as documentsStore from "../store/documents.store";
import * as auditStore from "../store/audit.store";
import { createSeamClient, type SeamCarrier } from "../carriers/seam-client";
import {
  DutyTaxEstimateSchema,
  RateRequestSchema,
  ShipmentCreateSchema,
  toSeamAddress,
} from "../core/validation";
import {
  isInternationalRoute,
  validateCustomsDetails,
  type FieldError,
} from "../carriers/customs";
import { log, errorDetails } from "../core/logger";
import type { CustomsDetails } from "../carriers/carrier-types";
import type { Link, Shipment, ShipmentStatus, VendorDetails } from "../types";
import {
  createSmtpMailer,
  isSmtpConfigured,
  resolveNotificationRecipients,
  type Mailer,
  type NotificationMail,
} from "../core/mailer";

interface VendorLocals {
  link: Link;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenFromRequest(req: Request): string | null {
  const auth = req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

function linkPublicShape(link: Link) {
  const now = new Date();
  const expired = new Date(link.expires_at) <= now;
  const remainingUses =
    link.max_uses !== null ? Math.max(0, link.max_uses - link.use_count) : null;
  let status: "active" | "expired" | "revoked" | "exhausted" = "active";
  if (link.revoked_at !== null) status = "revoked";
  else if (expired) status = "expired";
  else if (remainingUses !== null && remainingUses <= 0) status = "exhausted";
  return {
    status,
    expiresAt: link.expires_at,
    remainingUses,
    vendorDetails: (link.vendor_details as VendorDetails | null) ?? null,
  };
}

function shipmentPublicShape(shipment: Shipment) {
  return {
    id: shipment.id,
    status: shipment.status,
    shipTo: shipment.ship_to,
    packages: shipment.packages,
    selectedRate: shipment.selected_rate,
    carrier: shipment.carrier,
    serviceType: shipment.service_type,
    trackingNumber: shipment.tracking_number,
    pickup: shipment.pickup ?? null,
    createdAt: shipment.created_at,
    updatedAt: shipment.updated_at,
  };
}

/**
 * Ship-from country for international detection, derived only from the
 * vendorDetails submitted and saved on this authenticated link. Null means the
 * vendor has not submitted an origin yet; admin `ship_from` is never used.
 */
function linkCountryCode(link: Link): string | null {
  const vendorDetails = link.vendor_details as VendorDetails | null;
  if (
    !vendorDetails ||
    typeof vendorDetails.countryCode !== "string" ||
    !vendorDetails.countryCode.trim()
  ) {
    return null;
  }
  return vendorDetails.countryCode.trim().toUpperCase();
}

/**
 * Map the validated vendor identity onto the carrier-native `from` block.
 * Fields map one-to-one so no browser-supplied identity can differ from the
 * authenticated link's saved/snapshotted details.
 */
function vendorDetailsToSeamAddress(details: VendorDetails) {
  return {
    addressLine1: details.addressLine1,
    ...(details.addressLine2 ? { addressLine2: details.addressLine2 } : {}),
    city: details.city,
    state: details.state,
    zipCode: details.zipCode,
    countryCode: details.countryCode,
    contactName: details.contactName,
    contactPhone: details.contactPhone,
    companyName: details.companyName,
    contactEmail: details.contactEmail,
  };
}

/**
 * Persist the request's validated vendorDetails on the authenticated link.
 * Every rate/label/estimate request must carry its own validated identity;
 * saved details are only a UI prefill convenience, never a server fallback.
 */
async function persistVendorDetails(
  link: Link,
  details: VendorDetails,
): Promise<void> {
  await linksStore.updateLinkVendorDetails(
    link.id,
    details as unknown as Record<string, unknown>,
  );
}

/**
 * Drop browser-provided shipper identity before customs validation when the
 * authenticated link's vendorDetails are the exporter of record. This means a
 * malicious/invalid client exporter can neither fail validation nor override
 * the submitted identity.
 */
function withoutBrowserShipperIdentity(customs: unknown): unknown {
  if (
    customs === null ||
    typeof customs !== "object" ||
    Array.isArray(customs)
  ) {
    return customs;
  }
  const {
    exporter: _exporter,
    shipperTaxIds: _shipperTaxIds,
    ...rest
  } = customs as Record<string, unknown>;
  return rest;
}

/**
 * FedEx international: the submitted vendor identity is the exporter/shipper
 * of record. Override any browser-provided exporter so a caller cannot ship
 * under different shipper metadata; tax ids also feed CustomsClearanceDetail.
 */
function applyVendorIdentityToCustoms(
  customs: CustomsDetails,
  details: VendorDetails,
  carrier: string,
): CustomsDetails {
  if (carrier !== "fedex") return customs;
  const taxIds = details.taxIds ?? [];
  return {
    ...customs,
    exporter: {
      companyName: details.companyName,
      contactName: details.contactName,
      contactEmail: details.contactEmail,
      contactPhone: details.contactPhone,
      address: {
        addressLine1: details.addressLine1,
        ...(details.addressLine2 ? { addressLine2: details.addressLine2 } : {}),
        city: details.city,
        state: details.state,
        zipCode: details.zipCode,
        countryCode: details.countryCode,
      },
      taxIds,
    },
    shipperTaxIds: taxIds,
    ...(customs.originatorName
      ? {}
      : { originatorName: details.companyName || details.contactName }),
  };
}

function fieldErrorsFromDetails(
  details: FieldError[] | undefined,
): Record<string, string> | undefined {
  if (!details || details.length === 0) return undefined;
  const errors: Record<string, string> = {};
  for (const detail of details) {
    // First message wins for a given path (UI maps one message per field).
    if (!(detail.field in errors)) errors[detail.field] = detail.message;
  }
  return errors;
}

function fieldErrorsFromIssues(
  issues: Array<{ path: Array<string | number>; message: string }>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join(".");
    if (!(path in errors)) errors[path || "body"] = issue.message;
  }
  return errors;
}

function sendFieldErrors(
  res: Response,
  error: string,
  details: FieldError[],
  status = 400,
): void {
  res.status(status).json({
    error,
    code: "VALIDATION_ERROR",
    details,
    fieldErrors: fieldErrorsFromDetails(details),
  });
}

function documentsPublicShape(
  documents: Awaited<ReturnType<typeof documentsStore.listDocumentsByShipment>>,
) {
  return documents.map((document) => ({
    id: String(document.id),
    shipmentId: document.shipment_id,
    labelId: document.label_id,
    documentType: document.document_type,
    docType: document.doc_type,
    fileName: document.file_name,
    source: document.source,
    uploadStatus: document.upload_status,
    createdAt: document.created_at,
  }));
}

function documentContentType(docType: string): string {
  switch (docType.toUpperCase()) {
    case "PDF":
      return "application/pdf";
    case "TXT":
      return "text/plain";
    case "PNG":
      return "image/png";
    case "JPG":
    case "JPEG":
      return "image/jpeg";
    case "TIF":
    case "TIFF":
      return "image/tiff";
    case "DOC":
      return "application/msword";
    case "XLS":
      return "application/vnd.ms-excel";
    case "RTF":
      return "application/rtf";
    case "BMP":
      return "image/bmp";
    case "GIF":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function dispatchNotificationEmail(
  input: z.infer<typeof ShipmentCreateSchema>,
  link: Link,
  createdLabel: {
    id: number;
    tracking_number: string | null;
    carrier: string | null;
    service_type: string | null;
  },
  shipmentId: number,
  req: Request,
  mailer: Mailer,
  attachments?: Array<{ fileName: string; contentBase64: string }>,
): Promise<void> {
  try {
    if (!input.notification?.enabled) return;

    const recipients = resolveNotificationRecipients({
      recipientEmail: input.notification.recipientEmail,
      shipperEmail: input.notification.shipperEmail,
      additionalEmail: input.notification.additionalEmail,
    });
    if (recipients.length === 0) return;

    const trackingNumber = createdLabel.tracking_number ?? "";
    const carrier = createdLabel.carrier ?? input.carrier;
    const serviceType = createdLabel.service_type ?? input.serviceType;

    const shipTo = input.shipTo;
    const mail: NotificationMail = {
      to: recipients,
      carrier,
      serviceType,
      trackingNumber,
      shipToCity: shipTo.city,
      shipToState: shipTo.state,
      shipToCountry: shipTo.countryCode,
      vendorName: input.vendorDetails.contactName,
      companyName: input.vendorDetails.companyName,
      sendingCompany: link.bc_company_name ?? null,
      personalMessage: input.notification.personalMessage,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };

    const base = {
      actor_type: "vendor" as const,
      actor: `link:${link.id}`,
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: link.id,
      vendor_id: link.vendor_id,
      shipment_id: shipmentId,
    };

    // An unconfigured SMTP server is an expected deployment state, not a
    // delivery failure — record it as skipped rather than failed.
    if (!isSmtpConfigured()) {
      await auditStore.recordAuditEvent({
        ...base,
        event_type: "notification_email_skipped",
        metadata: { reason: "smtp_not_configured", recipients },
      });
      return;
    }

    try {
      await mailer.sendNotificationMail(mail);
      await auditStore.recordAuditEvent({
        ...base,
        event_type: "notification_email_sent",
        metadata: { recipients, trackingNumber },
      });
    } catch (error) {
      await auditStore.recordAuditEvent({
        ...base,
        event_type: "notification_email_failed",
        metadata: {
          recipients,
          error: String((error as { message?: unknown })?.message ?? error),
        },
      });
    }
  } catch (error) {
    // Notification email dispatch must NEVER break or delay-fail the label
    // response — swallow anything unexpected (e.g. audit write failure).
    log("warn", "notification_email_dispatch_failed", {
      requestId: req.requestId,
      error: errorDetails(error),
    });
  }
}

export function createVendorRouter(
  options: {
    seamClient?: ReturnType<typeof createSeamClient>;
    mailer?: Mailer;
  } = {},
): Router {
  const router = express.Router();
  const seamClient = options.seamClient ?? createSeamClient();
  const mailer = options.mailer ?? createSmtpMailer();

  async function resolveLink(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const rawToken = tokenFromRequest(req);
    if (!rawToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const tokenHash = hashToken(rawToken);
    const link = await linksStore.getLinkByTokenHash(tokenHash);

    if (!link) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const now = new Date();
    const expired = new Date(link.expires_at) <= now;
    const exhausted = link.max_uses !== null && link.use_count >= link.max_uses;

    if (expired) {
      await auditStore.recordAuditEvent({
        event_type: "link_expired",
        actor_type: "vendor",
        actor: `token:${tokenHash.slice(0, 16)}`,
        ip_address: req.ip ?? null,
        request_id: req.requestId,
        link_id: link.id,
        vendor_id: link.vendor_id,
      });
      res.status(410).json({ error: "link_expired" });
      return;
    }

    if (link.revoked_at !== null) {
      res.status(403).json({ error: "link_revoked" });
      return;
    }

    const readExistingLabel =
      req.method === "GET" &&
      (req.path === "/status" ||
        req.path === "/label.pdf" ||
        req.path === "/documents" ||
        req.path === "/document");
    if (exhausted && !readExistingLabel) {
      res.status(403).json({ error: "link_exhausted" });
      return;
    }

    req.link = link;
    next();
  }

  router.use(resolveLink);

  router.get("/status", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const shipments = await shipmentsStore.getShipmentsByLink(link.id);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      link: {
        ...linkPublicShape(link),
        // Lets the browser compute international state before rating.
        shipFromCountryCode: linkCountryCode(link),
      },
      shipments: shipments.map(shipmentPublicShape),
    });
  });

  router.post("/rates", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const parseResult = RateRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parseResult.error.issues.map((i) => i.message),
        fieldErrors: fieldErrorsFromIssues(parseResult.error.issues),
      });
      return;
    }

    const input = parseResult.data;
    await persistVendorDetails(link, input.vendorDetails);
    const shipFrom = vendorDetailsToSeamAddress(input.vendorDetails);

    // NOTE: rate browsing does NOT consume a link use — a use is consumed
    // only when a label is successfully created (see POST /shipment). A
    // 1-use link must survive browsing rates.

    // Services are rate-returned (never a static allowlist): the carrier
    // response below is the only source of bookable services. The response
    // shape is unchanged (`{ rates }`); international state comes from
    // GET /v1/status.link.shipFromCountryCode + the submitted destination.
    try {
      const result = await seamClient.rateQuote(
        {
          carrier: input.carrier as SeamCarrier | "all",
          from: shipFrom,
          to: toSeamAddress(input.shipTo),
          packages: input.packages,
          ...(input.serviceType && { serviceType: input.serviceType }),
          ...(input.packagingType && { packagingType: input.packagingType }),
          ...(input.shipDate && { shipDate: input.shipDate }),
        },
        req.requestId,
      );

      const rateQuotes = [...result.rates];
      const international =
        shipFrom.countryCode.toUpperCase() !==
        input.shipTo.countryCode.toUpperCase();
      if (
        !input.serviceType &&
        international &&
        ["fedex", "all"].includes(input.carrier) &&
        !rateQuotes.some(
          (rate) => rate.service === "FEDEX_INTERNATIONAL_CONNECT_PLUS",
        )
      ) {
        try {
          const ficp = await seamClient.rateQuote(
            {
              carrier: "fedex",
              from: shipFrom,
              to: toSeamAddress(input.shipTo),
              packages: input.packages,
              serviceType: "FEDEX_INTERNATIONAL_CONNECT_PLUS",
              ...(input.packagingType && {
                packagingType: input.packagingType,
              }),
            },
            req.requestId,
          );
          rateQuotes.push(
            ...ficp.rates.filter(
              (rate) => rate.service === "FEDEX_INTERNATIONAL_CONNECT_PLUS",
            ),
          );
        } catch (error) {
          // FICP is contract/route dependent; preserve other bookable rates.
          log("warn", "ficp_rate_quote_unavailable", {
            requestId: req.requestId,
            error: errorDetails(error),
          });
        }
      }

      // Stamps currently supports rate quotes only. Never present a service
      // that is guaranteed to fail when the vendor tries to create a label.
      const rates = rateQuotes.filter((rate) => rate.carrier !== "stamps");

      await auditStore.recordAuditEvent({
        event_type: "rate_retrieved",
        actor_type: "vendor",
        actor: `link:${link.id}`,
        ip_address: req.ip ?? null,
        request_id: req.requestId,
        link_id: link.id,
        vendor_id: link.vendor_id,
        metadata: { carrier: input.carrier, rateCount: rates.length },
      });

      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ rates });
    } catch (error) {
      log("error", "rate_quote_failed", {
        requestId: req.requestId,
        error: errorDetails(error),
      });
      res.status(502).json({ error: "Rate quote failed" });
    }
  });

  router.post("/shipment", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const parseResult = ShipmentCreateSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parseResult.error.issues.map((i) => i.message),
        fieldErrors: fieldErrorsFromIssues(parseResult.error.issues),
      });
      return;
    }

    const input = parseResult.data;
    await persistVendorDetails(link, input.vendorDetails);
    const existingLabels = await labelsStore.getLabelsByLink(link.id);
    if (existingLabels.some((l) => l.voided_at === null)) {
      res.status(409).json({ error: "label_already_exists" });
      return;
    }

    const shipFrom = vendorDetailsToSeamAddress(input.vendorDetails);
    const international = isInternationalRoute(
      shipFrom.countryCode,
      input.shipTo.countryCode,
    );

    let customs: CustomsDetails | undefined;
    if (input.customs !== undefined) {
      const packageWeightLb = input.packages.reduce(
        (sum, pkg) => sum + pkg.weight,
        0,
      );
      const rawCustoms =
        input.carrier === "fedex"
          ? withoutBrowserShipperIdentity(input.customs)
          : input.customs;
      const validation = validateCustomsDetails(rawCustoms, {
        fromCountryCode: shipFrom.countryCode,
        toCountryCode: input.shipTo.countryCode,
        packageWeightLb,
        carrier: input.carrier,
      });
      if (!validation.ok) {
        sendFieldErrors(res, "Invalid customs details", validation.errors);
        return;
      }
      customs = applyVendorIdentityToCustoms(
        validation.value,
        input.vendorDetails,
        input.carrier,
      );
    } else if (international && input.carrier === "fedex") {
      sendFieldErrors(res, "Customs details are required", [
        {
          field: "customs",
          message:
            "customs details are required for FedEx international shipments",
        },
      ]);
      return;
    }

    const shipment = await shipmentsStore.createShipment({
      link_id: link.id,
      vendor_id: link.vendor_id,
      status: "draft",
      // Immutable snapshot: later link edits must not rewrite history.
      ship_from: input.vendorDetails as unknown as Record<string, unknown>,
      ship_to: input.shipTo as unknown as Record<string, unknown>,
      packages: input.packages as unknown as Record<string, unknown>,
      customs: customs ? (customs as unknown as Record<string, unknown>) : null,
      pickup: (input.pickup ?? null) as unknown as Record<
        string,
        unknown
      > | null,
    });

    await auditStore.recordAuditEvent({
      event_type: "submission_created",
      actor_type: "vendor",
      actor: `link:${link.id}`,
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: link.id,
      vendor_id: link.vendor_id,
      shipment_id: shipment.id,
    });

    try {
      const result = await seamClient.createShipment(
        {
          carrier: input.carrier as SeamCarrier,
          from: shipFrom,
          to: toSeamAddress(input.shipTo),
          packages: input.packages,
          serviceType: input.serviceType,
          labelFormat: input.labelFormat,
          ...(input.packagingType && { packagingType: input.packagingType }),
          ...(input.labelSize && { labelSize: input.labelSize }),
          ...(input.reference && { reference: input.reference }),
          ...(input.shipDate && { shipDate: input.shipDate }),
          ...(input.pickup && { pickup: input.pickup }),
          ...(customs ? { customs } : {}),
        },
        req.requestId,
      );

      const label = result.labels[0];
      if (!label) {
        throw new Error("Carrier did not return a label");
      }

      const updated = await shipmentsStore.updateShipment(shipment.id, {
        status: "label_created" as ShipmentStatus,
        carrier: label.carrier,
        service_type: input.serviceType,
        tracking_number: label.trackingNumber,
        selected_rate: {
          carrier: label.carrier,
          service: input.serviceType,
          cost: label.cost,
          currency: "USD",
        } as Record<string, unknown>,
      });

      const createdLabel = await labelsStore.createLabel({
        shipment_id: shipment.id,
        label_pdf_base64: label.labelData,
        tracking_number: label.trackingNumber,
        carrier: label.carrier,
        service_type: input.serviceType,
      });

      // Persist generated + uploaded customs documents (idempotent upsert).
      const persistedDocuments = [];
      for (const document of label.documents ?? []) {
        persistedDocuments.push(
          await documentsStore.upsertDocument({
            shipment_id: shipment.id,
            label_id: createdLabel.id,
            document_type: document.documentType,
            doc_type: document.docType,
            file_name: document.fileName,
            content_base64: document.contentBase64,
            source: document.source,
            upload_status: document.uploadStatus ?? null,
            fedex_document_id: document.id ?? null,
          }),
        );
      }
      // A link use is consumed only now, when a label actually exists.
      await linksStore.incrementLinkUseCount(link.id);

      await auditStore.recordAuditEvent({
        event_type: "label_created",
        actor_type: "vendor",
        actor: `link:${link.id}`,
        ip_address: req.ip ?? null,
        request_id: req.requestId,
        link_id: link.id,
        vendor_id: link.vendor_id,
        shipment_id: shipment.id,
        metadata: {
          labelId: createdLabel.id,
          carrier: label.carrier,
          trackingNumber: label.trackingNumber,
        },
      });

      // Attach the label PDF and any trade documents to the notification email.
      const mailAttachments: Array<{ fileName: string; contentBase64: string }> = [];
      if (label.labelData) {
        mailAttachments.push({
          fileName: `label-${label.trackingNumber}.pdf`,
          contentBase64: label.labelData,
        });
      }
      for (const document of label.documents ?? []) {
        if (document.fileName && document.contentBase64) {
          mailAttachments.push({
            fileName: document.fileName,
            contentBase64: document.contentBase64,
          });
        }
      }

      await dispatchNotificationEmail(
        input,
        link,
        createdLabel,
        shipment.id,
        req,
        mailer,
        mailAttachments,
      );

      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({
        shipment: shipmentPublicShape(updated ?? shipment),
        label: {
          id: createdLabel.id,
          trackingNumber: createdLabel.tracking_number,
          carrier: createdLabel.carrier,
          serviceType: createdLabel.service_type,
          createdAt: createdLabel.created_at,
        },
        documents: documentsPublicShape(persistedDocuments),
        // Never invite a duplicate shipment retry when only the post-shipment
        // document upload failed — the label already exists.
        ...(label.documentWarnings?.length
          ? { documentWarnings: label.documentWarnings }
          : {}),
      });
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status === 400) {
        const details = (error as { details?: unknown }).details;
        const detailList = Array.isArray(details)
          ? (details as FieldError[])
          : undefined;
        await shipmentsStore.updateShipment(shipment.id, {
          status: "draft",
        });
        res.status(400).json({
          error:
            error instanceof Error && error.message
              ? error.message
              : "Invalid customs details",
          code:
            typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "CARRIER_VALIDATION_ERROR",
          ...(detailList ? { details: detailList } : {}),
          ...(detailList
            ? { fieldErrors: fieldErrorsFromDetails(detailList) }
            : {}),
        });
        return;
      }
      log("error", "create_shipment_failed", {
        requestId: req.requestId,
        error: errorDetails(error),
      });
      await shipmentsStore.updateShipment(shipment.id, {
        status: "draft",
      });
      res.status(502).json({ error: "Shipment creation failed" });
    }
  });

  router.get("/label.pdf", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const shipments = await shipmentsStore.getShipmentsByLink(link.id);
    const shipment = shipments.find((s) => s.status === "label_created");
    if (!shipment) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const label = await labelsStore.latestLabelByShipment(shipment.id);
    if (!label || label.voided_at !== null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await auditStore.recordAuditEvent({
      event_type: "label_downloaded",
      actor_type: "vendor",
      actor: `link:${link.id}`,
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: link.id,
      vendor_id: link.vendor_id,
      shipment_id: shipment.id,
      metadata: { labelId: label.id },
    });

    const buffer = Buffer.from(label.label_pdf_base64, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(buffer);
  });

  // -------------------------------------------------------------------------
  // FedEx international: customs documents + non-guaranteed duty estimate
  // -------------------------------------------------------------------------

  router.get("/documents", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const shipmentId = positiveInt(req.query.shipmentId);
    if (!shipmentId) {
      sendFieldErrors(res, "Invalid request", [
        {
          field: "shipmentId",
          message: "shipmentId must be a positive integer",
        },
      ]);
      return;
    }
    const shipment = await shipmentsStore.getShipmentById(shipmentId);
    if (!shipment || shipment.link_id !== link.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const documents = await documentsStore.listDocumentsByShipment(shipmentId);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ documents: documentsPublicShape(documents) });
  });

  router.get("/document", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const documentId = positiveInt(req.query.documentId);
    if (!documentId) {
      sendFieldErrors(res, "Invalid request", [
        {
          field: "documentId",
          message: "documentId must be a positive integer",
        },
      ]);
      return;
    }
    const document = await documentsStore.getDocumentById(documentId);
    if (!document) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const shipment = await shipmentsStore.getShipmentById(document.shipment_id);
    if (!shipment || shipment.link_id !== link.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await auditStore.recordAuditEvent({
      event_type: "label_downloaded",
      actor_type: "vendor",
      actor: `link:${link.id}`,
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: link.id,
      vendor_id: link.vendor_id,
      shipment_id: shipment.id,
      metadata: {
        kind: "customs_document",
        documentId: document.id,
        documentType: document.document_type,
      },
    });

    const buffer = Buffer.from(document.content_base64, "base64");
    res.setHeader("Content-Type", documentContentType(document.doc_type));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${document.file_name.replace(/["\\]/g, "")}"`,
    );
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(buffer);
  });

  router.post("/duty-tax-estimate", async (req: Request, res: Response) => {
    const link = req.link as Link;
    const parsed = DutyTaxEstimateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendFieldErrors(
        res,
        "Invalid request",
        parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      );
      return;
    }
    const input = parsed.data;
    await persistVendorDetails(link, input.vendorDetails);
    const shipFrom = vendorDetailsToSeamAddress(input.vendorDetails);
    const validation = validateCustomsDetails(
      withoutBrowserShipperIdentity(input.customs),
      {
        fromCountryCode: shipFrom.countryCode,
        toCountryCode: input.shipTo.countryCode,
        packageWeightLb: 0,
        carrier: "fedex",
      },
    );
    if (!validation.ok) {
      sendFieldErrors(res, "Invalid customs details", validation.errors);
      return;
    }
    const customs = applyVendorIdentityToCustoms(
      validation.value,
      input.vendorDetails,
      "fedex",
    );
    const shippingCost =
      input.shippingCost ??
      (input.selectedRate?.cost !== undefined && input.selectedRate.currency
        ? {
            amount: input.selectedRate.cost,
            currency: input.selectedRate.currency.toUpperCase(),
          }
        : undefined);

    try {
      const estimate = await seamClient.dutyTaxEstimate(
        {
          from: shipFrom,
          to: toSeamAddress(input.shipTo),
          ...(input.serviceType ? { serviceType: input.serviceType } : {}),
          ...(shippingCost ? { shippingCost } : {}),
          customs,
        },
        req.requestId,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(estimate);
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status === 400) {
        const details = (error as { details?: unknown }).details;
        const detailList = Array.isArray(details)
          ? (details as FieldError[])
          : undefined;
        res.status(400).json({
          error:
            error instanceof Error && error.message
              ? error.message
              : "Duty & tax estimate rejected",
          code: "CARRIER_VALIDATION_ERROR",
          ...(detailList ? { details: detailList } : {}),
          ...(detailList
            ? { fieldErrors: fieldErrorsFromDetails(detailList) }
            : {}),
        });
        return;
      }
      log("error", "duty_tax_estimate_failed", {
        requestId: req.requestId,
        error: errorDetails(error),
      });
      res.status(502).json({ error: "Duty & tax estimate failed" });
    }
  });

  return router;
}

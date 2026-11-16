import type { Request, Response, NextFunction, Router } from "express";
import express from "express";
import { z } from "zod";
import * as vendorsStore from "../store/vendors.store";
import * as linksStore from "../store/links.store";
import * as shipmentsStore from "../store/shipments.store";
import * as labelsStore from "../store/labels.store";
import * as auditStore from "../store/audit.store";
import * as adminUsersStore from "../store/admin-users.store";
import * as bcCompaniesService from "../services/bc-companies";
import { signAdminToken, verifyAdminToken } from "../core/jwt";
import {
  verifyPassword,
  hashPassword,
  DUMMY_PASSWORD_HASH,
} from "../core/password";
import {
  VendorCreateSchema,
  VendorUpdateSchema,
  LinkCreateSchema,
} from "../core/validation";
import { validateShipFrom } from "../core/ship-from";
import { log, errorDetails } from "../core/logger";
import type { AdminUser, ShipFromAddress } from "../types";
import { tokenRateLimitKey } from "../core/rate-limit";
import * as carrierService from "../carriers/carrier.service";
import type { Carrier } from "../carriers/carrier-types";

interface AdminAuthRequest extends Request {
  admin?: { sub: number; email: string; role: "admin" };
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

function isCarrier(value: unknown): value is Carrier {
  return (
    value === "fedex" ||
    value === "ups" ||
    value === "usps" ||
    value === "stamps"
  );
}

function adminAuthMiddleware(
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const auth = req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.admin = verifyAdminToken(auth.slice(7).trim());
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

export function createAdminRouter(
  options: {
    loginRateLimit?: (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => Promise<void>;
    /** Carrier void seam — defaults to the real carrier facade. Injected in tests. */
    voidShipment?: typeof carrierService.voidShipment;
  } = {},
): Router {
  const router = express.Router();
  const voidShipment = options.voidShipment ?? carrierService.voidShipment;

  router.post("/auth/login", async (req: Request, res: Response) => {
    const parseResult = LoginSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const { email, password } = parseResult.data;
    const user = await adminUsersStore.getAdminUserByEmail(email);

    if (!user || !user.is_active) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      await auditStore.recordAuditEvent({
        event_type: "admin_login_failure",
        actor_type: "admin",
        actor: email,
        ip_address: req.ip ?? null,
        request_id: req.requestId,
        metadata: { reason: user ? "inactive" : "unknown_user" },
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await auditStore.recordAuditEvent({
        event_type: "admin_login_failure",
        actor_type: "admin",
        actor: email,
        ip_address: req.ip ?? null,
        request_id: req.requestId,
        metadata: { userId: user.id },
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    await auditStore.recordAuditEvent({
      event_type: "admin_login_success",
      actor_type: "admin",
      actor: email,
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      metadata: { userId: user.id },
    });

    const token = signAdminToken({
      sub: user.id,
      email: user.email,
      role: "admin",
    });

    res.status(200).json({ token, user: { id: user.id, email: user.email } });
  });

  router.use(adminAuthMiddleware);

  router.get("/vendors", async (_req: Request, res: Response) => {
    const vendors = await vendorsStore.listVendors();
    res.status(200).json({ vendors });
  });

  router.get("/companies", async (_req: Request, res: Response) => {
    if (!bcCompaniesService.bcCompaniesConfigured()) {
      res.status(200).json({ companies: [], configured: false });
      return;
    }
    try {
      const companies = await bcCompaniesService.fetchBcCompanies();
      res.status(200).json({ companies, configured: true });
    } catch {
      res.status(502).json({ error: "Business Central companies unavailable" });
    }
  });

  router.post("/vendors", async (req: Request, res: Response) => {
    const parseResult = VendorCreateSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }
    const vendor = await vendorsStore.createVendor({
      name: parseResult.data.name,
      contact_email: parseResult.data.contactEmail ?? null,
      notes: parseResult.data.notes ?? null,
    });
    res.status(201).json({ vendor });
  });

  router.get("/vendors/:id", async (req: Request, res: Response) => {
    const parseResult = IdParamSchema.safeParse(req.params);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const vendor = await vendorsStore.getVendorById(parseResult.data.id);
    if (!vendor) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json({ vendor });
  });

  router.patch("/vendors/:id", async (req: Request, res: Response) => {
    const paramResult = IdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const bodyResult = VendorUpdateSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        error: "Invalid request",
        details: bodyResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const existing = await vendorsStore.getVendorById(paramResult.data.id);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (req.body.archived === true) {
      await vendorsStore.archiveVendor(paramResult.data.id);
    } else {
      await vendorsStore.updateVendor(paramResult.data.id, {
        ...(bodyResult.data.name !== undefined && {
          name: bodyResult.data.name,
        }),
        ...(bodyResult.data.contactEmail !== undefined && {
          contact_email: bodyResult.data.contactEmail,
        }),
        ...(bodyResult.data.notes !== undefined && {
          notes: bodyResult.data.notes,
        }),
      });
    }

    const vendor = await vendorsStore.getVendorById(paramResult.data.id);
    res.status(200).json({ vendor });
  });

  router.get("/links", async (req: Request, res: Response) => {
    const vendorId = req.query.vendorId
      ? Number(req.query.vendorId)
      : undefined;
    if (
      vendorId !== undefined &&
      (!Number.isInteger(vendorId) || vendorId <= 0)
    ) {
      res.status(400).json({ error: "Invalid vendorId" });
      return;
    }

    let links;
    if (vendorId !== undefined) {
      links = await linksStore.listLinksByVendor(vendorId);
    } else {
      links = await linksStore.listAllLinks();
    }

    res.status(200).json({
      links: links.map((link) => ({
        id: link.id,
        vendorId: link.vendor_id,
        bcCompanyId: link.bc_company_id,
        bcCompanyName: link.bc_company_name,
        expiresAt: link.expires_at,
        revokedAt: link.revoked_at,
        maxUses: link.max_uses,
        useCount: link.use_count,
        createdBy: link.created_by,
        createdAt: link.created_at,
      })),
    });
  });

  router.post("/links", async (req: Request, res: Response) => {
    const parseResult = LinkCreateSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const vendorId = parseResult.data.vendorId ?? null;
    const bcCompanyId = parseResult.data.bcCompanyId ?? null;
    const bcCompanyName = parseResult.data.bcCompanyName ?? null;

    // Vendor lookup/validation only applies when the link is assigned.
    if (vendorId !== null) {
      const vendor = await vendorsStore.getVendorById(vendorId);
      if (!vendor || vendor.archived_at !== null) {
        res.status(404).json({ error: "Vendor not found" });
        return;
      }
    }

    // When a Business Central company is supplied and BC is configured,
    // verify the id exists in the live BC companies list. When BC is
    // unconfigured (dev mode), accept and store as-is. A BC outage must
    // never take link creation down — surface a clean 502 instead.
    if (bcCompanyId !== null && bcCompaniesService.bcCompaniesConfigured()) {
      let bcCompany = null;
      try {
        bcCompany = await bcCompaniesService.findBcCompanyById(bcCompanyId);
      } catch (error) {
        log("error", "bc_company_lookup_failed", {
          requestId: req.requestId,
          error: errorDetails(error),
        });
        res
          .status(502)
          .json({ error: "Business Central companies unavailable" });
        return;
      }
      if (!bcCompany) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
    }

    const shipFrom = parseResult.data.shipFrom;

    // Allowlist enforcement only applies when a ship-from was supplied.
    // Normalize absent legacy fields to empty strings: with no allowlist
    // configured validateShipFrom accepts partial data, while a configured
    // allowlist rejects partial (or otherwise nonmatching) data.
    if (shipFrom) {
      const provided = shipFrom;
      const shipFromForValidation: ShipFromAddress = {
        name: provided.name ?? "",
        street: provided.street ?? "",
        city: provided.city ?? "",
        state: provided.state ?? "",
        zip: provided.zip ?? "",
        country: provided.country ?? "US",
      };
      const shipFromValidation = validateShipFrom(shipFromForValidation);
      if (!shipFromValidation.ok) {
        res.status(400).json({ error: shipFromValidation.error });
        return;
      }
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + parseResult.data.expiresInDays);

    const { link, token } = await linksStore.createLink({
      vendor_id: vendorId,
      bc_company_id: bcCompanyId,
      bc_company_name: bcCompanyName,
      expires_at: expiresAt.toISOString(),
      max_uses: parseResult.data.maxUses ?? null,
      created_by: (req as AdminAuthRequest).admin?.email ?? "system",
      ship_from: Object.fromEntries(
        Object.entries(parseResult.data.shipFrom ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    });

    await auditStore.recordAuditEvent({
      event_type: "link_created",
      actor_type: "admin",
      actor: (req as AdminAuthRequest).admin?.email ?? "system",
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: link.id,
      vendor_id: link.vendor_id,
      metadata: {
        maxUses: link.max_uses,
        expiresAt: link.expires_at,
        bcCompanyId,
      },
    });

    res.status(201).json({
      id: link.id,
      token,
      expiresAt: link.expires_at,
    });
  });

  router.post("/links/:id/revoke", async (req: Request, res: Response) => {
    const paramResult = IdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const link = await linksStore.getLinkById(paramResult.data.id);
    if (!link) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const revoked = await linksStore.revokeLink(paramResult.data.id);
    if (!revoked) {
      res.status(409).json({ error: "Link already revoked" });
      return;
    }

    await auditStore.recordAuditEvent({
      event_type: "link_revoked",
      actor_type: "admin",
      actor: (req as AdminAuthRequest).admin?.email ?? "system",
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: revoked.id,
      vendor_id: revoked.vendor_id,
    });

    res.status(200).json({ link: revoked });
  });

  router.get("/shipments", async (req: Request, res: Response) => {
    const vendorId = req.query.vendorId
      ? Number(req.query.vendorId)
      : undefined;
    const linkId = req.query.linkId ? Number(req.query.linkId) : undefined;
    const status = req.query.status as string | undefined;

    if (
      (vendorId !== undefined &&
        (!Number.isInteger(vendorId) || vendorId <= 0)) ||
      (linkId !== undefined && (!Number.isInteger(linkId) || linkId <= 0))
    ) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }

    let shipments: Awaited<
      ReturnType<typeof shipmentsStore.listShipmentsByVendor>
    > = [];
    if (vendorId !== undefined) {
      shipments = await shipmentsStore.listShipmentsByVendor(vendorId);
    } else if (linkId !== undefined) {
      shipments = await shipmentsStore.getShipmentsByLink(linkId);
    } else {
      shipments = await shipmentsStore.listAllShipments();
    }

    if (status) {
      shipments = shipments.filter((s) => s.status === status);
    }

    res.status(200).json({
      shipments: shipments.map((shipment) => ({
        ...shipmentPublicShape(shipment),
        labelMetadata: {
          carrier: shipment.carrier,
          serviceType: shipment.service_type,
          trackingNumber: shipment.tracking_number,
        },
      })),
    });
  });

  router.get("/shipments/:id", async (req: Request, res: Response) => {
    const paramResult = IdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const shipment = await shipmentsStore.getShipmentById(paramResult.data.id);
    if (!shipment) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const labels = await labelsStore.getLabelsByShipment(shipment.id);
    res.status(200).json({
      shipment: shipmentPublicShape(shipment),
      labels: labels.map((label) => ({
        id: label.id,
        carrier: label.carrier,
        serviceType: label.service_type,
        trackingNumber: label.tracking_number,
        voidedAt: label.voided_at,
        createdAt: label.created_at,
      })),
    });
  });

  router.get(
    "/shipments/:id/label.pdf",
    async (req: Request, res: Response) => {
      const paramResult = IdParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }

      const shipment = await shipmentsStore.getShipmentById(
        paramResult.data.id,
      );
      if (!shipment || shipment.status !== "label_created") {
        res.status(404).json({ error: "Not found" });
        return;
      }

      const label = await labelsStore.latestLabelByShipment(shipment.id);
      if (!label || label.voided_at !== null) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      const buffer = Buffer.from(label.label_pdf_base64, "base64");
      const disposition = req.query.inline === "1" ? "inline" : "attachment";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="shipment-${shipment.id}.pdf"`,
      );
      res.status(200).send(buffer);
    },
  );

  router.post("/shipments/:id/void", async (req: Request, res: Response) => {
    const paramResult = IdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const shipment = await shipmentsStore.getShipmentById(paramResult.data.id);
    if (!shipment) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Already voided / not label_created is a conflict without carrier I/O.
    if (shipment.status !== "label_created") {
      res.status(409).json({ error: "Shipment is not voidable" });
      return;
    }

    const label = await labelsStore.latestLabelByShipment(shipment.id);
    if (!label || label.voided_at !== null) {
      res.status(409).json({ error: "Shipment is not voidable" });
      return;
    }

    const carrier = label.carrier ?? shipment.carrier;
    const trackingNumber = label.tracking_number ?? shipment.tracking_number;
    if (!carrier || !isCarrier(carrier) || !trackingNumber) {
      res.status(409).json({ error: "Shipment is not voidable" });
      return;
    }

    try {
      await voidShipment(carrier, trackingNumber);
    } catch (error) {
      log("error", "label_void_failed", {
        requestId: req.requestId,
        shipmentId: shipment.id,
        carrier,
        error: errorDetails(error),
      });
      res.status(502).json({ error: "Label void failed" });
      return;
    }

    const adminEmail = (req as AdminAuthRequest).admin?.email ?? "system";
    const voidedLabel = await labelsStore.markLabelVoided(label.id, adminEmail);
    const updated = await shipmentsStore.updateShipment(shipment.id, {
      status: "voided",
    });
    const voidedAt = voidedLabel?.voided_at ?? null;
    const shipmentAfter = updated ?? shipment;

    await auditStore.recordAuditEvent({
      event_type: "label_voided",
      actor_type: "admin",
      actor: adminEmail,
      ip_address: req.ip ?? null,
      request_id: req.requestId,
      link_id: shipment.link_id,
      vendor_id: shipment.vendor_id,
      shipment_id: shipment.id,
      metadata: { labelId: label.id, carrier, trackingNumber },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      shipment: {
        ...shipmentPublicShape(shipmentAfter),
        voidedAt,
      },
      label: {
        id: label.id,
        carrier,
        trackingNumber,
        voidedAt,
      },
    });
  });

  router.get("/audit", async (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
      res.status(400).json({ error: "Invalid limit" });
      return;
    }
    if (!Number.isInteger(offset) || offset < 0) {
      res.status(400).json({ error: "Invalid offset" });
      return;
    }

    const events = await auditStore.listAuditEvents({ limit, offset });
    res.status(200).json({ events });
  });

  router.get("/warehouses", async (_req: Request, res: Response) => {
    const raw = process.env.SLG_ALLOWED_SHIP_FROMS;
    let warehouses: unknown[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) warehouses = parsed;
      } catch {
        warehouses = [];
      }
    }
    res.status(200).json({ warehouses });
  });

  return router;
}

function shipmentPublicShape(
  shipment: Awaited<ReturnType<typeof shipmentsStore.getShipmentById>>,
) {
  if (!shipment) {
    throw new Error("shipment is null");
  }
  return {
    id: shipment.id,
    linkId: shipment.link_id,
    vendorId: shipment.vendor_id,
    status: shipment.status,
    shipFrom: shipment.ship_from,
    shipTo: shipment.ship_to,
    packages: shipment.packages,
    selectedRate: shipment.selected_rate,
    carrier: shipment.carrier,
    serviceType: shipment.service_type,
    trackingNumber: shipment.tracking_number,
    createdAt: shipment.created_at,
    updatedAt: shipment.updated_at,
  };
}

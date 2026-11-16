import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { log } from "./logger";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const supplied = req.header("x-request-id");
  req.requestId =
    supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  res.setHeader("X-Request-ID", req.requestId);

  const started = process.hrtime.bigint();
  res.once("finish", () => {
    const statusCode = res.statusCode;
    log(
      statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
      "http_request",
      {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        actorType: "anonymous",
      },
    );
  });
  next();
}

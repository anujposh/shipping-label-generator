import { createHash } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import Redis from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { config } from "../config";
import { errorDetails, log } from "./logger";

const redis = new Redis({
  host: config.redisHost,
  port: config.redisPort,
  password: config.redisPassword || undefined,
  connectTimeout: 1_000,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

let lastRedisErrorLog = 0;
redis.on("error", (error) => {
  if (Date.now() - lastRedisErrorLog > 60_000) {
    lastRedisErrorLog = Date.now();
    log("error", "rate_limit_redis_error", errorDetails(error));
  }
});

interface RateLimitOptions {
  name: string;
  points: number;
  durationSeconds: number;
  blockSeconds?: number;
  key?: (req: Request) => string;
  rewardSuccessful?: boolean;
}

export function tokenRateLimitKey(req: Request): string {
  const auth = req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "unknown";
  return `${req.ip ?? "unknown"}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

export function createRateLimit(options: RateLimitOptions) {
  const keyPrefix =
    process.env.NODE_ENV === "test"
      ? `test_${process.pid}_${options.name}`
      : options.name;

  const fallbackLimiter = new RateLimiterMemory({
    keyPrefix,
    points: options.points,
    duration: options.durationSeconds,
    blockDuration: options.blockSeconds ?? 0,
  });

  const redisLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix,
    points: options.points,
    duration: options.durationSeconds,
    blockDuration: options.blockSeconds ?? 0,
    insuranceLimiter: fallbackLimiter,
  });

  const limiter =
    process.env.NODE_ENV === "test" ? fallbackLimiter : redisLimiter;

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const key =
      options.key?.(req) ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
    try {
      const result = await limiter.consume(key);
      res.setHeader("RateLimit-Limit", String(options.points));
      res.setHeader(
        "RateLimit-Remaining",
        String(Math.max(0, result.remainingPoints)),
      );
      res.setHeader(
        "RateLimit-Reset",
        String(Math.ceil((Date.now() + result.msBeforeNext) / 1000)),
      );
      if (options.rewardSuccessful) {
        res.once("finish", () => {
          if (res.statusCode < 400) {
            void limiter.reward(key).catch(() => undefined);
          }
        });
      }
      next();
    } catch (error) {
      const retryAfter = Math.max(
        1,
        Math.ceil((error as RateLimiterRes).msBeforeNext / 1000) || 1,
      );
      log("warn", "rate_limit_exceeded", {
        limiter: options.name,
        key: key.slice(0, 32),
        requestId: req.requestId,
      });
      res.setHeader("Retry-After", String(retryAfter));
      res
        .status(429)
        .json({ error: "Too many requests. Please try again later." });
    }
  };
}

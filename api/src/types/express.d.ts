import type { Link } from "./index";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      link?: Link;
    }
  }
}

export {};

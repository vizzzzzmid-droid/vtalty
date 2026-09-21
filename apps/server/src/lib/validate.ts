import { ZodError, type ZodType } from "zod";
import { HttpError } from "./errors.js";

/** Parse unknown input with a zod schema; throw 400 VALIDATION_ERROR. */
export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      throw new HttpError(400, "VALIDATION_ERROR", detail);
    }
    throw err;
  }
}

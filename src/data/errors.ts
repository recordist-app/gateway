export class RecordistError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordistError";
    this.code = code;
  }
}

/** Thrown when an action needs the desktop app but it is not reachable. */
export class AppNotRunningError extends RecordistError {
  constructor(action?: string) {
    super(
      "app_not_running",
      `Recordist app is not running${action ? ` — cannot ${action}` : ""}. ` +
        "Start the Recordist desktop app and try again. (Reads still work from the local database.)",
    );
    this.name = "AppNotRunningError";
  }
}

/** Thrown when neither the API nor the database is available. */
export class NoDataSourceError extends RecordistError {
  constructor(detail: string) {
    super(
      "no_data_source",
      `No Recordist data source available: ${detail}. ` +
        "Install and run the Recordist desktop app, or set RECORDIST_DATA_DIR / RECORDIST_API_URL.",
    );
    this.name = "NoDataSourceError";
  }
}

export class NotFoundError extends RecordistError {
  constructor(what: string, id: string) {
    super("not_found", `${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** Error surfaced by the local REST API (`{error:{code,message}}`). */
export class ApiError extends RecordistError {
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(code, message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

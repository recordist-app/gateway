export type { RecordistData, DataMode } from "./types.js";
export { ApiClient, type ApiClientOptions, type FetchLike } from "./api.js";
export { SqliteReader, toFtsQuery, likeSnippet, rowToSummary } from "./sqlite.js";
export { AutoData, createRecordistData, type AutoDataOptions } from "./auto.js";
export {
  RecordistError,
  AppNotRunningError,
  NoDataSourceError,
  NotFoundError,
  ApiError,
  errorMessage,
} from "./errors.js";

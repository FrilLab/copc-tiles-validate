export type Severity = "ERROR" | "WARNING";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

export interface ValidationOptions {
  maxTiles?: number;
  maxDepth?: number;
  maxJsonBytes?: number;
  maxFileBytes?: number;
  maxResources?: number;
  maxIssues?: number;
  checkContent?: boolean;
  /** Fail the overall policy result when any content or structural area is unverified. */
  failOnUnverified?: boolean;
}

export type CoverageEntryStatus = "checked" | "partial" | "skipped";

export interface ValidationCoverageEntry {
  status: CoverageEntryStatus;
  kind: string;
  count: number;
  reason?: string;
  /** Up to five representative paths for this coverage entry. */
  paths: string[];
}

export interface ValidationCoverage {
  /** complete has no partial or skipped checks; incomplete means some check was skipped. */
  status: "complete" | "partial" | "incomplete";
  checked: ValidationCoverageEntry[];
  partial: ValidationCoverageEntry[];
  skipped: ValidationCoverageEntry[];
}

export interface ValidationStatistics {
  tilesets: number;
  tiles: number;
  resources: number;
  glbs: number;
  subtrees: number;
}

export interface ValidationReport {
  /** True means no errors detected within the supported structural checks, not full conformance. */
  valid: boolean;
  /** Overall result under the requested options; equals valid unless failOnUnverified is enabled. */
  passed: boolean;
  conformance: "partial";
  issues: ValidationIssue[];
  stats: ValidationStatistics;
  coverage: ValidationCoverage;
}

/** Validate a local tileset.json or a directory containing it. No network requests are made. */
export declare function validateTileset(
  inputPath: string,
  options?: ValidationOptions
): Promise<ValidationReport>;

export declare const validationLimits: Readonly<Required<ValidationOptions>>;

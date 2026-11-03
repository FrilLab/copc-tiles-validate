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
  conformance: "partial";
  issues: ValidationIssue[];
  stats: ValidationStatistics;
}

/** Validate a local tileset.json or a directory containing it. No network requests are made. */
export declare function validateTileset(
  inputPath: string,
  options?: ValidationOptions
): Promise<ValidationReport>;

export declare const validationLimits: Readonly<Required<ValidationOptions>>;

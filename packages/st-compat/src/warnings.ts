export interface ImportDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export function diagnostic(code: string, message: string, path?: string): ImportDiagnostic {
  return { code, message, ...(path === undefined ? {} : { path }) };
}

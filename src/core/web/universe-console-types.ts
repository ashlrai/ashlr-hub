export interface UniverseConsoleServerOptions { root: string; port?: number }
export interface UniverseConsoleServerHandle {
  url: string;
  consoleUrl: string;
  port: number;
  readToken: string;
  close(): Promise<void>;
}

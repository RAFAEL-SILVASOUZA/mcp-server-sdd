// Type declarations for sql.js runtime types
declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | SharedArrayBuffer | undefined) => Database;
  }

  export interface Database {
    exec(sql: string): { columns: string[]; values: any[][] }[];
    prepare<T>(sql: string, bindings?: any[]): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(bindings?: any[]): boolean;
    step(): boolean;
    get(): any[];
    getColumn(index: number): any;
    getAsObject(params?: Record<string, any>): Record<string, any>;
    free(): void;
  }

  export function initSqlJs(options?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
